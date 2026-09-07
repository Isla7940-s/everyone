import type { CardAction, IncomingMessage, Person } from '@everyone/shared';
import { bus } from '../bus.js';
import { config } from '../config.js';
import { adapter } from '../context.js';
import { chatJson } from '../llm/client.js';
import * as memory from '../memory/index.js';
import { prompt } from '../prompts.js';
import { assists, chatLog, pendingCards, persons } from '../store/repo.js';
import { fmtStamp, timeVars } from '../time.js';

/**
 * 帮你答（S9/FR-J3~J5）：
 * 判定应答人 → 全域检索其记忆 → 有把握则署名代答（必带出处 + 更正/撤回按钮）；
 * 没把握 → 不发群，私信本人附建议答案。
 * 返回值：是否已在群内代答（false 时上游可对 @机器人 的提问做兜底回复）。
 */
export async function handleQuestion(msg: IncomingMessage, sender: Person | null, senderName: string): Promise<boolean> {
  // 判定应答人：用意见路由同款思路（画像 + 任务归属）
  const profiles = persons.all().map((p) => {
    const mem = memory.readPersonMemory(p.id);
    const domainLine = mem.split('\n').find((l) => l.includes('负责域')) ?? '';
    return `${p.id} | ${p.name} | ${domainLine.replace(/^-\s*/, '') || ''}`;
  }).join('\n');

  const route = await chatJson<{ target_person_id: string; confidence: number; summary: string }>(
    '你是提问路由器：判断这个问题最该由哪个成员回答。只输出 JSON：{"target_person_id":"xxx","confidence":0.8,"summary":"问题摘要"}',
    `问题（${senderName} 提问）："""${msg.text}"""\n\n成员与负责域：\n${profiles}`,
    { fast: true, temperature: 0 },
  );
  const answerer = persons.byId(route.target_person_id);
  if (!answerer || (route.confidence ?? 0) < 0.6) {
    bus.activity('assist', '提问无明确应答人，跳过', msg.text.slice(0, 60));
    return false;
  }
  if (answerer.id === sender?.id) return false; // 自问自答没意义
  if (!answerer.answerEnabled) {
    bus.activity('assist', `帮你答已被 ${answerer.name} 关闭，跳过`);
    return false;
  }

  const evidence: Array<{ content: string; source: string }> = [];
  // 1) 四层记忆召回（命中带原始时间，需求 1：证据新旧可辨；解析不出时间的如实标注）
  const hits = await memory.recall(answerer.id, msg.text, 5);
  evidence.push(...hits.map((h) => ({ content: `${h.ts ? `[${fmtStamp(h.ts)}]` : '[时间不详]'} ${h.content}`, source: h.source })));
  // 2) memory.md 相关段落（中文关键词窗口匹配——中文问题没有空格，不能按空格分词）
  const mem = memory.readPersonMemory(answerer.id);
  const kw = memory.extractKeywords(msg.text);
  for (const line of mem.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('-')) continue;
    if (kw.some((k) => trimmed.includes(k))) {
      evidence.push({ content: trimmed, source: `${answerer.name} 的 memory.md` });
      if (evidence.length >= 8) break;
    }
  }
  // 3) 仓库检索：问「逻辑/实现/规则/口径」这类问题时，分身自主翻本人 repo 找答案
  //   （场景：A 问「王哥，咱们周报的报警触发逻辑是怎么样的」→ 王哥的分身读自己仓库里的代码来答）
  evidence.push(...await searchRepoEvidence(answerer, msg.text));

  if (!evidence.length) {
    await notifyAnswererInstead(answerer, msg, senderName, '（记忆和仓库里都没有可引用的依据）');
    return false;
  }

  const check = await chatJson<{ can_answer: boolean; answer: string; source: string; suggested_answer: string }>(
    '你是代答把握评估器，只输出 JSON。',
    prompt('answer_check', {
      ...timeVars(),
      answerer_name: answerer.name,
      asker: senderName,
      question: msg.text,
      evidence: evidence.map((e) => `- ${e.content}（出处：${e.source}）`).join('\n'),
    }),
    { temperature: 0 },
  );

  if (!check.can_answer || !check.answer) {
    await notifyAnswererInstead(answerer, msg, senderName, check.suggested_answer || '');
    return false;
  }

  // 日常跟踪（新需求 4，2026-08-29 需求⑤修正）：本人正在会中 → 先正常回答，空两行再告知在开会与预计结束时间
  const { getBusyStatus, fmtBusyUntil } = await import('../lark/freebusy.js');
  const busy = await getBusyStatus(answerer).catch(() => null);
  const busyNote = busy?.busy && busy.until
    ? `\n\n📅 ${answerer.name} 现在正在开会，预计 ${fmtBusyUntil(busy.until)} 结束`
    : '';

  // 代答走普通消息（2026-08-29 需求⑤）：直接回复提问，不用卡片、不带按钮与「分身」身份标识；
  // 治理通道保留——本人私聊回「撤回」仍可撤（pendingCards 记录 answerMsgId 供文字指令定位）
  const assist = assists.create({
    type: 'answer', personId: answerer.id,
    content: `Q：${msg.text.slice(0, 100)} → A：${check.answer}`,
    srcMsgLink: msg.msgLink ?? null, evidenceLink: check.source, status: 'answered',
  });
  const { withSpeaker, avatarSpeaker } = await import('../lark/speaker.js');
  const sent = await withSpeaker(avatarSpeaker(answerer.name), () =>
    adapter().replyText(msg.msgId, `${check.answer}${busyNote}`, `answer-${assist.id}`));
  pendingCards.save(sent.msgId, 'answer', { assistId: assist.id, answerMsgId: sent.msgId });
  bus.changed('assist');
  bus.activity('assist', `${answerer.name} 的分身代答（普通消息）`, `${check.answer.slice(0, 60)} · 出处：${check.source}`);
  return true;
}

/**
 * 分身自主翻仓库：LLM 从 repo 文件清单里挑可能藏着答案的文件（中文问题 ↔ 英文文件名靠语义对应），
 * 读出内容节选作为代答证据（出处 = repo 文件路径）。repo 为空或没有相关文件时静默返回空。
 */
async function searchRepoEvidence(answerer: Person, question: string): Promise<Array<{ content: string; source: string }>> {
  try {
    const { listWorkspaceFiles } = await import('../executor/workspace.js');
    const files = listWorkspaceFiles(answerer.id)
      .filter((f) => !f.dir && f.path.startsWith('repo/') && f.size < 200_000)
      .slice(0, 80);
    if (!files.length) return [];
    const pick = await chatJson<{ files: string[] }>(
      '你是代码检索助手。根据问题，从文件清单里挑出最可能包含答案的文件（最多 2 个）；问题与仓库内容无关时返回空数组。只输出 JSON：{"files": ["repo/xxx"]}',
      `问题："""${question}"""\n\n${answerer.name} 的仓库文件清单：\n${files.map((f) => `- ${f.path}（${f.size}B）`).join('\n')}`,
      { fast: true, temperature: 0 },
    );
    const chosen = (pick.files ?? []).filter((p) => files.some((f) => f.path === p)).slice(0, 2);
    if (!chosen.length) {
      bus.activity('assist', `${answerer.name} 的分身翻了仓库，没有相关文件`, `清单 ${files.length} 个文件`);
      return [];
    }
    bus.activity('assist', `${answerer.name} 的分身在自己的仓库里找答案`, chosen.join('、'));
    const fs = await import('node:fs');
    const path = await import('node:path');
    const out: Array<{ content: string; source: string }> = [];
    for (const rel of chosen) {
      try {
        const abs = path.join(config.workspacesDir, answerer.id, rel);
        const text = fs.readFileSync(abs, 'utf-8').slice(0, 2600);
        out.push({ content: `${rel} 内容节选：\n${text}`, source: rel });
      } catch { /* 单文件读失败跳过 */ }
    }
    return out;
  } catch (e) {
    // 检索失败不阻断代答主链路（还有记忆证据），但要看得见失败原因
    bus.activity('system', '仓库检索失败（代答继续走记忆证据）', String(e).slice(0, 150));
    return [];
  }
}

/** 没把握 → 私信提醒 + 建议答案（FR-J4） */
async function notifyAnswererInstead(answerer: Person, msg: IncomingMessage, senderName: string, suggested: string): Promise<void> {
  const { dmTargetOf } = await import('../lark/dm.js');
  const to = dmTargetOf(answerer);
  if (!to) {
    assists.create({
      type: 'answer', personId: answerer.id,
      content: `Q：${msg.text.slice(0, 100)}（虚拟成员无法私信，建议答案入后台：${suggested.slice(0, 80)}）`,
      srcMsgLink: msg.msgLink ?? null, status: 'skipped',
    });
    bus.changed('assist');
    bus.activity('assist', `没把握代答且 ${answerer.name} 为虚拟成员，仅入后台`, msg.text.slice(0, 60));
    return;
  }
  const lines = [
    `💬 群里有个问题可能该你答（${senderName} 问）：`,
    `> ${msg.text.slice(0, 150)}`,
    msg.msgLink ? `原文：${msg.msgLink}` : '',
    suggested ? `\n分身的建议答案（仅供参考）：${suggested}` : '',
  ].filter(Boolean);
  await adapter().sendText(to, lines.join('\n'), `qnotify-${msg.msgId}`);
  assists.create({
    type: 'answer', personId: answerer.id,
    content: `Q：${msg.text.slice(0, 100)}（没把握，已私信提醒）`,
    srcMsgLink: msg.msgLink ?? null, status: 'skipped',
  });
  bus.changed('assist');
  bus.activity('assist', `没把握代答，已私信 ${answerer.name} 提醒`, msg.text.slice(0, 60));
}

/** 更正 / 撤回（FR-J5，仅本人可点） */
export async function handleAnswerCardAction(action: CardAction): Promise<boolean> {
  const assistId = action.value.assist_id;
  if (!assistId) return false;
  const assist = assists.byId(assistId);
  if (!assist) return false;
  const operator = persons.byOpenId(action.operatorOpenId) ?? persons.byId(action.operatorOpenId);
  const person = persons.byId(assist.personId);
  // 权限：本人可操作；被代答人是虚拟成员（无飞书账号、永远无法自己点）时，任何真实成员都可治理
  const answererIsVirtual = !person?.feishuOpenId;
  const operatorIsReal = !!operator?.feishuOpenId || operator?.id === assist.personId;
  const allowed = operator?.id === assist.personId || (answererIsVirtual && operatorIsReal);
  if (!allowed) {
    const { cardFeedback } = await import('../lark/feedback.js');
    await cardFeedback(action, `更正/撤回只有 ${person?.name ?? '本人'} 能操作`);
    return true;
  }

  switch (action.actionId) {
    case 'answer_retract': {
      if (action.msgId) await adapter().recall(action.msgId).catch(() => {});
      assists.setStatus(assistId, 'retracted');
      bus.changed('assist');
      memory.appendPersonMemory(assist.personId, [`代答被本人撤回：${assist.content.slice(0, 60)}`], '帮你答负反馈');
      bus.activity('assist', `${person?.name} 撤回了分身代答`);
      return true;
    }
    case 'answer_correct': {
      assists.setStatus(assistId, 'corrected');
      bus.changed('assist');
      const { dmTargetOf } = await import('../lark/dm.js');
      const to = dmTargetOf(person);
      if (to) await adapter().sendText(to, `请直接在群里回复正确答案；分身的这次代答已标记待更正：\n> ${assist.content.slice(0, 150)}`, `correct-${assistId}`).catch(() => {});
      bus.activity('assist', `${person?.name} 标记代答待更正`);
      return true;
    }
  }
  return false;
}

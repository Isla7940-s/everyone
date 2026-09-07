import type { IncomingMessage, IntentType, Person } from '@everyone/shared';
import { bus } from '../bus.js';
import { config } from '../config.js';
import { chatJson } from '../llm/client.js';
import * as memory from '../memory/index.js';
import { prompt } from '../prompts.js';
import { proposeTask, applyTextEdit, hasPendingEdit, sendQuadrantImage, sendScheduleImage } from '../ledger/tasks.js';
import { chatLog, chats, persons, seen, tasks } from '../store/repo.js';
import { adapter } from '../context.js';
import { handleOpinion } from '../presence/collect.js';
import { handleQuestion } from '../presence/answer.js';
import { onOwnerFeedback } from '../executor/runner.js';
import { maybeReviewDocLink } from '../reviewer/index.js';
import { fmtStamp, timeVars } from '../time.js';

// 提示词时间参数（需求 1：每次唤醒都带当前时间；本地时区，不能用 toISOString）
const today = timeVars;

/**
 * 图片消息理解：下载原图 → 视觉模型描述 → 描述作为消息文本进入正常管道
 * （意图识别、记忆、意见路由从此对图片内容同样生效）。视觉不可用时如实降级。
 */
async function understandImage(msg: IncomingMessage): Promise<void> {
  const keyMatch = msg.text.match(/img_[A-Za-z0-9_-]+/);
  if (!keyMatch) {
    msg.text = '[图片]（无法定位图片资源）';
    return;
  }
  try {
    const { config } = await import('../config.js');
    const fs = await import('node:fs');
    fs.mkdirSync(`${config.root}/out/inbox`, { recursive: true });
    const rel = `out/inbox/${msg.msgId}.png`;
    const { downloadMessageResource } = await import('../lark/im.js');
    const saved = await downloadMessageResource(msg.msgId, keyMatch[0], rel, 'image');
    if (!saved) {
      msg.text = '[图片]（下载失败，已跳过识别）';
      return;
    }
    const abs = saved.startsWith('/') ? saved : `${config.root}/${saved}`;
    const { visionChat } = await import('../llm/client.js');
    const desc = await visionChat(
      abs,
      '你在替一个群聊助理看图。用 2~4 句话描述这张图的内容与关键信息（如果是截图，读出里面重要的文字/数据/报错；如果是照片，说清楚场景）。直接给描述，不要客套。',
    );
    msg.text = desc ? `[图片] ${desc}` : '[图片]（视觉模型暂时不可用，原图已存档）';
    bus.activity('message', `图片已识别（${msg.senderName ?? msg.senderOpenId.slice(0, 8)}）`, (desc ?? '识别失败').slice(0, 100));
    // 发图人 @了机器人或私聊发图 → 直接回看图结果，让人知道「它看见了」
    if (desc && (msg.mentionedBot || msg.chatKind === 'p2p')) {
      await adapter().replyText(msg.msgId, `我看到了：${desc.slice(0, 400)}`, `img-${msg.msgId}`).catch(() => {});
    }
  } catch (e) {
    msg.text = '[图片]（识别过程出错）';
    bus.activity('system', '图片理解失败', String(e).slice(0, 150));
  }
}

function membersList(): string {
  return persons.all().map((p) => `${p.id}: ${p.name}`).join('\n');
}

/**
 * LLM 意图段并发闸门（刷屏压测保护）：
 * 消息接收/存档/记忆不限流（不丢消息），但意图识别及后续 LLM 链路排队执行，
 * 防止快速刷屏把模型网关打挂或产生数百并发请求。
 */
const INTENT_CONCURRENCY = 4;
let intentActive = 0;
const intentWaiters: Array<() => void> = [];
async function withIntentSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (intentActive >= INTENT_CONCURRENCY) {
    await new Promise<void>((resolve) => intentWaiters.push(resolve));
  }
  intentActive += 1;
  try {
    return await fn();
  } finally {
    intentActive -= 1;
    intentWaiters.shift()?.();
  }
}

/** 当前积压深度（压测观测用） */
export function intentBacklog(): { active: number; waiting: number } {
  return { active: intentActive, waiting: intentWaiters.length };
}

/** 消息主入口（live 与 mock 共用同一条路径） */
export async function onMessage(msg: IncomingMessage): Promise<void> {
  // 幂等（FR-A2）
  if (!seen.firstTime(msg.msgId)) return;

  // 图片消息：下载 → 视觉模型理解 → 描述文本进入正常管道（发起人验收点：发图助理必须能看见）
  if (msg.msgType === 'image') {
    await understandImage(msg);
  }

  let sender = persons.byOpenId(msg.senderOpenId) ?? persons.byId(msg.senderOpenId);
  // 真实成员首次发言自动注册（群成员同步失败时的兜底）
  if (!sender && msg.senderOpenId.startsWith('ou_')) {
    const id = `u_${msg.senderOpenId.slice(-8)}`;
    const { ensureWorkspace } = await import('../executor/workspace.js');
    persons.upsert({
      id,
      feishuOpenId: msg.senderOpenId,
      name: msg.senderName || id,
      workspaceDir: `${config.workspacesRel}/${id}`,
      avatarColor: '#7B67EE',
      isBot: false,
    });
    ensureWorkspace(id, msg.senderName || id);
    sender = persons.byId(id);
    bus.activity('system', `新成员自动注册：${sender?.name}`, msg.senderOpenId);
    bus.changed('person');
  }
  const senderName = sender?.name ?? msg.senderName ?? msg.senderOpenId.slice(0, 8);
  if (!msg.senderName) msg.senderName = senderName;

  // 群聊注册（需求 6）：首见即登记，默认启用采集；管理员可按群关停
  const chatInfo = chats.touch(msg.chatId, msg.chatKind, msg.chatKind === 'p2p' ? `私聊 · ${senderName}` : null);

  // 全量存档 + 记忆 capture（FR-A5）；采集被管理员禁用的群跳过落库（需求 6）
  if (chatInfo.collectEnabled) {
    chatLog.save(msg, sender?.id ?? null);
    chats.bumpCount(msg.chatId, msg.ts);
    memory.capture({
      personId: sender?.id ?? null,
      chatId: msg.chatId,
      content: `${senderName}：${msg.text}`,
      sourceLink: msg.msgLink ?? null,
      kind: msg.text.startsWith('#会议') ? 'meeting' : 'chat',
    }).catch(() => {});
  }

  bus.activity('message', `${senderName}：${msg.text.slice(0, 60)}${msg.text.length > 60 ? '…' : ''}`, `${msg.chatKind} · ${msg.chatId.slice(0, 18)}`);

  if (msg.chatKind === 'p2p') {
    await onDirectMessage(msg, sender);
    return;
  }
  await onGroupMessage(msg, sender, senderName);
}

/** 私信：任务修改指令 / 初稿迭代意见 */
async function onDirectMessage(msg: IncomingMessage, sender: Person | null): Promise<void> {
  if (!sender) return;
  // 装机命令：「授权」→ 生成 device flow 链接（live 模式，10 分钟有效）
  if (msg.text.trim() === '授权') {
    const { startAuthFlow } = await import('../lark/authflow.js');
    const flow = await startAuthFlow();
    await adapter().sendText(
      { openId: msg.senderOpenId },
      flow
        ? `点这个链接完成消息接收权限授权（10 分钟内有效，验证码 ${flow.userCode}）：\n${flow.url}\n\n完成后我会自动确认，不用回复。`
        : '生成授权链接失败，请稍后再试或手动执行：lark-cli auth login --scope "im:message.group_at_msg:readonly im:message.p2p_msg:readonly"',
      `auth-${msg.msgId}`,
    );
    return;
  }
  // 0) 文字指令兜底（卡片回调未开通时也能走完流程）
  if (await tryTextCommand(msg, sender)) return;
  // 0.5) 私聊里的看图指令（不需要 @；不能被误当成迭代意见）
  if (/^(四象限|排期)$/.test(msg.text.trim())) {
    if (msg.text.trim() === '四象限') await sendQuadrantImage(sender.id, null, msg.msgId);
    else await sendScheduleImage(msg.chatId, sender.id);
    return;
  }
  // 0.8) 进度确认「有风险」后的原因补充（30 分钟窗口）→ 转告发起人；优先于迭代意见消费
  {
    const { handleNudgeReasonText } = await import('../ledger/nudge.js');
    if (await handleNudgeReasonText(sender, msg.text)) return;
  }
  // 1) 「修改」按钮后的文字
  if (hasPendingEdit(msg.senderOpenId) || hasPendingEdit(sender.id)) {
    await applyTextEdit(hasPendingEdit(msg.senderOpenId) ? msg.senderOpenId : sender.id, msg.text);
    return;
  }
  // 2) 待审阅任务的迭代意见（FR-C5）
  const reviewing = tasks.all({ ownerId: sender.id, statuses: ['reviewing'] });
  if (reviewing.length) {
    await onOwnerFeedback(reviewing[0], msg.text);
    return;
  }
  // 3) 对话式兜底（不再用固定帮助文案——@助理就该像个正常同事一样回话）
  await chatFallbackReply(msg, sender, sender.name);
}

/**
 * 兜底对话（发起人验收点：@超级助理即使没命中任何任务，也必须正常回消息）。
 * 上下文 = 群近期聊天 + 本人记忆召回 + 本人任务清单；结构化 JSON 输出规避推理模型思考过程泄漏。
 * 语气调优（发起人 2026-08-28 需求①）：像眼里有活的同事，不像客服。
 */
async function chatFallbackReply(msg: IncomingMessage, sender: Person | null, senderName: string): Promise<void> {
  const send = async (text: string) => {
    if (msg.chatKind === 'p2p') await adapter().sendText({ openId: msg.senderOpenId }, text, `chatfb-${msg.msgId}`);
    else await adapter().replyText(msg.msgId, text, `chatfb-${msg.msgId}`);
  };
  try {
    const recent = chatLog.recent(msg.chatId, 15)
      .map((r) => `[${fmtStamp(r.ts)}] ${r.senderName ?? '成员'}：${(r.text ?? '').slice(0, 120)}`)
      .join('\n') || '（暂无）';
    const hits = sender ? await memory.recall(sender.id, msg.text, 3).catch(() => []) : [];
    const myTasks = sender
      ? tasks.all({ ownerId: sender.id, statuses: ['pending_confirm', 'todo', 'running', 'reviewing'] })
          .slice(0, 6)
          .map((t) => `- ${t.title}（${t.status}${t.dueAt ? ` · 截止 ${t.dueAt.slice(5, 10)}` : ''}）`)
          .join('\n') || '（没有未完成任务）'
      : '（未注册成员）';
    const res = await chatJson<{ reply: string; handoff_agent?: boolean }>(
      [
        `你是「Everyone」，这个飞书${msg.chatKind === 'p2p' ? '私聊' : '群'}里的超级助理，群里每个人都有一个由你运营的分身。`,
        `现在是 ${timeVars().now}（${timeVars().weekday}）。下面的聊天记录和记忆都带原始时间——引用时留意新旧，别把过时信息当现状。`,
        '聊天记录里「Everyone（超级代理）」开头的是你自己此前的发言，「Everyone（某某的分身）」是你以对应成员分身身份的代答——别把自己说过的话当成别人的观点，也别重复自己刚说过的内容。',
        '说话像一个眼里有活、说话利落的同事，绝不像客服：',
        '- 直接回应对方这句话本身，不寒暄、不自我介绍、不用「您」，直接叫名字',
        '- 有依据就给结论并顺口带出处（例：「8/20 会上定过：单场 5 万封顶」），没依据就直说不知道、别编',
        '- 默认 1~3 句话（90 字内）；对方明确要清单或细节时才展开',
        '- 禁用客服腔：「很高兴为你」「请问还有什么」「作为一个AI」这类话一个字都不要出现',
        '- 和当前话题相关时，可以顺手带一句对方的任务状态（例：「你那条周五截止的报告还在待办」），但不要推销功能',
        '- 群里聊闲天时可以接梗、有点性格，但不阴阳怪气、不贫嘴过头',
        '你真实具备的能力（仅在被问到时才提，不要虚构别的）：记录群里的承诺进台账、分身替人写报告/改代码并私信迭代、发布后三人设评审、每日日报+个人战报、帮人收意见、检索记忆署名代答、任务确认后同步飞书日程、动手做页面/看板/小工具/长文档（Agent 模式）、创建定时心跳任务（每天/每周定点推送提醒汇总）；说「四象限」「排期」可以出图。',
        '',
        '转交判断（快速模式 → Agent 模式）：如果对方的请求靠「回一段话」根本交付不了，需要你实际动手干活——做页面/看板/小工具、把数据整理成文档或图表、写一篇完整长文、查资料汇总成报告、创建定时推送/例行提醒（心跳任务）——就把 handoff_agent 设为 true，reply 留空字符串（系统会用消息表情回应告知对方已接单，不需要转场话），活会交给你的 Agent 模式实际完成。纯聊天、一段话能答清楚的问题、只是发牢骚：handoff_agent=false，正常回话。',
        '输出 JSON：{"reply": "回复内容", "handoff_agent": false}',
      ].join('\n'),
      [
        `【群里最近的聊天（带时间）】\n${recent}`,
        `【${senderName} 的相关记忆（带原始时间，可作为回答依据，引用时带出处）】\n${hits.map(memory.recallLine).join('\n') || '（无）'}`,
        `【${senderName} 的未完成任务】\n${myTasks}`,
        `【${senderName} 对你说】${msg.text}`,
      ].join('\n\n'),
      { fast: true, temperature: 0.6, maxTokens: 600 },
    );
    const text = (res.reply ?? '').trim().slice(0, 900);
    // 快速模式 → Agent 模式转交（新需求 2a；2026-08-29 需求①改表情 ack）：
    // 不再发「收到，我做一下」转场消息——runChatAgent 会给原消息附加 Get 表情回应
    if (res.handoff_agent) {
      bus.activity('intent', `快速模式转交 Agent 模式（${senderName}）`, msg.text.slice(0, 60));
      const { runChatAgent } = await import('../agent/run.js');
      runChatAgent(msg, sender, senderName)
        .catch((e) => bus.activity('system', 'Agent 模式执行异常', String(e).slice(0, 150)));
      return;
    }
    if (text) {
      await send(text);
      bus.activity('message', `兜底对话回复 ${senderName}`, text.slice(0, 80));
      return;
    }
    throw new Error('LLM 兜底回复为空');
  } catch (e) {
    bus.activity('system', '兜底对话失败，使用固定话术', String(e).slice(0, 120));
    await send('我在。这句我没完全跟上——你可以再说具体点，或者 @我 说「四象限」「排期」看任务全景。').catch(() => {});
  }
}

/**
 * 文字指令兜底（等价卡片按钮，人工确认铁律同样满足——本人亲口说的）：
 * 「确认」/「忽略」→ 最近待确认任务；「发布」/「放弃」→ 最近待审阅任务；
 * 「知道了」/「转任务」/「不归我管」→ 最近意见私信卡；「撤回」→ 最近署名代答；「重试」→ 最近失败任务。
 * 卡片回调链路故障时（总线断连/回调未开通），这些指令保证全部流程照样能走完。
 */
async function tryTextCommand(msg: IncomingMessage, sender: Person): Promise<boolean> {
  const t = msg.text.trim();
  // 进度确认指令（私聊限定）：已完成 / 顺利 / 有风险 → 最近一张进度确认卡（新功能 3）
  if (msg.chatKind === 'p2p') {
    const { tryNudgeTextCommand } = await import('../ledger/nudge.js');
    if (await tryNudgeTextCommand(sender, t)) return true;
  }
  // 「发布」「放弃」允许后跟其他内容（如「发布，我要睡觉了」），意图以开头为准
  const pubMatch = t.match(/^(发布|放弃)([，,。!！\s]|$)/);
  if (pubMatch) {
    const reviewing = tasks.all({ ownerId: sender.id, statuses: ['reviewing'] });
    if (reviewing.length) {
      const { handleDraftCardAction } = await import('../executor/runner.js');
      await handleDraftCardAction({
        actionId: pubMatch[1] === '发布' ? 'draft_publish' : 'draft_abort',
        value: { action: pubMatch[1] === '发布' ? 'draft_publish' : 'draft_abort', task_id: reviewing[0].id },
        operatorOpenId: sender.id,
        ts: new Date().toISOString(),
      });
      return true;
    }
  }
  const confirmMatch = t.match(/^(确认|忽略)(?:[\s，,]+(.+))?$/);
  if (confirmMatch) {
    const pending = tasks.all({ ownerId: sender.id, statuses: ['pending_confirm'] });
    if (!pending.length) return false;
    const keyword = confirmMatch[2]?.trim();
    const task = keyword ? pending.find((x) => x.title.includes(keyword)) : pending[0];
    if (!task) {
      await adapter().sendText(
        { openId: msg.senderOpenId },
        `没找到标题含「${keyword}」的待确认任务。当前待确认：\n${pending.slice(0, 6).map((x) => `· ${x.title}`).join('\n')}`,
        `tcnf-${msg.msgId}`,
      );
      return true;
    }
    // 多条待确认且没带关键词 → 处理最新一条并回显其余，避免确认错对象
    const others = pending.filter((x) => x.id !== task.id);
    const rest = !keyword && others.length
      ? `\n还有 ${others.length} 条待确认（回复「确认 关键词」指定）：\n${others.slice(0, 4).map((x) => `· ${x.title}`).join('\n')}`
      : '';
    if (confirmMatch[1] === '确认') {
      const { confirmTask } = await import('../ledger/tasks.js');
      await confirmTask(task.id);
      await adapter().sendText({ openId: msg.senderOpenId }, `✅ 已确认入账：「${task.title}」${rest}`, `tc-${task.id}`);
    } else {
      tasks.update(task.id, { status: 'cancelled' });
      bus.changed('task');
      const { removeTaskCalendarEvent } = await import('../lark/calendar.js');
      removeTaskCalendarEvent(tasks.byId(task.id)!, '任务被忽略').catch(() => {});
      await adapter().sendText({ openId: msg.senderOpenId }, `已忽略：「${task.title}」${rest}`, `ti-${task.id}`);
    }
    return true;
  }
  // 帮你收：知道了 / 转任务 / 不归我管（私聊限定——意见卡发在私聊，群里说这些词大多是日常用语）
  if (msg.chatKind === 'p2p' && /^(知道了|转任务|转为任务|不归我管)$/.test(t)) {
    const { assists, pendingCards } = await import('../store/repo.js');
    const assist = assists.latestOf(sender.id, 'collect', ['notified']);
    if (!assist) return false;
    const cardRef = pendingCards.findByPayloadValue('collect', 'assistId', assist.id);
    const actionId = t === '知道了' ? 'collect_ack' : t === '不归我管' ? 'collect_reject' : 'collect_to_task';
    const { handleCollectCardAction } = await import('../presence/collect.js');
    await handleCollectCardAction({
      actionId,
      value: { action: actionId, assist_id: assist.id },
      operatorOpenId: sender.id,
      msgId: cardRef?.cardMsgId,
      ts: new Date().toISOString(),
    });
    return true;
  }
  // 帮你答：撤回最近一条署名代答（owner 校验在 handler 内）
  if (/^撤回$/.test(t)) {
    const { assists, pendingCards } = await import('../store/repo.js');
    const assist = assists.latestOf(sender.id, 'answer', ['answered']);
    if (!assist) return false;
    const cardRef = pendingCards.findByPayloadValue('answer', 'assistId', assist.id);
    const answerMsgId = (cardRef?.payload?.answerMsgId as string) ?? cardRef?.cardMsgId;
    const { handleAnswerCardAction } = await import('../presence/answer.js');
    await handleAnswerCardAction({
      actionId: 'answer_retract',
      value: { action: 'answer_retract', assist_id: assist.id },
      operatorOpenId: sender.id,
      msgId: answerMsgId,
      ts: new Date().toISOString(),
    });
    await adapter().sendText({ openId: msg.senderOpenId }, '已撤回那条代答，并记入负反馈', `retract-${assist.id}`);
    return true;
  }
  // 执行失败后的重试（私聊限定）
  if (msg.chatKind === 'p2p' && /^重试$/.test(t)) {
    const { runs } = await import('../store/repo.js');
    const candidate = tasks.all({ ownerId: sender.id, statuses: ['todo'] })
      .find((task) => runs.latestOfTask(task.id)?.status === 'failed');
    if (!candidate) return false;
    await adapter().sendText({ openId: msg.senderOpenId }, `收到，分身重新开工：「${candidate.title}」`, `retry-${candidate.id}`);
    bus.emit('task:startRun', candidate);
    return true;
  }
  return false;
}

/** 群消息：规则命令 → 会议 → LLM 意图 */
async function onGroupMessage(msg: IncomingMessage, sender: Person | null, senderName: string): Promise<void> {
  const text = msg.text.trim();

  // 「修改」按钮后的文字（编辑提示发在群里，群消息也要接）
  if (sender && (hasPendingEdit(msg.senderOpenId) || hasPendingEdit(sender.id))) {
    await applyTextEdit(hasPendingEdit(msg.senderOpenId) ? msg.senderOpenId : sender.id, msg.text);
    return;
  }

  // 文字指令兜底（群里回「确认」「发布」等，等价卡片按钮）
  if (sender && await tryTextCommand(msg, sender)) return;

  // ===== 规则层：@Everyone 四象限 / 排期（FR-B7 ②）=====
  if (msg.mentionedBot && /四象限|排期/.test(text)) {
    const namedPerson = persons.all().find((p) => text.includes(p.name) || text.includes(p.id));
    const target = namedPerson ?? sender;
    if (/四象限/.test(text)) {
      if (target) await sendQuadrantImage(target.id, msg.chatId, msg.msgId);
    } else {
      await sendScheduleImage(msg.chatId, /全群|所有/.test(text) ? undefined : target?.id);
    }
    return;
  }

  // ===== 会议记录（S2）：#会议 开头，或 @Everyone + 长文本 =====
  if (text.startsWith('#会议') || (msg.mentionedBot && text.length > 200)) {
    await handleMeeting(msg, sender, senderName);
    return;
  }

  // ===== 文档链接评审（FR-D2）：@Everyone + 文档链接 =====
  if (msg.mentionedBot && /https?:\/\/\S+(docx|docs|wiki)\S*/.test(text)) {
    await maybeReviewDocLink(msg, senderName);
    return;
  }

  // ===== LLM 意图识别（FR-A3，快模型；并发闸门内排队执行）=====
  if (text.length < 6 && !msg.mentionedBot) return; // 太短跳过（但 @了机器人必须回应）
  await withIntentSlot(async () => {
    let cls: { type: IntentType; confidence: number };
    try {
      cls = await chatJson(
        '你是意图分类器，只输出 JSON。',
        prompt('intent_classify', { ...today(), members: membersList(), sender: senderName, text }),
        { fast: true, temperature: 0 },
      );
    } catch (e) {
      bus.activity('system', '意图识别失败', String(e).slice(0, 150));
      if (msg.mentionedBot) await chatFallbackReply(msg, sender, senderName);
      return;
    }
    if (!cls?.type || cls.type === 'none') {
      // @了机器人但没命中任何任务 → 也要正常回话（发起人验收点）
      if (msg.mentionedBot) await chatFallbackReply(msg, sender, senderName);
      return;
    }
    bus.activity('intent', `识别意图：${cls.type}（${(cls.confidence ?? 0).toFixed(2)}）`, text.slice(0, 60));

    switch (cls.type) {
      case 'commitment':
      case 'mention_assign':
        await handleTaskIntent(msg, sender, senderName, cls.type, cls.confidence);
        break;
      case 'meeting':
        await handleMeeting(msg, sender, senderName);
        break;
      case 'opinion':
        await handleOpinion(msg, sender, senderName, cls.confidence);
        break;
      case 'question': {
        const answeredInGroup = await handleQuestion(msg, sender, senderName);
        // 直接 @机器人问的问题，代答链路没走通时由超级助理本人回答（不能已读不回）
        if (!answeredInGroup && msg.mentionedBot) await chatFallbackReply(msg, sender, senderName);
        break;
      }
      case 'agent': {
        // 直接命中 Agent 模式（新需求 2a）。群里没 @ 助理的不接——避免不请自来抢活
        if (msg.mentionedBot || msg.chatKind === 'p2p') {
          const { runChatAgent } = await import('../agent/run.js');
          // 不占意图并发闸门的坑：Agent 模式一跑几分钟，有自己的并发闸
          runChatAgent(msg, sender, senderName)
            .catch((e) => bus.activity('system', 'Agent 模式执行异常', String(e).slice(0, 150)));
        } else {
          bus.activity('intent', 'agent 请求未 @ 助理，忽略', text.slice(0, 60));
        }
        break;
      }
    }
  });
}

/** 承诺 / @ 指派 → 抽取 → 确认卡（S1） */
async function handleTaskIntent(
  msg: IncomingMessage, sender: Person | null, senderName: string,
  intentType: 'commitment' | 'mention_assign', clsConfidence: number,
): Promise<void> {
  const ex = await chatJson<{
    owner_id: string; title: string; due: string | null;
    important: boolean; urgent: boolean; confidence: number;
  }>(
    '你是任务抽取器，只输出 JSON。',
    prompt('extract_commitment', {
      ...today(), members: membersList(), sender: senderName, intent_type: intentType, text: msg.text,
    }),
    { fast: true, temperature: 0 },
  );
  const ownerId = intentType === 'commitment' && sender ? sender.id : ex.owner_id;
  const owner = persons.byId(ownerId);
  if (!owner) {
    bus.activity('intent', `任务负责人无法识别，忽略`, `owner_id=${ex.owner_id}`);
    return;
  }
  const confidence = Math.min(clsConfidence, ex.confidence ?? 1);
  if (confidence < 0.6) {
    // 低置信度：只入后台待认领列表，不打扰（FR-A3）
    tasks.create({
      ownerId, creatorId: sender?.id ?? null,
      title: ex.title, source: intentType === 'commitment' ? 'commitment' : 'mention',
      important: !!ex.important, urgent: !!ex.urgent, dueAt: ex.due,
      status: 'pending_confirm', confidence,
      srcMsgLink: msg.msgLink, srcMsgId: msg.msgId, chatId: msg.chatId,
    });
    bus.activity('task', `低置信度任务仅入后台：${ex.title}`, `confidence=${confidence.toFixed(2)}`);
    bus.changed('task');
    return;
  }
  await proposeTask({
    ownerId, title: ex.title,
    source: intentType === 'commitment' ? 'commitment' : 'mention',
    important: !!ex.important, urgent: !!ex.urgent, dueAt: ex.due,
    confidence, srcMsg: msg, srcText: msg.text,
  });
}

/** 会议记录拆解（S2）：结论 + 行动项 → 逐条确认卡 */
async function handleMeeting(msg: IncomingMessage, sender: Person | null, senderName: string): Promise<void> {
  bus.activity('intent', '开始拆解会议记录', `${msg.text.length} 字`);
  const ex = await chatJson<{
    conclusions: string[];
    action_items: Array<{ owner_id: string; title: string; due: string | null; important: boolean; urgent: boolean }>;
  }>(
    '你是会议记录拆解器，只输出 JSON。',
    prompt('extract_meeting', {
      ...today(), members: membersList(), sender_id: sender?.id ?? '', text: msg.text,
    }),
    { temperature: 0 },
  );

  const conclusions = (ex.conclusions ?? []).slice(0, 5);
  const items = (ex.action_items ?? []).filter((it) => persons.byId(it.owner_id));
  const summaryLines = [
    `📋 会议记录已拆解：${conclusions.length} 条结论、${items.length} 条行动项`,
    ...conclusions.map((c, i) => `${i + 1}. ${c}`),
  ];
  await adapter().replyText(msg.msgId, summaryLines.join('\n'), `meeting-${msg.msgId}`);

  memory.capture({
    personId: sender?.id ?? null, chatId: msg.chatId,
    content: `会议记录（${senderName} 粘贴）：结论：${conclusions.join('；')}`,
    sourceLink: msg.msgLink ?? null, kind: 'meeting',
  }).catch(() => {});

  for (const it of items) {
    await proposeTask({
      ownerId: it.owner_id, title: it.title, source: 'meeting',
      important: !!it.important, urgent: !!it.urgent, dueAt: it.due,
      confidence: 0.9, srcMsg: msg, srcText: `会议行动项 · ${it.title}`,
    });
  }
  bus.activity('task', `会议拆出 ${items.length} 条行动项，已逐条发确认卡`);
}

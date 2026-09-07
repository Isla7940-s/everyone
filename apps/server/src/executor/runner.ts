import fs from 'node:fs';
import type { CardAction, Task } from '@everyone/shared';
import { closeAgentSession, createAgentSession, type AgentSession } from '../agent/session.js';
import { bus } from '../bus.js';
import { config } from '../config.js';
import { adapter } from '../context.js';
import * as cards from '../ledger/cards.js';
import { syncTaskToBitable } from '../ledger/bitable.js';
import { chat, chatJson } from '../llm/client.js';
import * as memory from '../memory/index.js';
import { prompt } from '../prompts.js';
import { agentRuns, kv, pendingCards, persons, runs, tasks } from '../store/repo.js';
import { buildTaskBrief } from './brief.js';
import { createTaskDoc, overwriteTaskDoc } from './docstore.js';
import { runBuiltin } from './fallback.js';
import { runOpenCode } from './opencode.js';
import {
  briefPath, diffRepoSnapshots, draftPath, ensureWorkspace, listWorkspaceFiles, readDraft, snapshotRepo,
} from './workspace.js';

/** 每个任务的历轮意见（kv 持久化——重启不丢，第 N 稿仍然记得前 N-1 轮意见） */
const feedbackLog = {
  get(taskId: string): string[] {
    return kv.getJson<string[]>(`feedback:${taskId}`, []);
  },
  push(taskId: string, item: string): string[] {
    const list = kv.getJson<string[]>(`feedback:${taskId}`, []);
    list.push(item);
    kv.setJson(`feedback:${taskId}`, list);
    return list;
  },
};
/** 正在执行的任务，防重入 */
const inFlight = new Set<string>();

// ===== 能力自评（FR-C1）=====

export async function evaluateAndMaybeRun(task: Task): Promise<void> {
  const owner = persons.byId(task.ownerId);
  if (!owner) return;
  try {
    const mem = memory.readPersonMemory(task.ownerId);
    const hits = await memory.recall(task.ownerId, task.title, 3);
    const repoFiles = listWorkspaceFiles(task.ownerId)
      .filter((f) => f.path.startsWith('repo/'))
      .slice(0, 60)
      .map((f) => `- ${f.path}（${f.size}B）`)
      .join('\n') || '（repo 为空）';
    const res = await chatJson<{ can_do: boolean; task_kind?: string; reason: string; plan: string[] }>(
      '你是分身能力自评器，只输出 JSON。',
      prompt('capability_check', {
        owner_name: owner.name,
        title: task.title,
        src_text: task.srcMsgLink ?? task.title,
        due: task.dueAt ?? '未设定',
        memory: mem.slice(0, 4000),
        recall: hits.map((h) => `- ${h.content}（出处：${h.source}）`).join('\n') || '（无）',
        repo_files: repoFiles,
      }),
      { fast: true, temperature: 0 },
    );
    const kind = (['doc', 'code', 'data', 'other'].includes(res.task_kind ?? '') ? res.task_kind : 'doc') as 'doc' | 'code' | 'data' | 'other';
    tasks.update(task.id, { canDo: !!res.can_do, canDoReason: res.reason ?? '', taskKind: kind });
    bus.changed('task');
    bus.activity('run', `能力自评：${res.can_do ? '✅ 能干' : '❌ 不干'} · ${task.title}`, `[${kind}] ${res.reason}`);
    if (res.can_do) {
      await startRun(tasks.byId(task.id)!);
    }
  } catch (e) {
    bus.activity('system', '能力自评失败（任务留在台账）', String(e).slice(0, 150));
  }
}

// ===== 执行（S3）=====

export async function startRun(task: Task): Promise<void> {
  if (inFlight.has(task.id)) return;
  inFlight.add(task.id);
  const owner = persons.byId(task.ownerId)!;
  const iteration = (runs.ofTask(task.id).length ?? 0) + 1;
  const run = runs.create(task.id, 'opencode', iteration);
  tasks.update(task.id, { status: 'running' });
  bus.changed('task');
  bus.activity('run', `分身开工（第 ${iteration} 稿）：${task.title}`, `owner=${owner.name}`);

  // 沙箱透明化：首稿开工时告知本人分身在哪个沙箱里干活、怎么围观（发起人验收点：用户侧能看沙箱）
  if (iteration === 1) {
    const kindLabel = task.taskKind === 'code' ? '代码修改' : task.taskKind === 'data' ? '数据整理' : '文档写作';
    await dmOwner(owner.id, 'text', [
      `🛠 你的分身开工了：「${task.title}」（${kindLabel}）`,
      `沙箱：${config.workspacesRel}/${owner.id}/（分身只能读写这个目录，改不到别人的东西）`,
      `本任务目录：tasks/${task.id}/（任务书 brief.md、成稿 draft.md、过程笔记 notes/ 都在里面）`,
      `围观：我的分身 → 沙箱文件，或点任务看「沙箱透视」`,
    ].join('\n'), `start-${task.id}`).catch(() => {});
  }

  let session: AgentSession | null = null;
  try {
    const wsDir = ensureWorkspace(owner.id, owner.name);
    await buildTaskBrief(task, feedbackLog.get(task.id));
    const isCodeTask = task.taskKind === 'code';
    const repoBefore = isCodeTask ? snapshotRepo(owner.id) : null;

    // MCP 会话（新需求 2b）：分身经 feishu_reply 直接把交付私信给本人；
    // 带上已有 docToken → 迭代时 md 附件 overwrite 同一篇云文档（FR-C5 不新建）
    session = createAgentSession({
      mode: 'task',
      personId: owner.id,
      taskId: task.id,
      dmOpenId: ownerDmTarget(owner.id)?.openId ?? null,
      chatId: task.chatId,
      docToken: task.docToken,
      docUrl: task.docUrl,
      workspaceDir: wsDir,
      label: `任务：${task.title.slice(0, 40)}`,
      ttlMs: (config.opencode.timeoutSec + 900) * 1000,
    });

    // 运行登记（需求 2/3：任务模式的每一次 OpenCode 执行也进「Agent 运行中」与轨迹）
    agentRuns.start({
      id: session.id, mode: 'task',
      personId: owner.id, personName: owner.name,
      taskId: task.id,
      label: `任务第 ${iteration} 稿 · ${task.title.slice(0, 40)}`,
      request: task.title,
      workspaceDir: `${config.workspacesRel}/${owner.id}/tasks/${task.id}`,
    });
    bus.changed('run');

    // 先 OpenCode；文档类失败降级内置 executor（FR-I2）；代码类不降级（内置引擎改不了代码，宁可诚实失败）
    let engine: 'opencode' | 'builtin' = 'opencode';
    let repoChanges: ReturnType<typeof diffRepoSnapshots> | null = null;
    try {
      await runOpenCode(wsDir, task.id, task.taskKind, {
        EVERYONE_MCP_URL: `http://127.0.0.1:${config.serverPort}/mcp`,
        EVERYONE_AGENT_TOKEN: session.token,
      }, session.id);
      if (isCodeTask && repoBefore) {
        repoChanges = diffRepoSnapshots(repoBefore, snapshotRepo(owner.id));
        const hasReport = session.deliveries.length > 0 || !!readDraft(owner.id, task.id);
        if (!repoChanges.changed && !hasReport) {
          throw new Error('OpenCode 未对 repo 做任何修改，也未产出报告');
        }
        // 改了代码但忘了写报告 → 根据变更清单自动补一份（报告是发布链路的载体，不能缺）
        if (repoChanges.changed && !hasReport) {
          const summary = await chatJson<{ report: string }>(
            '你是代码变更报告生成器，只输出 JSON：{"report": "markdown 变更报告，第一行是 # 标题，包含：改了什么、涉及文件、建议的验证方式"}',
            `任务：${task.title}\n变更文件：\n新增 ${repoChanges.added.join(', ') || '无'}\n修改 ${repoChanges.modified.join(', ') || '无'}\n删除 ${repoChanges.deleted.join(', ') || '无'}`,
            { fast: true },
          );
          fs.writeFileSync(draftPath(owner.id, task.id), summary.report ?? `# ${task.title} · 变更报告\n\n修改文件：${repoChanges.modified.join(', ')}`);
        }
      }
      if (!session.deliveries.length && !readDraft(owner.id, task.id)) {
        throw new Error('OpenCode 未走 MCP 交付，也未产出 draft.md');
      }
    } catch (e) {
      if (isCodeTask) throw e; // 代码任务不走文本降级——假装完成比失败更糟
      bus.activity('run', 'OpenCode 失败，降级内置 executor', String(e).slice(0, 200));
      engine = 'builtin';
      await runBuiltin(briefPath(owner.id, task.id), draftPath(owner.id, task.id));
    }

    // ===== 交付结算 =====
    // MCP 已交付 → deliveries 为准（doc/page 取链接，正文来自 content）；
    // 未走 MCP（内置引擎 / 旧行为）→ 读 draft.md 走内部转档老路
    const rev = session ? [...session.deliveries].reverse() : [];
    const primary = rev.find((d) => d.kind === 'doc' || d.kind === 'page')
      ?? rev.find((d) => d.kind === 'text' || d.kind === 'image' || d.kind === 'card')
      ?? null;

    let draft = primary?.content?.trim() ? primary.content : (readDraft(owner.id, task.id) ?? '');
    if (!draft.trim() && primary) draft = primary.title ? `# ${primary.title}` : '（分身经 MCP 直接交付，无正文存档）';
    if (!draft.trim()) throw new Error('两种引擎都未产出内容');

    // 代码任务：把变更文件清单附进报告结尾（证据链）
    if (isCodeTask && repoChanges?.changed) {
      const lines = [
        '',
        '---',
        '**本次代码变更清单（系统自动核对）**',
        ...(repoChanges.added.length ? [`- 新增：${repoChanges.added.join('、')}`] : []),
        ...(repoChanges.modified.length ? [`- 修改：${repoChanges.modified.join('、')}`] : []),
        ...(repoChanges.deleted.length ? [`- 删除：${repoChanges.deleted.join('、')}`] : []),
      ];
      if (!draft.includes('本次代码变更清单')) {
        draft = `${draft.trimEnd()}\n${lines.join('\n')}\n`;
        fs.writeFileSync(draftPath(owner.id, task.id), draft);
        // 分身已经把报告转成云文档的话，云文档也补上清单
        if (session.docToken) {
          await overwriteTaskDoc(task.id, session.docToken, draft).catch(() => {});
        }
      }
      bus.activity('run', `代码变更核对：+${repoChanges.added.length} ~${repoChanges.modified.length} -${repoChanges.deleted.length}`, [...repoChanges.added, ...repoChanges.modified].slice(0, 5).join('、'));
    }

    // 沙箱透视/发布链路依赖 draft.md：MCP 直接交付且没落盘时补写一份存档
    if (!readDraft(owner.id, task.id) && draft.trim()) {
      fs.writeFileSync(draftPath(owner.id, task.id), draft);
    }

    let docToken = session.docToken ?? task.docToken;
    let docUrl = primary?.kind === 'page' ? (primary.url ?? null) : (session.docUrl ?? task.docUrl);
    if (!primary) {
      // 内部转档老路（内置引擎降级时）：draft.md → 云文档
      if (docToken) {
        await overwriteTaskDoc(task.id, docToken, draft);
      } else {
        try {
          const doc = await createTaskDoc(task.id, task.title, draft);
          docToken = doc.token;
          docUrl = doc.url;
        } catch (e) {
          // docx 无权限 → markdown 长消息降级（FR-I2）
          bus.activity('system', '文档创建失败，将以长消息发送', String(e).slice(0, 150));
        }
      }
    }
    tasks.update(task.id, { status: 'reviewing', docToken, docUrl });
    runs.finish(run.id, 'succeeded', { docToken: docToken ?? undefined });
    agentRuns.finish(session.id, 'succeeded', {
      deliveries: session.deliveries.length,
      deliverySummary: engine === 'builtin' ? '内置引擎降级产出' : (primary ? `${primary.kind}：${primary.title ?? ''}` : 'draft.md 转档'),
    });
    bus.changed('task');

    // 私信迭代卡（FR-C5）：交付物已由 MCP 送达（或下面补发），这张卡管「迭代意见 / 发布 / 放弃」
    const summary = await draftSummary(draft);
    const t = tasks.byId(task.id)!;
    const card = cards.draftCard(t, docUrl ?? '', iteration, summary);
    const cardMsgId = await dmOwner(owner.id, 'card', card, `draft-${task.id}-${iteration}`);
    if (cardMsgId) pendingCards.save(cardMsgId, 'draft', { taskId: task.id });
    if (!primary && !docUrl && cardMsgId) {
      // 长消息降级：直接把全文发过去（MCP 已交付时不需要——本人已经收到内容）
      await dmOwner(owner.id, 'text', draft.slice(0, 3800), `draftfull-${task.id}-${iteration}`);
    }
    bus.activity('run', `第 ${iteration} 稿已私信 ${owner.name}`, docUrl ?? (primary ? `MCP 直接交付（${primary.kind}）` : '（长消息形式）'));
  } catch (e) {
    runs.finish(run.id, 'failed', { error: String(e).slice(0, 500) });
    if (session) {
      agentRuns.finish(session.id, String(e).includes('超时') ? 'timeout' : 'failed', {
        deliveries: session.deliveries.length, error: String(e).slice(0, 300),
      });
    }
    tasks.update(task.id, { status: 'todo' });
    bus.changed('task');
    bus.activity('system', `分身执行失败：${task.title}`, String(e).slice(0, 200));
    // FR-C7：私信告知 + 一键重试
    const t = tasks.byId(task.id)!;
    const failMsgId = await dmOwner(owner.id, 'card', cards.runFailedCard(t, String(e)), `fail-${task.id}-${iteration}`).catch(() => null);
    if (failMsgId) pendingCards.save(failMsgId, 'run_failed', { taskId: task.id });
  } finally {
    if (session) closeAgentSession(session);
    inFlight.delete(task.id);
  }
}

/** owner 的私信目标：live 用 open_id；mock 用 person id；虚拟成员在 live 不可达 → null */
function ownerDmTarget(personId: string): { openId: string } | null {
  const p = persons.byId(personId);
  if (!p) return null;
  if (config.chatAdapter === 'lark') return p.feishuOpenId ? { openId: p.feishuOpenId } : null;
  return { openId: personId };
}

/** 尽力私信（不可达时记活动流，不抛错——虚拟成员的产出在工作台仍然全量可见） */
async function dmOwner(personId: string, kind: 'text' | 'card', payload: unknown, idem: string): Promise<string | null> {
  const to = ownerDmTarget(personId);
  const p = persons.byId(personId);
  if (!to) {
    bus.activity('run', `${p?.name ?? personId} 是虚拟成员（无飞书账号），私信已略过`, '产出在工作台可查看');
    return null;
  }
  // 任务链路的私信都是「本人分身」在说话（需求③：outbound 存档署名区分超级代理/分身）
  const { withSpeaker, avatarSpeaker } = await import('../lark/speaker.js');
  return withSpeaker(avatarSpeaker(p?.name ?? personId), async () => {
    if (kind === 'text') {
      const r = await adapter().sendText(to, String(payload), idem);
      return r.msgId;
    }
    const r = await adapter().sendCard(to, payload, idem);
    return r.msgId;
  });
}

async function draftSummary(draft: string): Promise<string> {
  try {
    const res = await chatJson<{ summary: string }>(
      '你是文档摘要器，只输出 JSON：{"summary": "两句话概括这篇文档讲了什么、给出什么结论"}',
      draft.slice(0, 6000),
      { fast: true, maxTokens: 300 },
    );
    const s = (res.summary ?? '').trim();
    if (s) return s.slice(0, 200);
  } catch { /* fallthrough */ }
  return draft.replace(/^#.*\n/, '').trim().slice(0, 120) + '…';
}

// ===== 迭代（FR-C5：文字意见 → 重跑 → 同一文档 overwrite）=====

export async function onOwnerFeedback(task: Task, feedbackText: string): Promise<void> {
  const owner = persons.byId(task.ownerId)!;
  const list = feedbackLog.push(task.id, feedbackText);
  bus.activity('run', `收到 ${owner.name} 的修改意见，开始迭代`, feedbackText.slice(0, 100));
  await dmOwner(owner.id, 'text', `收到，这就改《${task.title.slice(0, 30)}》：「${feedbackText.slice(0, 60)}${feedbackText.length > 60 ? '…' : ''}」`, `ack-${task.id}-${list.length}`).catch(() => {});

  // S7 记忆沉淀（异步，不阻塞迭代）
  distillMemory(task, owner.id, owner.name, feedbackText).catch(() => {});

  await startRun(tasks.byId(task.id)!);
}

async function distillMemory(task: Task, ownerId: string, ownerName: string, feedback: string): Promise<void> {
  const res = await chatJson<{ items: string[] }>(
    '你是记忆沉淀器，只输出 JSON。',
    prompt('memory_distill', {
      title: task.title,
      owner_name: ownerName,
      feedback,
      memory: memory.readPersonMemory(ownerId).slice(0, 3000),
    }),
    { fast: true, temperature: 0 },
  );
  const items = (res.items ?? []).slice(0, 3);
  if (items.length) {
    const latestRun = runs.latestOfTask(task.id);
    memory.appendPersonMemory(ownerId, items, `任务「${task.title}」迭代意见`, latestRun?.id);
  }
}

// ===== 发布（FR-C6，人工确认铁律：owner 点发布）=====

export async function handleDraftCardAction(action: CardAction): Promise<boolean> {
  const taskId = action.value.task_id;
  if (!taskId) return false;
  const task = tasks.byId(taskId);
  if (!task) return false;
  const owner = persons.byId(task.ownerId)!;
  const operator = persons.byOpenId(action.operatorOpenId) ?? persons.byId(action.operatorOpenId);
  if (operator?.id !== task.ownerId) {
    const { cardFeedback } = await import('../lark/feedback.js');
    await cardFeedback(action, `这张卡片只有 ${owner.name} 本人能操作`);
    return true;
  }

  switch (action.actionId) {
    case 'draft_publish': {
      if (task.status !== 'reviewing') {
        const { cardFeedback } = await import('../lark/feedback.js');
        await cardFeedback(action, `「${task.title}」当前状态是 ${task.status}，不能发布（只有待审阅的稿子能发布）`);
        return true;
      }
      tasks.update(task.id, { status: 'published' });
      bus.changed('task');
      syncTaskToBitable(tasks.byId(task.id)!).catch(() => {});
      const draft = readDraft(owner.id, task.id) ?? '';
      const summary = await draftSummary(draft);
      const link = task.docUrl ? `\n📄 ${task.docUrl}` : '';
      const text = `📣 @${owner.name} 的「${task.title}」已完成（Everyone 分身起草 · 本人已确认）\n\n${summary}${link}`;
      const chatId = task.chatId ?? adapter().demoChatId;
      const { withSpeaker, avatarSpeaker } = await import('../lark/speaker.js');
      const sent = await withSpeaker(avatarSpeaker(owner.name), () => adapter().sendText({ chatId }, text, `publish-${task.id}`));
      bus.activity('send', `报告已发布进群：${task.title}`, `by ${owner.name}`);
      await dmOwner(owner.id, 'text', '✅ 已代表你发布到群里', `pubok-${task.id}`).catch(() => {});
      bus.emit('task:published', { task: tasks.byId(task.id)!, groupMsgId: sent.msgId, draft });
      return true;
    }
    case 'draft_abort': {
      if (task.status !== 'reviewing' && task.status !== 'running') {
        const { cardFeedback } = await import('../lark/feedback.js');
        await cardFeedback(action, `「${task.title}」当前状态是 ${task.status}，这张卡已过期`);
        return true;
      }
      tasks.update(task.id, { status: 'cancelled' });
      bus.changed('task');
      syncTaskToBitable(tasks.byId(task.id)!).catch(() => {});
      import('../lark/calendar.js').then(({ removeTaskCalendarEvent }) => removeTaskCalendarEvent(tasks.byId(task.id)!, '任务被放弃')).catch(() => {});
      await dmOwner(owner.id, 'text', `已放弃任务「${task.title}」，台账已更新`, `abort-${task.id}`).catch(() => {});
      bus.activity('task', `任务已放弃：${task.title}`, `by ${owner.name}`);
      return true;
    }
  }
  return false;
}

/** 启动恢复：进程重启时被打断的 running 任务 → 有草稿的转 reviewing，无草稿的回 todo */
export function recoverInterruptedRuns(): void {
  for (const t of tasks.all({ statuses: ['running'] })) {
    const draft = readDraft(t.ownerId, t.id);
    tasks.update(t.id, { status: draft?.trim() ? 'reviewing' : 'todo' });
    bus.activity('system', `恢复被打断的任务：${t.title}`, draft ? '已有草稿 → 待审阅' : '无草稿 → 待办');
  }
  bus.changed('task');
}

// ===== 到期前 24h 兜底触发（FR-C1）=====

export function startDueSoonScheduler(): void {
  setInterval(async () => {
    const soon = Date.now() + 24 * 3600_000;
    for (const t of tasks.all({ statuses: ['todo'] })) {
      if (!t.dueAt || t.canDo !== true) continue;
      if (new Date(t.dueAt).getTime() > soon || inFlight.has(t.id)) continue;
      // 上次执行失败的不自动重试（否则每 10 分钟无限烧模型），等本人点「重试」
      if (runs.latestOfTask(t.id)?.status === 'failed') continue;
      bus.activity('run', `到期前 24h 兜底触发：${t.title}`);
      startRun(t).catch(() => {});
    }
  }, 10 * 60_000);
}

import type { CardAction, Person, Task } from '@everyone/shared';
import { bus } from '../bus.js';
import { adapter } from '../context.js';
import { dmTargetOf } from '../lark/dm.js';
import { cardFeedback, updateCardOrNotify } from '../lark/feedback.js';
import { kv, pendingCards, persons, tasks } from '../store/repo.js';
import { syncTaskToBitable } from './bitable.js';
import * as cards from './cards.js';

/**
 * 主动进度确认（新功能 3）：
 * 未完成任务到期前 24h / 逾期时，Everyone 主动私信 owner 确认进度；
 * owner 的回应（已完成 / 顺利 / 有风险 + 原因）转告任务发起者；
 * owner 超过 4h 不回应 → 也告知发起者。
 */

const PRE_DUE_WINDOW_MS = 24 * 3600_000;
const NO_REPLY_NOTIFY_MS = 4 * 3600_000;
const REASON_WINDOW_MS = 30 * 60_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;

interface NudgeState {
  sentAt: string;
  phase: 'pre' | 'overdue';
  answered: boolean;
  verdict?: string;
}

const nudgeState = {
  get(taskId: string): NudgeState | null {
    return kv.getJson<NudgeState | null>(`nudge:state:${taskId}`, null);
  },
  set(taskId: string, s: NudgeState) {
    kv.setJson(`nudge:state:${taskId}`, s);
  },
};

export function startNudgeScheduler(): void {
  setInterval(() => {
    sweepNudges().catch((e) => bus.activity('system', '进度确认扫描异常', String(e).slice(0, 200)));
  }, SWEEP_INTERVAL_MS);
}

/**
 * 扫描一轮（调度器周期调用；smoke 直接调用断言）。
 * 只催 todo：running/reviewing 有分身链路自己的通知（失败卡/初稿卡），重复催会打架。
 */
export async function sweepNudges(now = Date.now()): Promise<void> {
  for (const t of tasks.all({ statuses: ['todo'] })) {
    if (!t.dueAt) continue;
    const due = new Date(t.dueAt).getTime();
    if (Number.isNaN(due)) continue;
    const phase: 'pre' | 'overdue' | null = now > due ? 'overdue' : due - now <= PRE_DUE_WINDOW_MS ? 'pre' : null;
    if (!phase) continue;

    const sentKey = `nudge:sent:${phase}:${t.id}`;
    if (!kv.get(sentKey)) {
      kv.set(sentKey, new Date(now).toISOString());
      await sendNudge(t, phase);
      continue;
    }

    // 已发未回应：超 4h 告知发起者（每任务每阶段一次）
    const st = nudgeState.get(t.id);
    if (st && !st.answered && now - new Date(st.sentAt).getTime() > NO_REPLY_NOTIFY_MS) {
      const noReplyKey = `nudge:noreply:${st.phase}:${t.id}`;
      if (!kv.get(noReplyKey)) {
        kv.set(noReplyKey, new Date(now).toISOString());
        const owner = persons.byId(t.ownerId);
        await notifyCreator(t, `⏰ 我${st.phase === 'overdue' ? '在任务过期后' : '在到期前'}问过 ${owner?.name ?? t.ownerId}「${t.title}」的进度，超过 4 小时没有回应。你可能需要人工跟进一下。`);
      }
    }
  }
}

async function sendNudge(task: Task, phase: 'pre' | 'overdue'): Promise<void> {
  const owner = persons.byId(task.ownerId);
  if (!owner) return;
  const creator = task.creatorId && task.creatorId !== task.ownerId ? persons.byId(task.creatorId) : null;
  const to = dmTargetOf(owner);
  if (!to) {
    bus.activity('task', `进度确认跳过：${owner.name} 是虚拟成员`, `${task.title}（${phase === 'overdue' ? '已逾期' : '24h 内到期'}）`);
    return;
  }
  const card = cards.progressNudgeCard(task, phase === 'overdue', creator?.name ?? null);
  const sent = await adapter().sendCard(to, card, `nudge-${phase}-${task.id}`);
  pendingCards.save(sent.msgId, 'nudge', { taskId: task.id });
  nudgeState.set(task.id, { sentAt: new Date().toISOString(), phase, answered: false });
  kv.set(`nudge:latest:${owner.id}`, task.id);
  bus.activity('task', `进度确认已私信 ${owner.name}（${phase === 'overdue' ? '已逾期' : '到期前 24h'}）`, task.title);
}

/** 把进度情况告知发起者；发起者不可达（虚拟成员）时落活动流 */
async function notifyCreator(task: Task, text: string): Promise<void> {
  if (!task.creatorId || task.creatorId === task.ownerId) return;
  const creator = persons.byId(task.creatorId);
  const to = dmTargetOf(creator);
  if (!to) {
    bus.activity('task', `发起人 ${creator?.name ?? task.creatorId} 是虚拟成员，进度通报落后台`, text.slice(0, 100));
    return;
  }
  await adapter().sendText(to, text, `nudge-notify-${task.id}-${Date.now()}`).catch((e) => {
    bus.activity('system', '进度通报发送失败', String(e).slice(0, 150));
  });
  bus.activity('send', `进度情况已通报发起人 ${creator?.name}`, text.slice(0, 80));
}

function markAnswered(taskId: string, verdict: string): void {
  const st = nudgeState.get(taskId);
  nudgeState.set(taskId, { ...(st ?? { sentAt: new Date().toISOString(), phase: 'pre' }), answered: true, verdict });
}

/** 进度确认卡动作：nudge_done / nudge_ok / nudge_risk（仅 owner 可操作） */
export async function handleNudgeCardAction(action: CardAction): Promise<boolean> {
  const taskId = action.value.task_id;
  if (!taskId) return false;
  const task = tasks.byId(taskId);
  if (!task) return false;
  const owner = persons.byId(task.ownerId);
  const operator = persons.byOpenId(action.operatorOpenId) ?? persons.byId(action.operatorOpenId);
  if (operator?.id !== task.ownerId) {
    await cardFeedback(action, `这张卡片只有负责人 ${owner?.name ?? '本人'} 能操作`);
    return true;
  }
  const ownerName = owner?.name ?? task.ownerId;
  const creatorName = task.creatorId ? persons.byId(task.creatorId)?.name : null;

  switch (action.actionId) {
    case 'nudge_done': {
      if (task.status === 'published' || task.status === 'cancelled') {
        await cardFeedback(action, `「${task.title}」已经是 ${task.status} 状态了`);
        return true;
      }
      tasks.update(task.id, { status: 'published' });
      bus.changed('task');
      syncTaskToBitable(tasks.byId(task.id)!).catch(() => {});
      markAnswered(task.id, '已完成');
      await updateCardOrNotify(action, cards.progressNudgeDoneCard(tasks.byId(task.id)!, '已完成 ✅'), `已记录：「${task.title}」完成`);
      bus.activity('task', `进度确认：${ownerName} 报告任务已完成`, task.title);
      await notifyCreator(task, `✅ 你${sourceVerb(task)}的任务「${task.title}」，${ownerName} 刚确认已完成。`);
      return true;
    }
    case 'nudge_ok': {
      markAnswered(task.id, '顺利推进中');
      await updateCardOrNotify(action, cards.progressNudgeDoneCard(task, '顺利推进中 🟢', creatorName ? `已转告发起人 ${creatorName}` : undefined), '已记录：顺利推进中');
      bus.activity('task', `进度确认：${ownerName} 报告顺利推进`, task.title);
      await notifyCreator(task, `🟢 你${sourceVerb(task)}的任务「${task.title}」，${ownerName} 确认正在顺利推进（截止 ${fmtDue(task.dueAt)}）。`);
      return true;
    }
    case 'nudge_risk': {
      markAnswered(task.id, '有风险');
      kv.setJson(`nudge:reason:${task.ownerId}`, { taskId: task.id, ts: new Date().toISOString() });
      await updateCardOrNotify(
        action,
        cards.progressNudgeDoneCard(task, '有风险 🟠', '直接回复一句原因/需要的支持，我会转告发起人'),
        '已记录：有风险。直接回复原因，我会转告发起人',
      );
      bus.activity('task', `进度确认：${ownerName} 报告有风险`, task.title);
      await notifyCreator(task, `🟠 你${sourceVerb(task)}的任务「${task.title}」，${ownerName} 反馈有风险/可能延期（原因 TA 补充后我会转给你）。`);
      return true;
    }
  }
  return false;
}

/** owner 点「有风险」后 30 分钟内的下一条私信 = 原因，转告发起者。返回 true 表示已消费该消息 */
export async function handleNudgeReasonText(sender: Person, text: string): Promise<boolean> {
  const waiting = kv.getJson<{ taskId: string; ts: string } | null>(`nudge:reason:${sender.id}`, null);
  if (!waiting) return false;
  kv.set(`nudge:reason:${sender.id}`, '');
  if (Date.now() - new Date(waiting.ts).getTime() > REASON_WINDOW_MS) return false;
  const task = tasks.byId(waiting.taskId);
  if (!task) return false;
  await notifyCreator(task, `🟠 「${task.title}」的风险原因，${sender.name} 说：「${text.slice(0, 300)}」`);
  const to = dmTargetOf(sender);
  if (to) {
    const hasCreator = task.creatorId && task.creatorId !== task.ownerId && dmTargetOf(persons.byId(task.creatorId));
    await adapter().sendText(to, hasCreator ? '收到，已把原因转告发起人' : '收到，已记录风险原因', `nudge-reason-ack-${task.id}`).catch(() => {});
  }
  bus.activity('task', `风险原因已记录${task.creatorId && task.creatorId !== task.ownerId ? '并转告发起人' : ''}`, text.slice(0, 80));
  return true;
}

/** 文字指令等价（私聊）：「已完成/完成」「顺利」「有风险/要延期/延期」→ 最近一张进度确认卡 */
export async function tryNudgeTextCommand(sender: Person, text: string): Promise<boolean> {
  const t = text.trim();
  const actionId = /^(已完成|完成)$/.test(t) ? 'nudge_done'
    : /^顺利$/.test(t) ? 'nudge_ok'
      : /^(有风险|要延期|延期)$/.test(t) ? 'nudge_risk'
        : null;
  if (!actionId) return false;
  const taskId = kv.get(`nudge:latest:${sender.id}`);
  if (!taskId) return false;
  const st = nudgeState.get(taskId);
  if (!st || st.answered) return false;
  const cardRef = pendingCards.findByPayloadValue('nudge', 'taskId', taskId);
  await handleNudgeCardAction({
    actionId,
    value: { action: actionId, task_id: taskId },
    operatorOpenId: sender.id,
    msgId: cardRef?.cardMsgId,
    ts: new Date().toISOString(),
  });
  return true;
}

function sourceVerb(task: Task): string {
  return task.source === 'meeting' ? '在会议里记下' : task.source === 'mention' ? '指派' : '关注';
}

function fmtDue(dueAt: string | null): string {
  if (!dueAt) return '未定';
  const d = new Date(dueAt);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

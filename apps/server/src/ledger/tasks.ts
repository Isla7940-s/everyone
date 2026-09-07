import type { CardAction, IncomingMessage, Task, TaskSource } from '@everyone/shared';
import { bus } from '../bus.js';
import { adapter } from '../context.js';
import { chatJson } from '../llm/client.js';
import { prompt } from '../prompts.js';
import { renderQuadrant } from '../render/quadrant.js';
import { renderSchedule } from '../render/schedule.js';
import { kv, pendingCards, persons, tasks } from '../store/repo.js';
import { cardFeedback, updateCardOrNotify } from '../lark/feedback.js';
import { syncTaskToBitable } from './bitable.js';
import * as cards from './cards.js';

/** 「修改」点击后等待此人下一条文字（kv 持久化，重启不丢等待态；空串=已清除） */
const pendingEdits = {
  set(openId: string, taskId: string) { kv.set(`pendingEdit:${openId}`, taskId); },
  get(openId: string): string | undefined { return kv.get(`pendingEdit:${openId}`) || undefined; },
  has(openId: string): boolean { return !!kv.get(`pendingEdit:${openId}`); },
  delete(openId: string) { kv.set(`pendingEdit:${openId}`, ''); },
};

// ===== 任务提出（S1 承诺 / S2 会议行动项 / @ 指派）=====

export async function proposeTask(args: {
  ownerId: string;
  title: string;
  source: TaskSource;
  important: boolean;
  urgent: boolean;
  dueAt: string | null;
  confidence: number;
  srcMsg: IncomingMessage;
  srcText: string;
}): Promise<Task> {
  const owner = persons.byId(args.ownerId);
  // 发起者 = 源消息发送者（说这句话/指派/粘会议记录的人）；进度确认结果会回告此人
  const creator = persons.byOpenId(args.srcMsg.senderOpenId) ?? persons.byId(args.srcMsg.senderOpenId);
  const task = tasks.create({
    ownerId: args.ownerId,
    creatorId: creator?.id ?? null,
    title: args.title,
    source: args.source,
    important: args.important,
    urgent: args.urgent,
    dueAt: args.dueAt,
    status: 'pending_confirm',
    confidence: args.confidence,
    srcMsgLink: args.srcMsg.msgLink ?? null,
    srcMsgId: args.srcMsg.msgId,
    chatId: args.srcMsg.chatId,
  });
  bus.activity('task', `新任务待确认：${task.title}`, `负责人 ${owner?.name ?? args.ownerId} · 来源 ${args.source} · 置信度 ${args.confidence.toFixed(2)}`);
  bus.changed('task');

  // 确认卡发群（回复源消息，上下文清晰；人工确认铁律 §6.0）
  const card = cards.taskConfirmCard(task, owner?.name ?? args.ownerId, args.srcText);
  const sent = await adapter().sendCard({ chatId: args.srcMsg.chatId }, card, `confirm-${task.id}`);
  pendingCards.save(sent.msgId, 'task_confirm', { taskId: task.id });
  return task;
}

// ===== 卡片动作 =====

export async function handleTaskCardAction(action: CardAction): Promise<boolean> {
  const t = action.value.task_id ? tasks.byId(action.value.task_id) : null;
  if (!t) return false;
  const owner = persons.byId(t.ownerId);
  const operator = persons.byOpenId(action.operatorOpenId) ?? persons.byId(action.operatorOpenId);

  const isOwner = operator?.id === t.ownerId;

  const notOwnerFeedback = async () => {
    bus.activity('task', `非负责人点击被拦截`, `${operator?.name ?? action.operatorOpenId} 点了 ${owner?.name} 的任务卡`);
    await cardFeedback(action, `这张卡片只有负责人 ${owner?.name ?? '本人'} 能操作`);
  };

  switch (action.actionId) {
    case 'task_confirm': {
      if (!isOwner) { await notOwnerFeedback(); return true; }
      if (t.status !== 'pending_confirm') {
        await cardFeedback(action, `「${t.title}」已经处理过了（当前状态：${t.status}），不用再点`);
        return true;
      }
      await confirmTask(t.id, action);
      return true;
    }
    case 'task_ignore': {
      if (!isOwner) { await notOwnerFeedback(); return true; }
      tasks.update(t.id, { status: 'cancelled' });
      bus.activity('task', `任务已忽略：${t.title}`, `by ${owner?.name}`);
      bus.changed('task');
      const { removeTaskCalendarEvent } = await import('../lark/calendar.js');
      removeTaskCalendarEvent(tasks.byId(t.id)!, '任务被忽略').catch(() => {});
      await updateCardOrNotify(action, cards.taskConfirmedCard(tasks.byId(t.id)!, owner?.name ?? '', '已忽略'), `已忽略「${t.title}」`);
      return true;
    }
    case 'task_edit': {
      if (!isOwner) { await notOwnerFeedback(); return true; }
      pendingEdits.set(action.operatorOpenId, t.id);
      await updateCardOrNotify(action, cards.taskConfirmedCard(t, owner?.name ?? '', '待修改'), `进入修改模式：「${t.title}」`);
      await adapter().sendText({ chatId: t.chatId ?? undefined }, `@${owner?.name} 直接回复文字修改任务「${t.title}」，比如：改到周六 / 负责人改成小红 / 不重要`, `edit-hint-${t.id}`);
      return true;
    }
    case 'run_retry': {
      if (!isOwner) { await notOwnerFeedback(); return true; }
      await cardFeedback(action, `收到，分身重新开工：「${t.title}」`);
      bus.emit('task:startRun', tasks.byId(t.id));
      return true;
    }
  }
  return false;
}

export async function confirmTask(taskId: string, action?: CardAction): Promise<void> {
  const t = tasks.byId(taskId);
  if (!t || t.status !== 'pending_confirm') return;
  tasks.update(taskId, { status: 'todo' });
  const task = tasks.byId(taskId)!;
  const owner = persons.byId(task.ownerId);
  bus.activity('task', `任务已确认入账：${task.title}`, `负责人 ${owner?.name} · 截止 ${task.dueAt ?? '未定'}`);
  bus.changed('task');

  // 卡片原地更新为已确认（更新失败也要让点击者看到结果——永不静默）
  if (action) {
    await updateCardOrNotify(action, cards.taskConfirmedCard(task, owner?.name ?? '', '已入台账'), `✅ 已确认入账：「${task.title}」`);
  }

  // Bitable 异步同步（FR-B4：失败重试，不阻塞主线）
  syncTaskToBitable(task).catch(() => {});

  // 排期同步飞书日程（新功能 4）：确认入账 = 用户接受任务 → 建日程（异步，不阻塞确认反馈）
  import('../lark/calendar.js').then(({ syncTaskCalendarEvent }) => syncTaskCalendarEvent(task)).catch(() => {});

  // S1：源消息下回复最新四象限图（新任务高亮）
  await sendQuadrantImage(task.ownerId, task.chatId, task.srcMsgId, task.id);

  // 触发能力自评 → 可能开工（executor 监听）
  bus.emit('task:confirmed', task);
}

// ===== 自然语言修改（「修改」按钮 → 下一条文字）=====

export function hasPendingEdit(openId: string): boolean {
  return pendingEdits.has(openId);
}

export async function applyTextEdit(openId: string, text: string): Promise<void> {
  const taskId = pendingEdits.get(openId);
  if (!taskId) return;
  pendingEdits.delete(openId);
  const t = tasks.byId(taskId);
  if (!t) return;

  const members = persons.all().map((p) => `${p.id}: ${p.name}`).join('\n');
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const localDate = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][today.getDay()];
  const patch = await chatJson<{ title?: string; owner_id?: string; due?: string | null; important?: boolean; urgent?: boolean }>(
    '你是任务修改指令解析器。根据用户的一句话，输出要修改的字段（不改的字段不要输出）。只输出 JSON，如 {"due": "2026-08-30T18:00:00+08:00"} 或 {"owner_id": "xiaohong"} 或 {"important": false}',
    `今天是 ${localDate}（${weekday}）。成员名单：\n${members}\n\n当前任务：${JSON.stringify({ title: t.title, owner_id: t.ownerId, due: t.dueAt, important: t.important, urgent: t.urgent })}\n\n修改指令："""${text}"""`,
    { fast: true },
  );

  tasks.update(taskId, {
    ...(patch.title ? { title: patch.title } : {}),
    ...(patch.owner_id ? { ownerId: patch.owner_id } : {}),
    ...(patch.due !== undefined ? { dueAt: patch.due } : {}),
    ...(patch.important !== undefined ? { important: patch.important } : {}),
    ...(patch.urgent !== undefined ? { urgent: patch.urgent } : {}),
  });
  // 修改后视为确认入账
  tasks.update(taskId, { status: 'todo' });
  const task = tasks.byId(taskId)!;
  const owner = persons.byId(task.ownerId);
  bus.activity('task', `任务已按意见修改并入账：${task.title}`, `负责人 ${owner?.name} · 截止 ${task.dueAt ?? '未定'}`);
  bus.changed('task');
  syncTaskToBitable(task).catch(() => {});
  // 修改后入账/改期 → 日程创建或更新（新功能 4）
  import('../lark/calendar.js').then(({ syncTaskCalendarEvent }) => syncTaskCalendarEvent(task)).catch(() => {});
  await adapter().sendText({ chatId: task.chatId ?? undefined }, `✅ 已更新：「${task.title}」负责人 ${owner?.name}，截止 ${fmtDue(task.dueAt)}，已入台账`, `edited-${task.id}`);
  await sendQuadrantImage(task.ownerId, task.chatId, task.srcMsgId, task.id);
  bus.emit('task:confirmed', task);
}

// ===== 四象限 / 排期图发送（FR-B7）=====

export async function sendQuadrantImage(ownerId: string, chatId: string | null, replyToMsgId?: string | null, highlightTaskId?: string): Promise<void> {
  const owner = persons.byId(ownerId);
  if (!owner) return;
  const png = renderQuadrant(owner.name, tasks.openTasksOf(ownerId), highlightTaskId);
  bus.activity('send', `渲染四象限图 → ${owner.name}`, png);
  try {
    if (replyToMsgId) await adapter().replyImage(replyToMsgId, png, `quad-${ownerId}-${Date.now()}`);
    else if (chatId) await adapter().sendImage({ chatId }, png, `quad-${ownerId}-${Date.now()}`);
  } catch (e) {
    bus.activity('system', '四象限图发送失败', String(e).slice(0, 200));
  }
}

export async function sendScheduleImage(chatId: string, ownerId?: string): Promise<void> {
  const list = ownerId ? tasks.openTasksOf(ownerId) : tasks.all({ statuses: ['todo', 'running', 'reviewing', 'published'] });
  const byId = new Map(persons.all().map((p) => [p.id, p]));
  const owner = ownerId ? persons.byId(ownerId) : null;
  const png = renderSchedule(owner ? `${owner.name}的排期` : '全群排期', list, byId);
  bus.activity('send', `渲染排期图 → ${owner?.name ?? '全群'}`, png);
  await adapter().sendImage({ chatId }, png, `sched-${Date.now()}`);
}

function fmtDue(dueAt: string | null): string {
  if (!dueAt) return '未定';
  const d = new Date(dueAt);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 承诺完成率（日报/大屏用） */
export function completionRate(): string {
  const all = tasks.all().filter((t) => t.status !== 'pending_confirm' && t.status !== 'cancelled');
  if (!all.length) return '—';
  const done = all.filter((t) => t.status === 'published').length;
  return `${done}/${all.length}（${Math.round((done / all.length) * 100)}%）`;
}

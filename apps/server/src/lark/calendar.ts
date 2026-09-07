import type { Task } from '@everyone/shared';
import { bus } from '../bus.js';
import { config } from '../config.js';
import { adapter } from '../context.js';
import { kv, persons, tasks } from '../store/repo.js';
import { dmTargetOf } from './dm.js';
import { LarkCliError } from './errors.js';
import { larkExec } from './exec.js';

/**
 * 排期同步飞书日程（新功能 4）：
 * 任务确认入账（点「确认」卡片 / 文字确认 / 修改后入账）→ 以 Everyone（bot）身份创建日程，
 * 把 owner 加为参与人 → 日程出现在 owner 的飞书日历；改期同步更新，忽略/放弃同步删除。
 * 唯一允许降级的点（发起人拍板）：日历 scope 未开通 → 探测出结果，给出补权限指引，其余功能不受影响。
 */

export const calendarState = {
  probed: false,
  available: false,
  calendarId: '',
  reason: '',
};

/** 启动探测：mock 直接可用；live 列日历拿 bot 主日历，缺权限时降级并给指引 */
export async function ensureCalendar(): Promise<void> {
  if (config.chatAdapter !== 'lark') {
    calendarState.probed = true;
    calendarState.available = true;
    calendarState.calendarId = 'mock-calendar';
    bus.activity('system', '日程同步就绪（mock 模拟通道）', '任务确认后将记录模拟日程');
    return;
  }
  try {
    const data = await larkExec<any>(['api', 'GET', '/open-apis/calendar/v4/calendars', '--params', JSON.stringify({ page_size: 50 }), '--as', 'bot']);
    const list: any[] = data?.calendar_list ?? data?.items ?? [];
    const primary = list.find((c) => c?.type === 'primary') ?? list.find((c) => c?.role === 'owner') ?? list[0];
    if (primary?.calendar_id) {
      calendarState.available = true;
      calendarState.calendarId = primary.calendar_id;
      bus.activity('system', '日程同步就绪（bot 主日历）', String(primary.calendar_id).slice(0, 40));
    } else {
      calendarState.available = false;
      calendarState.reason = '日历列表为空（bot 无主日历）';
      bus.activity('system', '日程同步不可用：bot 无可用日历', '任务照常入账，仅不建日程');
    }
  } catch (e) {
    calendarState.available = false;
    if (e instanceof LarkCliError && e.isMissingScope) {
      calendarState.reason = `日历 scope 未开通（calendar:calendar）`;
      remindScopeOnce(e.consoleUrl);
    } else {
      calendarState.reason = String(e).slice(0, 200);
      bus.activity('system', '日程同步探测失败（已降级，不影响主线）', calendarState.reason);
    }
  } finally {
    calendarState.probed = true;
  }
}

/**
 * 缺权限指引：活动流常提示，管理员私信只发一次（不刷屏）。
 * 实测（2026-08-28）：bot 报 app_scope_not_applied，信封自带 console_url 一键申请页；
 * 个人版租户点开勾选 calendar:calendar 即时生效，重启后自动转正。
 */
function remindScopeOnce(consoleUrl: string | null): void {
  const key = 'calendar:scope_hint';
  const hint = consoleUrl
    ? `打开一键申请页勾选日历权限（calendar:calendar）后重启即自动转正：${consoleUrl}`
    : '开放平台后台为应用开通 calendar:calendar 权限后重启即自动转正';
  bus.activity('system', '日程同步暂不可用：日历权限未开通（任务照常入账）', hint);
  kv.set(key, new Date().toISOString());
}

/** 任务是否具备建日程条件；返回 owner（live 需真实飞书账号） */
function eventTarget(task: Task): { ownerOpenId: string | null; ownerName: string } | null {
  const owner = persons.byId(task.ownerId);
  if (!owner) return null;
  if (config.chatAdapter === 'lark' && !owner.feishuOpenId) {
    bus.activity('task', `日程跳过：${owner.name} 是虚拟成员（无飞书日历）`, task.title);
    return null;
  }
  return { ownerOpenId: owner.feishuOpenId, ownerName: owner.name };
}

/**
 * 确认入账 / 改期后同步日程。
 * 日程块 = 截止前 1 小时 ~ 截止时刻（飞书会按用户的日历提醒设置提前提醒）。
 */
export async function syncTaskCalendarEvent(task: Task): Promise<void> {
  try {
    if (!task.dueAt) {
      if (task.calendarEventId) await removeTaskCalendarEvent(task, '截止时间被清除');
      return;
    }
    const due = new Date(task.dueAt).getTime();
    if (Number.isNaN(due) || due <= Date.now()) {
      bus.activity('task', '日程跳过：截止时间已过', `${task.title} · ${task.dueAt}`);
      return;
    }
    if (!calendarState.probed) await ensureCalendar();
    if (!calendarState.available) {
      bus.activity('task', '日程未创建（日历通道不可用）', `${task.title} · ${calendarState.reason}`);
      return;
    }
    const target = eventTarget(task);
    if (!target) return;

    const startSec = Math.floor((due - 3600_000) / 1000);
    const endSec = Math.floor(due / 1000);
    const summary = `⏰ 任务截止：${task.title}`;
    const description = [
      `来自 Everyone 的任务台账（负责人 ${target.ownerName}）`,
      task.srcMsgLink ? `源消息：${task.srcMsgLink}` : '',
      '完成后在与 Everyone 的私聊里回复「已完成」即可销账。',
    ].filter(Boolean).join('\n');

    if (config.chatAdapter !== 'lark') {
      // mock：走同一业务路径，日程落在任务字段 + 活动流（模拟器/工作台可见）
      const created = !task.calendarEventId;
      tasks.update(task.id, { calendarEventId: task.calendarEventId ?? `mock-ev-${task.id}` });
      bus.changed('task');
      bus.activity('task', created ? `📅 已创建飞书日程（模拟）` : `📅 日程已更新（模拟）`, `${task.title} · ${fmtRange(startSec, endSec)}`);
      await dmCalendarNotice(task, created);
      return;
    }

    if (task.calendarEventId) {
      // 改期：PATCH 同一日程
      await larkExec<any>([
        'api', 'PATCH', `/open-apis/calendar/v4/calendars/${calendarState.calendarId}/events/${task.calendarEventId}`,
        '--as', 'bot',
        '--data', JSON.stringify({ summary, start_time: { timestamp: String(startSec) }, end_time: { timestamp: String(endSec) } }),
      ]);
      bus.activity('task', '📅 飞书日程已随改期更新', `${task.title} · ${fmtRange(startSec, endSec)}`);
      await dmCalendarNotice(task, false);
      return;
    }

    const created = await larkExec<any>([
      'api', 'POST', `/open-apis/calendar/v4/calendars/${calendarState.calendarId}/events`,
      '--as', 'bot',
      '--data', JSON.stringify({
        summary,
        description,
        start_time: { timestamp: String(startSec) },
        end_time: { timestamp: String(endSec) },
        reminders: [{ minutes: 30 }],
      }),
    ]);
    const eventId = created?.event?.event_id ?? created?.event_id;
    if (!eventId) throw new Error(`创建日程未返回 event_id: ${JSON.stringify(created).slice(0, 200)}`);
    tasks.update(task.id, { calendarEventId: eventId });
    bus.changed('task');

    // 把 owner 加为参与人 → 日程出现在 TA 的日历
    if (target.ownerOpenId) {
      await larkExec<any>([
        'api', 'POST', `/open-apis/calendar/v4/calendars/${calendarState.calendarId}/events/${eventId}/attendees`,
        '--params', JSON.stringify({ user_id_type: 'open_id' }),
        '--as', 'bot',
        '--data', JSON.stringify({ attendees: [{ type: 'user', user_id: target.ownerOpenId }], need_notification: true }),
      ]);
    }
    bus.activity('task', '📅 已创建飞书日程并邀请负责人', `${task.title} · ${fmtRange(startSec, endSec)}`);
    await dmCalendarNotice(tasks.byId(task.id)!, true);
  } catch (e) {
    if (e instanceof LarkCliError && e.isMissingScope) {
      calendarState.available = false;
      calendarState.reason = '日历 scope 未开通（calendar:calendar）';
      remindScopeOnce(e.consoleUrl);
    } else {
      bus.activity('system', '日程同步失败（任务不受影响）', `${task.title} · ${String(e).slice(0, 150)}`);
    }
  }
}

/**
 * Agent 通用建日程（新需求 2e：把系统建日程能力开放给 MCP）。
 * 与任务日程共用 bot 主日历与降级逻辑；失败抛错（由 MCP 把原因带回给 Agent）。
 */
export async function createAgentCalendarEvent(args: {
  title: string;
  startMs: number;
  endMs: number;
  description?: string;
  attendeeOpenIds?: string[];
}): Promise<{ eventId: string; mock: boolean }> {
  if (!calendarState.probed) await ensureCalendar();
  if (!calendarState.available) {
    throw new Error(`日历通道不可用：${calendarState.reason || '未探测到可用日历'}`);
  }
  const startSec = Math.floor(args.startMs / 1000);
  const endSec = Math.floor(args.endMs / 1000);
  if (config.chatAdapter !== 'lark') {
    const eventId = `mock-ev-agent-${Date.now().toString(36)}`;
    bus.activity('task', `📅 Agent 创建日程（模拟）：${args.title}`, fmtRange(startSec, endSec));
    return { eventId, mock: true };
  }
  const created = await larkExec<any>([
    'api', 'POST', `/open-apis/calendar/v4/calendars/${calendarState.calendarId}/events`,
    '--as', 'bot',
    '--data', JSON.stringify({
      summary: args.title,
      ...(args.description ? { description: args.description } : {}),
      start_time: { timestamp: String(startSec) },
      end_time: { timestamp: String(endSec) },
      reminders: [{ minutes: 30 }],
    }),
  ]);
  const eventId = created?.event?.event_id ?? created?.event_id;
  if (!eventId) throw new Error(`创建日程未返回 event_id: ${JSON.stringify(created).slice(0, 200)}`);
  if (args.attendeeOpenIds?.length) {
    await larkExec<any>([
      'api', 'POST', `/open-apis/calendar/v4/calendars/${calendarState.calendarId}/events/${eventId}/attendees`,
      '--params', JSON.stringify({ user_id_type: 'open_id' }),
      '--as', 'bot',
      '--data', JSON.stringify({
        attendees: args.attendeeOpenIds.map((id) => ({ type: 'user', user_id: id })),
        need_notification: true,
      }),
    ]);
  }
  bus.activity('task', `📅 Agent 创建日程：${args.title}`, fmtRange(startSec, endSec));
  return { eventId, mock: false };
}

/** 任务忽略/放弃/取消时删除日程 */
export async function removeTaskCalendarEvent(task: Task, why: string): Promise<void> {
  if (!task.calendarEventId) return;
  try {
    if (config.chatAdapter === 'lark' && !task.calendarEventId.startsWith('mock-ev-')) {
      await larkExec<any>([
        'api', 'DELETE', `/open-apis/calendar/v4/calendars/${calendarState.calendarId}/events/${task.calendarEventId}`,
        '--as', 'bot',
      ]);
    }
    tasks.update(task.id, { calendarEventId: null });
    bus.changed('task');
    bus.activity('task', `📅 飞书日程已删除（${why}）`, task.title);
  } catch (e) {
    bus.activity('system', '日程删除失败（已忽略）', `${task.title} · ${String(e).slice(0, 120)}`);
  }
}

/** 私信 owner 日程已同步（创建时告知，改期低调提一句） */
async function dmCalendarNotice(task: Task, created: boolean): Promise<void> {
  const owner = persons.byId(task.ownerId);
  const to = dmTargetOf(owner);
  if (!to) return;
  const d = new Date(task.dueAt!);
  const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const mockTag = config.chatAdapter !== 'lark' ? '（模拟环境，真实模式会写进你的飞书日历）' : '';
  const text = created
    ? `📅 已把「${task.title}」同步到你的飞书日程：截止 ${when}，日历会提前提醒你${mockTag}`
    : `📅 「${task.title}」的日程已更新为截止 ${when}${mockTag}`;
  await adapter().sendText(to, text, `cal-${task.id}-${created ? 'c' : 'u'}-${task.dueAt}`).catch(() => {});
}

function fmtRange(startSec: number, endSec: number): string {
  const f = (s: number) => {
    const d = new Date(s * 1000);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  return `${f(startSec)} ~ ${f(endSec)}`;
}

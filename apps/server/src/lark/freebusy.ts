import type { Person } from '@everyone/shared';
import { bus } from '../bus.js';
import { config } from '../config.js';
import { kv } from '../store/repo.js';
import { LarkCliError } from './errors.js';
import { larkExec } from './exec.js';

/**
 * 日程忙闲感知（新需求 4）：
 * 分身替本人说话前先看一眼 TA 现在是否在会中（飞书 freebusy 只给忙碌区间，拿不到会议标题——需求已确认接受）。
 * - live：`POST /calendar/v4/freebusy/list`（bot 身份，2026-08-28 实测 ok）
 * - mock：kv `mock_busy:<personId>` 存忙碌截止时间（admin API / smoke 注入）
 * 查询失败一律返回 null（代答照发，只是不带开会提示），不阻断任何主链路。
 */

export interface BusyStatus {
  busy: boolean;
  /** 当前忙碌块的结束时间（ISO）；背靠背的连续会议合并成一个块 */
  until: string | null;
}

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; status: BusyStatus | null }>();
let scopeHinted = false;

export function clearBusyCache(personId?: string): void {
  if (personId) cache.delete(personId);
  else cache.clear();
}

export async function getBusyStatus(person: Person | null | undefined): Promise<BusyStatus | null> {
  if (!person) return null;
  const hit = cache.get(person.id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.status;
  let status: BusyStatus | null = null;
  try {
    status = await queryBusy(person);
  } catch (e) {
    if (e instanceof LarkCliError && e.isMissingScope && !scopeHinted) {
      scopeHinted = true;
      bus.activity('system', '忙闲查询缺权限（代答不带开会提示，其余不受影响）', e.consoleUrl ?? e.message.slice(0, 150));
    }
  }
  cache.set(person.id, { at: Date.now(), status });
  return status;
}

async function queryBusy(person: Person): Promise<BusyStatus | null> {
  if (config.chatAdapter !== 'lark') {
    const until = kv.get(`mock_busy:${person.id}`);
    if (!until) return { busy: false, until: null };
    return new Date(until).getTime() > Date.now()
      ? { busy: true, until: new Date(until).toISOString() }
      : { busy: false, until: null };
  }
  if (!person.feishuOpenId) return null; // 虚拟成员没有飞书日历

  const now = Date.now();
  const fmt = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const data = await larkExec<any>([
    'api', 'POST', '/open-apis/calendar/v4/freebusy/list',
    '--params', JSON.stringify({ user_id_type: 'open_id' }),
    '--as', 'bot',
    '--data', JSON.stringify({
      // 窗口从 1 分钟前开始：正在进行中的会议的 start_time 在过去
      time_min: fmt(now - 60_000),
      time_max: fmt(now + 12 * 3600_000),
      user_id: person.feishuOpenId,
    }),
  ], { timeoutMs: 15_000 });

  const ranges: Array<{ start: number; end: number }> = (data?.freebusy_list ?? [])
    .map((r: any) => ({ start: new Date(r.start_time).getTime(), end: new Date(r.end_time).getTime() }))
    .filter((r: { start: number; end: number }) => Number.isFinite(r.start) && Number.isFinite(r.end))
    .sort((a: { start: number }, b: { start: number }) => a.start - b.start);

  // 找覆盖当前时刻的忙碌块；背靠背/重叠的连续会议合并（「什么时候有空」比「这场会几点散」对提问者更有用）
  let until: number | null = null;
  for (const r of ranges) {
    if (until === null) {
      if (r.start <= now && now < r.end) until = r.end;
    } else if (r.start <= until + 5 * 60_000) {
      until = Math.max(until, r.end);
    } else {
      break;
    }
  }
  return until === null ? { busy: false, until: null } : { busy: true, until: new Date(until).toISOString() };
}

/** 「预计 15:30 结束」/ 跨天时「预计明天 09:00 结束」 */
export function fmtBusyUntil(untilIso: string): string {
  const d = new Date(untilIso);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const tomorrow = new Date(now.getTime() + 86400_000);
  if (d.toDateString() === tomorrow.toDateString()) return `明天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

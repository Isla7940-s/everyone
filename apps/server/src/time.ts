/**
 * 时间工具（七项需求 1：Agent 的时间概念）。
 * 原则：凡是喂给模型的信息都带本地时间戳；凡是唤醒模型的提示词都带「当前时间」。
 * 全部用本地时区格式化——不能用 toISOString（UTC 日期在凌晨与本地日期矛盾，会污染模型的时间判断）。
 */

const p = (n: number) => String(n).padStart(2, '0');

export const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** "2026-08-29 00:45"（本地时区，喂提示词用） */
export function nowStamp(d: Date = new Date()): string {
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "2026-08-29" */
export function todayStr(d: Date = new Date()): string {
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 提示词通用时间参数：{{today}} / {{weekday}} / {{now}} */
export function timeVars(): { today: string; weekday: string; now: string } {
  const d = new Date();
  return { today: todayStr(d), weekday: WEEKDAYS[d.getDay()], now: nowStamp(d) };
}

/**
 * 消息/事件时间戳的紧凑显示："08-28 23:56"；跨年时带年份。
 * 解析失败返回空串（上游拼接时自然消失，不投毒）。
 */
export function fmtStamp(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return sameYear ? md : `${d.getFullYear()}-${md}`;
}

/** 解析 "YYYY-MM-DD HH:mm"（本地时区）或 ISO；失败返回 NaN */
export function parseLocal(input: string): number {
  const s = (input ?? '').trim().replace(/\//g, '-');
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : new Date(s).getTime();
}

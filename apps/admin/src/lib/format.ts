import type { Task, TaskStatus } from '@everyone/shared';

/* ---------------- 时间 ---------------- */

export function fmtTime(ts: string): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtDate(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(ts)}`;
}

export function fmtDay(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 截止相对描述：今天 / 明天 / 已逾期 3 天 */
export function fmtDue(ts: string | null): { text: string; tone: Tone } {
  if (!ts) return { text: '未定截止', tone: 'gray' };
  const now = new Date();
  const due = new Date(ts);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(due) - startOf(now)) / 86_400_000);
  if (days < 0) return { text: `逾期 ${-days} 天`, tone: 'red' };
  if (days === 0) return { text: `今天 ${fmtTime(ts)}`, tone: 'orange' };
  if (days === 1) return { text: `明天 ${fmtTime(ts)}`, tone: 'orange' };
  if (days <= 7) return { text: `${days} 天后`, tone: 'blue' };
  return { text: fmtDay(ts), tone: 'gray' };
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return '还没睡';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

/* ---------------- 语义色 ---------------- */

export type Tone = 'blue' | 'green' | 'orange' | 'red' | 'purple' | 'cyan' | 'gray';

export const TONE_HEX: Record<Tone, string> = {
  blue: '#3370ff',
  green: '#34c724',
  orange: '#ff8800',
  red: '#f54a45',
  purple: '#7b67ee',
  cyan: '#14c0ff',
  gray: '#9a9aa8',
};

/* ---------------- 任务 ---------------- */

export const STATUS: Record<TaskStatus, { label: string; tone: Tone }> = {
  pending_confirm: { label: '待确认', tone: 'gray' },
  todo: { label: '待办', tone: 'blue' },
  running: { label: '分身进行中', tone: 'purple' },
  reviewing: { label: '待审阅', tone: 'orange' },
  published: { label: '已发布', tone: 'green' },
  cancelled: { label: '已取消', tone: 'gray' },
};

export function statusOf(s: string): { label: string; tone: Tone } {
  return STATUS[s as TaskStatus] ?? { label: s, tone: 'gray' };
}

/** 未完成（仍需要人或分身推进） */
export const OPEN_STATUS: TaskStatus[] = ['pending_confirm', 'todo', 'running', 'reviewing'];

export const isOpen = (t: Task) => OPEN_STATUS.includes(t.status);
export const isAlive = (t: Task) => t.status !== 'cancelled';

export const SOURCE_LABEL: Record<string, string> = {
  commitment: '群里的承诺',
  meeting: '会议行动项',
  mention: '@ 指派',
  manual: '手动创建',
};

export const SOURCE_SHORT: Record<string, string> = {
  commitment: '承诺',
  meeting: '会议',
  mention: '@指派',
  manual: '手动',
};

export const KIND_LABEL: Record<string, string> = {
  doc: '文档',
  code: '代码',
  data: '数据',
  other: '其他',
};

export const RUN_STATUS: Record<string, { label: string; tone: Tone }> = {
  running: { label: '进行中', tone: 'purple' },
  succeeded: { label: '成功', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
  timeout: { label: '超时', tone: 'orange' },
};

export const ASSIST_STATUS: Record<string, { label: string; tone: Tone }> = {
  notified: { label: '已私信', tone: 'blue' },
  acked: { label: '已知晓', tone: 'gray' },
  converted: { label: '已转任务', tone: 'green' },
  rejected: { label: '不归我管', tone: 'gray' },
  answered: { label: '已代答', tone: 'cyan' },
  corrected: { label: '待更正', tone: 'orange' },
  retracted: { label: '已撤回', tone: 'red' },
  skipped: { label: '待认领', tone: 'gray' },
};

/**
 * 产出文档链接。
 * 真实飞书文档是 http(s) 链接，新标签打开；
 * mock 文档由 server 生成为模拟器入口的相对链接，这里改走本应用自己的阅读页，
 * 免得产品前端把人甩到开发工具页面上去。
 */
export function docLink(t: { id: string; docUrl: string | null }): { href: string; external: boolean } | null {
  if (!t.docUrl) return null;
  if (/^https?:/i.test(t.docUrl)) return { href: t.docUrl, external: true };
  return { href: `#/doc/${t.id}`, external: false };
}

/* ---------------- 四象限 ---------------- */

export interface QuadSpec {
  key: 1 | 2 | 3 | 4;
  title: string;
  hint: string;
  important: boolean;
  urgent: boolean;
  color: string;
  bg: string;
}

export const QUADS: QuadSpec[] = [
  { key: 1, title: '重要 · 紧急', hint: '马上做', important: true, urgent: true, color: '#c2352f', bg: '#fdf1f0' },
  { key: 2, title: '重要 · 不紧急', hint: '排计划', important: true, urgent: false, color: '#245bdb', bg: '#f0f4ff' },
  { key: 3, title: '紧急 · 不重要', hint: '快速清', important: false, urgent: true, color: '#a85800', bg: '#fff6ea' },
  { key: 4, title: '不重要 · 不紧急', hint: '有空再说', important: false, urgent: false, color: '#54545f', bg: '#f1f1f4' },
];

export function quadrantOf(t: { important: boolean; urgent: boolean }): 1 | 2 | 3 | 4 {
  if (t.important && t.urgent) return 1;
  if (t.important) return 2;
  if (t.urgent) return 3;
  return 4;
}

export const quadSpecOf = (t: { important: boolean; urgent: boolean }) =>
  QUADS[quadrantOf(t) - 1];

/* ---------------- 活动流 ---------------- */

export const ACTIVITY: Record<string, { label: string; hex: string }> = {
  message: { label: '消息', hex: '#9a9aa8' },
  intent: { label: '意图', hex: '#3370ff' },
  task: { label: '任务', hex: '#34c724' },
  run: { label: '分身', hex: '#7b67ee' },
  send: { label: '发送', hex: '#ff8800' },
  review: { label: '评审', hex: '#eb5ab5' },
  assist: { label: '助理', hex: '#14c0ff' },
  digest: { label: '日报', hex: '#e0b400' },
  memory: { label: '记忆', hex: '#5e6ad2' },
  system: { label: '系统', hex: '#f54a45' },
};

/* ---------------- 杂项 ---------------- */

export const initial = (name: string) => (name || '?').trim().replace(/\s/g, '').slice(0, 1);

export const fileSize = (bytes: number) =>
  bytes < 1024 ? `${bytes}B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)}K` : `${(bytes / 1024 / 1024).toFixed(1)}M`;

/** <input type="date"> 需要本地时区的 yyyy-MM-dd */
export function toDateInput(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function toDateTimeInput(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return `${toDateInput(ts)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

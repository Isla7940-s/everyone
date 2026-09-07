import type { Person, Task } from '@everyone/shared';
import { clip, escapeXml, svgToPng } from './png.js';

const STATUS_COLOR: Record<string, string> = {
  pending_confirm: '#B0B5BC',
  todo: '#3370FF',
  running: '#7B67EE',
  reviewing: '#FF8800',
  published: '#34C724',
  cancelled: '#DEE0E3',
};
const STATUS_LABEL: Record<string, string> = {
  pending_confirm: '待确认', todo: '待办', running: '进行中', reviewing: '待审阅', published: '已发布', cancelled: '已取消',
};

/** 排期图（FR-B6）：横向 7 天甘特，行=任务，色块=状态 */
export function renderSchedule(title: string, tasks: Task[], personsById: Map<string, Person>): string {
  const open = tasks
    .filter((t) => t.status !== 'cancelled')
    .sort((a, b) => ((a.dueAt ?? '9999') < (b.dueAt ?? '9999') ? -1 : 1))
    .slice(0, 12);

  const days: Date[] = [];
  const start = new Date(); start.setHours(0, 0, 0, 0);
  for (let i = 0; i < 7; i++) { const d = new Date(start); d.setDate(start.getDate() + i); days.push(d); }
  const end = new Date(start); end.setDate(start.getDate() + 7);

  const W = 1080;
  const ROW_H = 44;
  const HEADER = 96;
  const LABEL_W = 260;
  const H = HEADER + Math.max(open.length, 1) * ROW_H + 64;
  const DAY_W = (W - LABEL_W - 40) / 7;

  const dayHeads = days.map((d, i) => {
    const isToday = i === 0;
    const x = LABEL_W + i * DAY_W;
    return `
    <g>
      ${isToday ? `<rect x="${x}" y="${HEADER - 30}" width="${DAY_W}" height="${H - HEADER - 34 + 30}" fill="#F0F4FF" rx="8"/>` : ''}
      <line x1="${x}" y1="${HEADER}" x2="${x}" y2="${H - 44}" stroke="#EFF0F1" stroke-width="1"/>
      <text x="${x + DAY_W / 2}" y="${HEADER - 10}" font-size="13" fill="${isToday ? '#3370FF' : '#8F959E'}" text-anchor="middle" font-weight="${isToday ? 700 : 400}">${d.getMonth() + 1}/${d.getDate()}${isToday ? ' 今天' : ''}</text>
    </g>`;
  }).join('');

  const rows = open.map((t, i) => {
    const y = HEADER + i * ROW_H;
    const color = STATUS_COLOR[t.status] ?? '#3370FF';
    const owner = personsById.get(t.ownerId)?.name ?? t.ownerId;
    // 色块：从今天（或创建日）到截止日
    let barStart = 0;
    let barEnd = 7;
    if (t.dueAt) {
      const due = new Date(t.dueAt);
      const offset = Math.floor((due.getTime() - start.getTime()) / 86400_000);
      barEnd = Math.min(Math.max(offset + 1, 1), 7);
    }
    const overdue = t.dueAt !== null && new Date(t.dueAt) < new Date() && t.status !== 'published';
    const bx = LABEL_W + barStart * DAY_W + 4;
    const bw = Math.max((barEnd - barStart) * DAY_W - 8, DAY_W * 0.4);
    return `
    <g>
      ${i % 2 === 1 ? `<rect x="20" y="${y}" width="${W - 40}" height="${ROW_H}" fill="#FAFBFC"/>` : ''}
      <text x="32" y="${y + ROW_H / 2 + 5}" font-size="15" fill="#1F2329">${clip(t.title, 18)}</text>
      <text x="${LABEL_W - 16}" y="${y + ROW_H / 2 + 5}" font-size="13" fill="#8F959E" text-anchor="end">${escapeXml(owner)}</text>
      <rect x="${bx}" y="${y + 9}" width="${bw}" height="${ROW_H - 18}" rx="7" fill="${color}" opacity="0.85"/>
      <text x="${bx + 10}" y="${y + ROW_H / 2 + 5}" font-size="12" fill="white" font-weight="500">${STATUS_LABEL[t.status] ?? t.status}${overdue ? ' · 已逾期' : ''}</text>
    </g>`;
  }).join('');

  const legend = Object.entries(STATUS_LABEL).filter(([k]) => k !== 'cancelled').map(([k, label], i) =>
    `<g><rect x="${32 + i * 110}" y="${H - 34}" width="12" height="12" rx="3" fill="${STATUS_COLOR[k]}"/><text x="${50 + i * 110}" y="${H - 23}" font-size="12" fill="#4E5460">${label}</text></g>`,
  ).join('');

  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="PingFang SC, Noto Sans SC, sans-serif">
  <rect width="${W}" height="${H}" fill="white"/>
  <text x="28" y="42" font-size="24" font-weight="700" fill="#1F2329">${escapeXml(title)}</text>
  <text x="${W - 28}" y="42" font-size="14" fill="#8F959E" text-anchor="end">Everyone · ${dateStr} · 未来 7 天</text>
  ${dayHeads}
  ${rows || `<text x="${LABEL_W + 20}" y="${HEADER + 40}" font-size="15" fill="#B0B5BC">暂无任务</text>`}
  ${legend}
</svg>`;

  return svgToPng(svg, `schedule-${Date.now()}.png`);
}

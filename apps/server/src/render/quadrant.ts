import type { Task } from '@everyone/shared';
import { quadrantOf } from '@everyone/shared';
import { clip, escapeXml, svgToPng } from './png.js';

const STATUS_LABEL: Record<string, string> = {
  pending_confirm: '待确认', todo: '待办', running: '分身进行中', reviewing: '待审阅', published: '已发布', cancelled: '已取消',
};

interface QuadrantSpec {
  key: 1 | 2 | 3 | 4;
  title: string;
  sub: string;
  color: string;
  bg: string;
  x: number;
  y: number;
}

const W = 960;
const H = 700;
const PAD = 28;
const HEADER = 84;
const GAP = 16;
const CELL_W = (W - PAD * 2 - GAP) / 2;
const CELL_H = (H - HEADER - PAD - GAP - 56) / 2;

const SPECS: QuadrantSpec[] = [
  { key: 1, title: '重要 · 紧急', sub: '马上做', color: '#F54A45', bg: '#FEF1F1', x: PAD, y: HEADER },
  { key: 2, title: '重要 · 不紧急', sub: '排计划', color: '#3370FF', bg: '#F0F4FF', x: PAD + CELL_W + GAP, y: HEADER },
  { key: 3, title: '紧急 · 不重要', sub: '找人做 / 快速清', color: '#FF8800', bg: '#FFF7EB', x: PAD, y: HEADER + CELL_H + GAP },
  { key: 4, title: '不重要 · 不紧急', sub: '有空再说', color: '#8F959E', bg: '#F5F6F7', x: PAD + CELL_W + GAP, y: HEADER + CELL_H + GAP },
];

function fmtDue(dueAt: string | null): string {
  if (!dueAt) return '';
  const d = new Date(dueAt);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 渲染某人的四象限图（FR-B5），highlightTaskId 高亮本次变更 */
export function renderQuadrant(personName: string, tasks: Task[], highlightTaskId?: string): string {
  const open = tasks.filter((t) => ['pending_confirm', 'todo', 'running', 'reviewing'].includes(t.status));
  const byQ = new Map<number, Task[]>([[1, []], [2, []], [3, []], [4, []]]);
  for (const t of open) byQ.get(quadrantOf(t))!.push(t);
  for (const list of byQ.values()) {
    list.sort((a, b) => (a.dueAt ?? '9999') < (b.dueAt ?? '9999') ? -1 : 1);
  }

  const now = new Date();
  const weekEnd = new Date(now); weekEnd.setDate(now.getDate() + (7 - now.getDay()) % 7 + 1);
  const stats = {
    todo: open.filter((t) => t.status === 'todo' || t.status === 'pending_confirm').length,
    running: open.filter((t) => t.status === 'running' || t.status === 'reviewing').length,
    dueThisWeek: open.filter((t) => t.dueAt && new Date(t.dueAt) <= weekEnd).length,
  };

  const cells = SPECS.map((spec) => {
    const list = byQ.get(spec.key)!;
    const shown = list.slice(0, 6);
    const overflow = list.length - shown.length;
    const items = shown.map((t, i) => {
      const y = spec.y + 66 + i * 34;
      const isHl = t.id === highlightTaskId;
      const due = fmtDue(t.dueAt);
      const running = t.status === 'running' || t.status === 'reviewing';
      return `
      <g>
        ${isHl ? `<rect x="${spec.x + 10}" y="${y - 21}" width="${CELL_W - 20}" height="30" rx="7" fill="white" stroke="${spec.color}" stroke-width="2"/>` : ''}
        <circle cx="${spec.x + 26}" cy="${y - 6}" r="4" fill="${spec.color}" opacity="${running ? 1 : 0.45}"/>
        <text x="${spec.x + 40}" y="${y}" font-size="16" fill="#1F2329" font-weight="${isHl ? 600 : 400}">${clip(t.title, 26)}</text>
        ${due ? `<text x="${spec.x + CELL_W - 18}" y="${y}" font-size="14" fill="${spec.color}" text-anchor="end" font-weight="500">${due}</text>` : ''}
        ${running ? `<text x="${spec.x + CELL_W - (due ? 70 : 18)}" y="${y}" font-size="12" fill="#7B67EE" text-anchor="end">分身进行中</text>` : ''}
      </g>`;
    }).join('');
    return `
    <g>
      <rect x="${spec.x}" y="${spec.y}" width="${CELL_W}" height="${CELL_H}" rx="14" fill="${spec.bg}"/>
      <rect x="${spec.x}" y="${spec.y}" width="4" height="${CELL_H}" rx="2" fill="${spec.color}" opacity="0.9"/>
      <text x="${spec.x + 18}" y="${spec.y + 32}" font-size="18" font-weight="600" fill="${spec.color}">${spec.title}</text>
      <text x="${spec.x + CELL_W - 16}" y="${spec.y + 32}" font-size="13" fill="#8F959E" text-anchor="end">${spec.sub}</text>
      ${items || `<text x="${spec.x + 18}" y="${spec.y + 70}" font-size="14" fill="#B0B5BC">暂无任务</text>`}
      ${overflow > 0 ? `<text x="${spec.x + 18}" y="${spec.y + CELL_H - 14}" font-size="13" fill="${spec.color}">+${overflow} 项未展示</text>` : ''}
    </g>`;
  }).join('');

  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="PingFang SC, Noto Sans SC, sans-serif">
  <rect width="${W}" height="${H}" fill="white"/>
  <text x="${PAD}" y="44" font-size="26" font-weight="700" fill="#1F2329">${escapeXml(personName)}的四象限</text>
  <text x="${W - PAD}" y="44" font-size="14" fill="#8F959E" text-anchor="end">Everyone · ${dateStr}</text>
  <text x="${PAD}" y="68" font-size="13" fill="#8F959E">横轴：紧急程度　纵轴：重要程度　○ 待办　● 进行中</text>
  ${cells}
  <g>
    <rect x="${PAD}" y="${H - 52}" width="${W - PAD * 2}" height="36" rx="10" fill="#F5F6F7"/>
    <text x="${PAD + 16}" y="${H - 28}" font-size="14" fill="#4E5460">待办 <tspan font-weight="700" fill="#3370FF">${stats.todo}</tspan>　进行中 <tspan font-weight="700" fill="#7B67EE">${stats.running}</tspan>　本周到期 <tspan font-weight="700" fill="#F54A45">${stats.dueThisWeek}</tspan></text>
    <text x="${W - PAD - 16}" y="${H - 28}" font-size="13" fill="#B0B5BC" text-anchor="end">每个人的分身，替每个人做事</text>
  </g>
</svg>`;

  return svgToPng(svg, `quadrant-${Date.now()}.png`);
}

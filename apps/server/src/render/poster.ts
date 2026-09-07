import { clip, escapeXml, svgToPng } from './png.js';

/**
 * 日报海报（发起人 2026-08-28 需求⑤，二稿）：
 * 参考 wechat-daily-report 的黑金长图风格——600px 窄幅、暖黑底、金色标题、
 * 徽章 + 当日标题 + 三格统计 + 编号分节（人名染金）+ 今日金句 + 页脚，长度随内容自适应。
 * SVG 内不用 emoji（resvg 渲染不了彩色 emoji）。
 */

// ===== 黑金配色（与参考模板同族）=====
const C = {
  bg: '#161209',
  card: '#1F1A0E',
  gold: '#E9C675', // 大标题 / 统计数字
  goldDim: '#C9A44D', // 键名 / 强调
  ink: '#E8E2D2', // 主文本
  body: '#CFC8B4', // 条目文本
  faint: '#8A8168', // 次要说明
  line: '#3D3520', // 分隔线 / 边框
  footer: '#6E6650',
  badge: '#A8332A',
  badgeText: '#F5E6C8',
};

const W = 640;
const PAD = 38; // 页边距
const CW = W - PAD * 2; // 内容宽

export interface DigestPosterData {
  title?: string;
  key_decisions: string[];
  new_commitments: string[];
  avatar_done?: string[];
  unanswered_mentions: string[];
  due_tomorrow: string[];
  fun_moments: string[];
  stats?: { messages: number; newTasks: number; avatarDone: number };
}

interface Section {
  title: string;
  items: string[];
}

/** 条目「人名：内容」把人名染金（参考模板的 k/v 行） */
function itemText(x: number, y: number, raw: string, maxW: number): string {
  const m = raw.match(/^(@?[\u4e00-\u9fa5A-Za-z0-9_]{1,6})(：|: )(.+)$/);
  if (m) {
    return `<text x="${x}" y="${y}" font-size="16" fill="${C.body}"><tspan fill="${C.goldDim}">${escapeXml(m[1])}</tspan><tspan fill="${C.faint}"> · </tspan>${clip(m[3], maxW - m[1].length * 2 - 3)}</text>`;
  }
  return `<text x="${x}" y="${y}" font-size="16" fill="${C.body}">${clip(raw, maxW)}</text>`;
}

export function renderDigestPoster(data: DigestPosterData, completionRate: string, now = new Date()): string {
  const sections: Section[] = [
    { title: '关键决策', items: data.key_decisions ?? [] },
    { title: '新增承诺', items: data.new_commitments ?? [] },
    { title: '分身今日完成', items: data.avatar_done ?? [] },
    { title: '被 @ 未回应', items: data.unanswered_mentions ?? [] },
    { title: '明日到期', items: data.due_tomorrow ?? [] },
  ].map((s) => ({ ...s, items: s.items.filter((i) => i && i.trim()).slice(0, 6) }))
    .filter((s) => s.items.length > 0);
  const quotes = (data.fun_moments ?? []).filter((i) => i && i.trim()).slice(0, 2);
  const stats = data.stats ?? { messages: 0, newTasks: 0, avatarDone: 0 };

  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  const dateCn = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 · ${weekday}`;
  const dateShort = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const title = (data.title ?? '').trim() || '今日群导读';

  // ===== 逐块拼装（y 游标向下走，长度自适应）=====
  const parts: string[] = [];
  let y = 0;

  // 顶栏：徽章 + slogan
  y = 46;
  parts.push(`
  <rect x="${PAD}" y="${y - 22}" width="128" height="30" rx="4" fill="${C.badge}"/>
  <text x="${PAD + 64}" y="${y - 1}" font-size="15" fill="${C.badgeText}" text-anchor="middle" letter-spacing="3">EVERYONE</text>
  <text x="${W - PAD}" y="${y - 3}" font-size="14" fill="${C.faint}" text-anchor="end">今日群导读</text>`);

  // 大标题（当日头条）+ 日期
  y += 62;
  parts.push(`<text x="${PAD}" y="${y}" font-size="36" font-weight="700" fill="${C.gold}" letter-spacing="2">${clip(title, 30)}</text>`);
  y += 30;
  parts.push(`<text x="${PAD}" y="${y}" font-size="15" fill="${C.faint}">${escapeXml(dateCn)}</text>`);

  // 三格统计
  y += 26;
  const gap = 13;
  const cellW = (CW - gap * 2) / 3;
  const statDefs = [
    { n: stats.messages, label: '条消息' },
    { n: stats.newTasks, label: '个新任务' },
    { n: stats.avatarDone, label: '项分身完成' },
  ];
  statDefs.forEach((s, i) => {
    const x = PAD + i * (cellW + gap);
    parts.push(`
    <rect x="${x}" y="${y}" width="${cellW}" height="76" rx="10" fill="none" stroke="${C.line}"/>
    <text x="${x + cellW / 2}" y="${y + 40}" font-size="30" font-weight="600" fill="${C.gold}" text-anchor="middle">${s.n}</text>
    <text x="${x + cellW / 2}" y="${y + 62}" font-size="13" fill="${C.faint}" text-anchor="middle">${s.label}</text>`);
  });
  y += 76;

  // 分节（编号 + 金题 + 条目，人名染金）
  const CIRCLED = ['①', '②', '③', '④', '⑤'];
  sections.forEach((s, idx) => {
    y += 30;
    parts.push(`<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="${C.line}" stroke-width="1"/>`);
    y += 34;
    parts.push(`
    <text x="${PAD}" y="${y}" font-size="20" font-weight="600" fill="${C.ink}"><tspan fill="${C.goldDim}">${CIRCLED[idx] ?? '·'}</tspan>  ${escapeXml(s.title)}</text>
    <text x="${W - PAD}" y="${y - 1}" font-size="13" fill="${C.faint}" text-anchor="end">${s.items.length} 条</text>`);
    y += 10;
    for (const it of s.items) {
      y += 29;
      parts.push(itemText(PAD + 2, y, it, 62));
    }
  });

  // 今日金句（居中引用块）
  if (quotes.length) {
    y += 34;
    parts.push(`<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="${C.line}" stroke-width="1"/>`);
    y += 40;
    parts.push(`<text x="${W / 2}" y="${y}" font-size="16" fill="${C.goldDim}" text-anchor="middle" letter-spacing="9">今 日 金 句</text>`);
    for (const q of quotes) {
      const m = q.match(/^(.*?)\s*(——|--|—)\s*(.+)$/);
      const line = m ? m[1].replace(/^[「『"]|[」』"]$/g, '') : q;
      const by = m ? m[3] : '';
      y += 34;
      parts.push(`<text x="${W / 2}" y="${y}" font-size="16.5" fill="${C.ink}" text-anchor="middle">「${clip(line, 56)}」</text>`);
      if (by) {
        y += 23;
        parts.push(`<text x="${W / 2}" y="${y}" font-size="13" fill="${C.faint}" text-anchor="middle">—— ${clip(by, 20)}</text>`);
      }
    }
  }

  // 空日兜底
  if (!sections.length && !quotes.length) {
    y += 46;
    parts.push(`<text x="${W / 2}" y="${y}" font-size="16" fill="${C.faint}" text-anchor="middle">今天群里静悄悄，没有需要回看的大事</text>`);
  }

  // 页脚
  y += 40;
  parts.push(`<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="${C.line}" stroke-width="1"/>`);
  y += 26;
  parts.push(`
  <text x="${PAD}" y="${y}" font-size="13" fill="${C.footer}">Everyone · 每个人的分身，替每个人做事</text>
  <text x="${W - PAD}" y="${y}" font-size="13" fill="${C.footer}" text-anchor="end">${escapeXml(dateShort)} · 完成率 ${escapeXml(completionRate)}</text>`);
  y += 26;

  const H = y;
  const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="PingFang SC, Noto Sans SC, sans-serif">
  <rect width="${W}" height="${H}" fill="${C.bg}"/>
  ${parts.join('\n')}
</svg>`;

  return svgToPng(svg, `digest-poster-${Date.now()}.png`);
}

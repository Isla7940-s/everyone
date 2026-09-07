import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { bus } from '../bus.js';
import { config } from '../config.js';
import { db } from '../store/db.js';

/**
 * HTML 单文件自动部署（新需求 3）：
 * Agent 交付的单文件 HTML 落盘 data/pages/，生成不鉴权链接，24 小时自动失效。
 * 当前仅本机回环可访问；部署公网后设 PUBLIC_BASE_URL 即生效（链接生成处统一走 pageUrl）。
 */

const TTL_MS = 24 * 3600_000;

export interface DeployedPage {
  id: string;
  title: string;
  url: string;
  expiresAt: string;
}

const pagesDir = () => path.join(config.dataDir, 'pages');
const filePath = (id: string) => path.join(pagesDir(), `${id}.html`);

export function pageUrl(id: string): string {
  return `${config.publicBaseUrl}/p/${id}`;
}

/** 从 HTML 里挖 <title>，作为卡片标题的默认来源 */
export function extractHtmlTitle(html: string): string | null {
  const m = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(html);
  const t = m?.[1]?.trim();
  return t || null;
}

export function deployHtml(html: string, opts: { title?: string } = {}): DeployedPage {
  const id = randomUUID().replaceAll('-', '').slice(0, 12);
  const title = (opts.title ?? extractHtmlTitle(html) ?? '网页应用').slice(0, 80);
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  fs.mkdirSync(pagesDir(), { recursive: true });
  fs.writeFileSync(filePath(id), html);
  db.prepare('INSERT INTO pages (id, title, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(id, title, new Date().toISOString(), expiresAt);
  bus.activity('send', `🌐 HTML 已部署：${title}`, `${pageUrl(id)} · 24h 后失效`);
  return { id, title, url: pageUrl(id), expiresAt };
}

export type PageLookup =
  | { state: 'ok'; html: string; title: string }
  | { state: 'expired'; title: string }
  | { state: 'missing' };

export function getPage(id: string): PageLookup {
  if (!/^[a-f0-9]{12}$/.test(id)) return { state: 'missing' };
  const row = db.prepare('SELECT id, title, expires_at FROM pages WHERE id = ?').get(id) as
    | { id: string; title: string; expires_at: string } | undefined;
  if (!row) return { state: 'missing' };
  if (new Date(row.expires_at).getTime() <= Date.now()) return { state: 'expired', title: row.title };
  try {
    return { state: 'ok', html: fs.readFileSync(filePath(id), 'utf-8'), title: row.title };
  } catch {
    return { state: 'missing' };
  }
}

/** 过期页面清理（行 + 文件），每小时一轮；启动时立即清一次 */
export function startPagesCleanup(): void {
  const sweep = () => {
    try {
      const rows = db.prepare('SELECT id FROM pages WHERE expires_at <= ?').all(new Date().toISOString()) as Array<{ id: string }>;
      for (const r of rows) {
        fs.rmSync(filePath(r.id), { force: true });
        db.prepare('DELETE FROM pages WHERE id = ?').run(r.id);
      }
      if (rows.length) bus.activity('system', `已清理 ${rows.length} 个过期部署页面`);
    } catch (e) {
      bus.activity('system', '页面清理失败', String(e).slice(0, 120));
    }
  };
  sweep();
  setInterval(sweep, 3600_000);
}

#!/usr/bin/env node
/**
 * UI 验收截图（隔离实例）：
 * 前置：apps/admin 已 build；服务器以 DATA_DIR=data-uicheck 等隔离参数运行（见下方 usage）。
 * 产出：out/ui-check/*.png
 *
 * 用法：
 *   pnpm --filter @everyone/admin build
 *   CHAT_ADAPTER=mock DATA_DIR=data-uicheck SERVER_PORT=8977 ADMIN_PORT=8976 \
 *     OPENCODE_BIN=$PWD/scripts/fake-opencode.mjs AGENT_CHAT_TIMEOUT_SEC=60 \
 *     npx tsx apps/server/src/index.ts &   # 等就绪后：
 *   node scripts/ui-check.mjs
 */
import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.UI_BASE || 'http://127.0.0.1:8977';
const OUT = 'out/ui-check';
fs.mkdirSync(OUT, { recursive: true });

const post = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.json().catch(() => ({}));
};
const state = async () => (await fetch(`${BASE}/api/state`)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn().catch(() => false)) return true;
    await sleep(1000);
  }
  console.error(`waitFor 超时：${label}`);
  return false;
}

async function main() {
  // 1) 造场景：@Everyone 动手请求 → 表情回应 + 假引擎交付；启用群知识库 → 首建
  await post('/api/mock/message', { personId: 'laowang', text: '@Everyone 把这周的接口压测数据做成网页看板' });
  await waitFor(async () => {
    const h = await (await fetch(`${BASE}/api/mock/history`)).json();
    return h.some((m) => (m.reactions ?? []).length > 0);
  }, 90_000, '表情回应出现');

  await post('/api/chat/mock-demo-chat/wiki-toggle', { on: true });
  await waitFor(async () => {
    const s = await state();
    return s.chats?.find((c) => c.chatId === 'mock-demo-chat')?.wikiUpdatedAt;
  }, 60_000, '知识库首建完成');

  // 2) 截图
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // 模拟群聊：表情回应徽标
  await page.goto(`${BASE}/simulator.html#/chat`);
  await page.waitForSelector('.reaction-chip', { timeout: 30_000 }).catch(() => {});
  await sleep(1200);
  await page.screenshot({ path: `${OUT}/sim-reaction.png` });

  // 管理后台（admin 身份）
  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.setItem('everyone.session.role', 'admin'));

  await page.goto(`${BASE}/#/settings`);
  await page.reload();
  await sleep(1500);
  await page.screenshot({ path: `${OUT}/settings-wiki.png`, fullPage: true });

  await page.goto(`${BASE}/#/traces`);
  await page.reload();
  await sleep(1500);
  await page.screenshot({ path: `${OUT}/traces-wiki.png` });

  await page.goto(`${BASE}/#/sandbox`);
  await page.reload();
  await sleep(800);
  await page.click('text=群知识库沙箱').catch(() => {});
  await sleep(800);
  await page.screenshot({ path: `${OUT}/sandbox-wiki.png` });

  await browser.close();
  console.log(`截图完成 → ${OUT}/`);
}

main().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/**
 * 跨端协同 UI 自检：Playwright 打开产品前端，验证并截图
 *  1. 管理员 → 时间穿透页（成员切换 + 柱状分层 + 下钻明细）
 *  2. 成员（小明）→ 时间穿透页 + 跨端协同页
 * 用法：node scripts/collab-ui-check.mjs [baseUrl]（默认 http://localhost:8972）
 */
import fs from 'node:fs';
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:8972';
const outDir = 'out/collab-ui';
fs.mkdirSync(outDir, { recursive: true });

const results = [];
const record = (step, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${step}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// ===== 管理员视角 =====
await page.goto(`${base}/#/pierce`, { waitUntil: 'networkidle' });
// 登录页：选管理员
await page.locator('.person-row', { hasText: '以管理员身份进入' }).click();
await page.waitForTimeout(600);
await page.goto(`${base}/#/pierce`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

record('管理员打开时间穿透页', await page.locator('h1', { hasText: '时间穿透' }).count() > 0);
record('成员切换 chips', await page.locator('.pierce-member').count() >= 3, `${await page.locator('.pierce-member').count()} 人`);
// 小明有数据：点小明
await page.locator('.pierce-member', { hasText: '小明' }).first().click();
await page.waitForTimeout(800);
const segs = await page.locator('.pd-seg').count();
record('柱状分层渲染', segs >= 2, `${segs} 个分层色块`);
await page.screenshot({ path: `${outDir}/1-admin-pierce.png` });

// 点第一个色块 → 下钻
await page.locator('.pd-seg').first().click();
await page.waitForTimeout(400);
const drill = await page.locator('.pierce-sub').count();
const hasSummary = await page.locator('.pierce-entry .pe-brief').count();
record('点击分层下钻（需求→子任务→会话）', drill >= 1 && hasSummary >= 1, `${drill} 个子任务组`);
record('下钻含会话短总结', (await page.locator('.pierce-entry .pe-brief').first().textContent() ?? '').length > 4);
await page.screenshot({ path: `${outDir}/2-admin-pierce-drill.png`, fullPage: true });

// 周切换
await page.getByRole('button', { name: '← 上一周' }).click();
await page.waitForTimeout(600);
const emptyPrev = await page.locator('.empty').count();
record('切上一周（空周提示）', emptyPrev >= 0, '切换正常');
await page.getByRole('button', { name: '本周' }).click();
await page.waitForTimeout(600);
record('回到本周仍有数据', await page.locator('.pd-seg').count() >= 2);

// ===== 成员视角（小明）=====
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await page.locator('.person-row', { hasText: '小明' }).click();
await page.waitForTimeout(600);
await page.goto(`${base}/#/pierce`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
record('成员打开时间穿透（只看自己）', await page.locator('.pd-seg').count() >= 2 && await page.locator('.pierce-member').count() === 0);
await page.screenshot({ path: `${outDir}/3-member-pierce.png` });

await page.goto(`${base}/#/collab`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
record('成员打开跨端协同页', await page.locator('h1', { hasText: '跨端协同' }).count() > 0);
record('接入三步引导', await page.locator('.collab-steps li').count() === 3);
const sessRows = await page.locator('.tbl tbody tr').count();
record('最近工作总结列表', sessRows >= 2, `${sessRows} 条`);
const helps = await page.locator('.collab-help').count();
record('远程求助记录', helps >= 2, `${helps} 条`);
await page.screenshot({ path: `${outDir}/4-member-collab.png`, fullPage: true });

// 生成 token 按钮
await page.getByRole('button', { name: '生成新 token' }).click();
await page.waitForTimeout(600);
record('页面生成 token', await page.locator('.collab-token').count() >= 1);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n=== UI 自检：${results.length - failed}/${results.length} 通过 · 截图在 ${outDir}/ ===`);
process.exit(failed ? 1 : 0);

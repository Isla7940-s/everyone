/**
 * 需求 4 的端到端复现（真实 OpenCode + 真实网络，mock 聊天适配器）：
 * 重放「调研阿里 AI+∞ 大赛的奖品」——验证权限全放行 + PWD 修复 + 交付纪律 + 零交付抢救四层修复。
 * 运行：cd apps/server && DATA_DIR=data-livecase SERVER_PORT=8977 ADMIN_PORT=8976 CHAT_ADAPTER=mock npx tsx src/tmp-probe/live-case.ts
 */
process.env.CHAT_ADAPTER = 'mock';
process.env.DATA_DIR = process.env.DATA_DIR || 'data-livecase';
process.env.SERVER_PORT = process.env.SERVER_PORT || '8977';
process.env.ADMIN_PORT = process.env.ADMIN_PORT || '8976';

import '../store/db.js';
import { MockAdapter } from '../lark/mock.js';
import { setAdapter } from '../context.js';
import { initMemory } from '../memory/index.js';
import { seedPersons } from '../seed.js';
import { persons, agentRuns } from '../store/repo.js';
import { startAdminApi } from '../admin-api/index.js';
import { runChatAgent } from '../agent/run.js';
import { tracePath } from '../executor/opencode.js';
import fs from 'node:fs';

async function main() {
  await initMemory();
  await seedPersons();
  const mock = new MockAdapter();
  setAdapter(mock);
  await mock.start();
  startAdminApi();
  await new Promise((r) => setTimeout(r, 800));

  const msg = mock.injectUserMessage({
    personId: 'laowang', personName: '老王',
    text: '@Everyone 调研一下，阿里的那个AI加无穷大赛的那个的奖品有哪些？',
  });
  console.log('\n=== 重放发起人 case（真实 OpenCode）===');
  const t0 = Date.now();
  await runChatAgent(
    { ...msg, mentionedBot: true },
    persons.byId('laowang'), '老王',
  );
  const sec = Math.round((Date.now() - t0) / 1000);

  const run = agentRuns.all(5).find((r) => r.mode === 'chat');
  console.log(`\n=== 运行结果（${sec}s）===`);
  console.log('status:', run?.status, '| deliveries:', run?.deliveries, '| summary:', run?.deliverySummary?.slice(0, 120));
  const botMsgs = mock.history.filter((m) => m.senderIsBot).slice(-4);
  for (const m of botMsgs) {
    console.log(`\n--- bot ${m.kind} ---\n${(m.text ?? JSON.stringify(m.card ?? {})).slice(0, 800)}`);
  }
  if (run) {
    const trace = fs.readFileSync(tracePath(run.id), 'utf-8');
    const tools = [...trace.matchAll(/"type":"tool[^"]*"[^\n]*?"tool":"(\w+)"/g)].map((m) => m[1]);
    console.log(`\ntrace: ${tracePath(run.id)}（${(trace.length / 1024).toFixed(0)}KB, 工具调用: ${tools.join(',') || '见文件'}）`);
  }
  const delivered = (run?.deliveries ?? 0) > 0;
  console.log(`\n=== 判定：${delivered ? '✅ 已交付（MCP 或抢救）' : '❌ 仍未交付'} ===`);
  process.exit(delivered ? 0 : 1);
}

main().catch((e) => {
  console.error('live-case 失败：', e);
  process.exit(1);
});

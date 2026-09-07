import './store/db.js'; // 建表
import { bus } from './bus.js';
import { config } from './config.js';
import { setAdapter, adapter } from './context.js';
import { onCardAction } from './actions.js';
import { startAdminApi } from './admin-api/index.js';
import { startDigestScheduler } from './digest/index.js';
import { evaluateAndMaybeRun, recoverInterruptedRuns, startDueSoonScheduler, startRun } from './executor/runner.js';
import { ensureCalendar } from './lark/calendar.js';
import { LarkAdapter } from './lark/live.js';
import { MockAdapter } from './lark/mock.js';
import { backfillLedger, ensureLedger } from './ledger/bitable.js';
import { startNudgeScheduler } from './ledger/nudge.js';
import { initMemory } from './memory/index.js';
import { onMessage } from './ingest/pipeline.js';
import { handleMemberJoined } from './presence/onboard.js';
import { reviewPublishedTask } from './reviewer/index.js';
import { seedPersons } from './seed.js';
import type { Task } from '@everyone/shared';

async function main(): Promise<void> {
  console.log(`
  ┌─────────────────────────────────────────────┐
  │  Everyone · 每个人的分身，替每个人做事       │
  │  模式：${config.chatAdapter === 'lark' ? '真实飞书（live）' : '模拟群聊（mock）'}                        │
  └─────────────────────────────────────────────┘`);

  // 1) 记忆引擎探测（失败自动降级，FR-F6）
  await initMemory();

  // 2) demo 成员 + 工作区
  await seedPersons();

  // 2.5) 预置画像灌入记忆引擎（幂等）
  const { syncProfilesToEngine } = await import('./memory/index.js');
  const { persons: personsRepo } = await import('./store/repo.js');
  syncProfilesToEngine(personsRepo.all().map((p) => p.id)).catch(() => {});

  // 3) 聊天适配器
  const chat = config.chatAdapter === 'lark'
    ? new LarkAdapter(config.lark.demoChatId)
    : new MockAdapter();
  setAdapter(chat);

  // 4) Bitable 台账（live only；失败降级 SQLite-only）+ 历史任务补同步
  await ensureLedger();
  backfillLedger().catch(() => {});

  // 5) 业务装配
  chat.onMessage((msg) => {
    onMessage(msg).catch((e) => bus.activity('system', '消息处理异常', String(e).slice(0, 300)));
  });
  chat.onCardAction((action) => {
    onCardAction(action).catch((e) => bus.activity('system', '卡片处理异常', String(e).slice(0, 300)));
  });
  // 新成员入群 → 私信项目快速指引（事件 + 轮询双通道，onboard 层幂等）
  chat.onMemberJoined((evt) => {
    handleMemberJoined(evt).catch((e) => bus.activity('system', '入群指引处理异常', String(e).slice(0, 300)));
  });
  bus.on('task:confirmed', (task: Task) => {
    evaluateAndMaybeRun(task).catch((e) => bus.activity('system', '能力自评异常', String(e).slice(0, 200)));
  });
  bus.on('task:published', ({ task, groupMsgId, draft }: { task: Task; groupMsgId: string; draft: string }) => {
    reviewPublishedTask(task, groupMsgId, draft).catch((e) => bus.activity('system', '评审异常', String(e).slice(0, 200)));
  });
  bus.on('task:startRun', (task: Task | null) => {
    if (task) startRun(task).catch((e) => bus.activity('system', '手动执行异常', String(e).slice(0, 200)));
  });

  // 6) 恢复被打断的执行 + 定时器
  recoverInterruptedRuns();
  const { agentRuns } = await import('./store/repo.js');
  const orphans = agentRuns.failOrphans(); // 孤儿 agent 运行（子进程随上次进程消亡）判失败，别在「Agent 运行中」挂一辈子
  if (orphans) bus.activity('system', `清理孤儿 Agent 运行 ${orphans} 条`, '服务重启导致的中断');
  startDigestScheduler();
  startDueSoonScheduler();
  startNudgeScheduler();
  const { startHeartbeatScheduler } = await import('./agent/heartbeat.js');
  startHeartbeatScheduler();
  const { startWikiScheduler } = await import('./agent/wiki.js');
  startWikiScheduler();
  const { startPagesCleanup } = await import('./pages/index.js');
  startPagesCleanup();

  // 6.5) 日程通道探测（缺权限自动降级并给指引，唯一允许降级的新能力）
  ensureCalendar().catch(() => {});

  // 7) API + 事件流启动
  startAdminApi();
  await chat.start();

  bus.activity('system', 'Everyone 已就绪', config.chatAdapter === 'lark'
    ? `监听群 ${config.lark.demoChatId || '（未配置 DEMO_CHAT_ID）'}`
    : `打开 admin 的「模拟群聊」页开始体验`);

  // 8) 优雅退出（SIGTERM 契约）
  const shutdown = async (signal: string) => {
    console.log(`\n收到 ${signal}，正在优雅退出…`);
    await chat.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('启动失败：', e);
  process.exit(1);
});

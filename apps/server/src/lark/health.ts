import { spawn } from 'node:child_process';
import { config } from '../config.js';

/**
 * 事件总线健康检查与自愈（卡片回调「点不了」根治的一半）。
 *
 * 实测故障模式（2026-08-28 02:45 抓到现场）：
 * `lark-cli event _bus` 进程存在、两个 consumer 进程存在，但 `event status` 报 not_running——
 * WebSocket 已断，consumer 自以为在消费。此时消息侧有 5s 轮询兜底看不出来，
 * 卡片回调没有任何兜底 → 用户点卡片 100% 失败。
 */

/** `lark-cli event status --json`：任一 app 的总线在跑即健康（输出非信封格式，独立解析） */
export async function eventBusRunning(): Promise<boolean> {
  try {
    const out = await runQuick(['event', 'status', '--json']);
    const parsed = JSON.parse(out);
    const apps: Array<{ running?: boolean }> = parsed?.apps ?? [];
    return apps.some((a) => a?.running === true);
  } catch {
    return false;
  }
}

/** 清理僵尸总线（自愈第一步；失败不抛，让重启订阅去拉起新总线） */
export async function stopEventBus(): Promise<void> {
  await runQuick(['event', 'stop', '--all', '--force']).catch(() => '');
}

function runQuick(args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.lark.bin, args, {
      cwd: config.root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let out = '';
    child.stdout!.on('data', (d) => (out += d));
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`lark-cli ${args[0]} ${args[1] ?? ''} 超时`));
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

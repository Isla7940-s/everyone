import { spawn } from 'node:child_process';
import { bus } from '../bus.js';
import { config } from '../config.js';

/**
 * 发起人私信「授权」→ 生成 device flow 链接回私信 → 后台轮询收尾。
 * 只申请免管理员审批的消息接收权限（敏感权限走开放平台后台，见 §7.4）。
 */
const SCOPES = 'im:message.group_at_msg:readonly im:message.p2p_msg:readonly';

function run(args: string[], timeoutMs = 15_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(config.lark.bin, args, { cwd: config.root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout!.on('data', (d) => (out += d));
    child.stderr!.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out });
    });
  });
}

export async function startAuthFlow(): Promise<{ url: string; userCode: string } | null> {
  const { out } = await run(['auth', 'login', '--scope', SCOPES, '--no-wait', '--json']);
  try {
    const d = JSON.parse(out.trim().split('\n').find((l) => l.trim().startsWith('{')) ?? '{}');
    if (!d.verification_url) return null;
    // 后台收尾（最长 10 分钟）
    finishAuthFlow(d.device_code).catch(() => {});
    return { url: d.verification_url, userCode: d.user_code ?? '' };
  } catch {
    return null;
  }
}

async function finishAuthFlow(deviceCode: string): Promise<void> {
  const { code, out } = await run(['auth', 'login', '--device-code', deviceCode], 11 * 60_000);
  if (code === 0 && !out.includes('failed')) {
    bus.activity('system', '消息接收权限授权完成', '事件通道将实时生效');
    bus.emit('auth:completed');
  } else {
    bus.activity('system', '授权未完成或失败', out.slice(-200));
  }
}

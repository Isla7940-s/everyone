import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { bus } from '../bus.js';
import { LarkCliError } from './errors.js';

/**
 * lark-cli 对 --idempotency-key 有硬性上限 50 字符（CLI 客户端校验，App 侧无法放宽；超限直接 validation/invalid_argument，退出码 2）。
 * 统一处理：≤50 原样透传；超长直接截断到 50（保留前缀可读性）。
 * 注意：截断后不同 key 若前 50 字符相同，会在 1 小时幂等窗口内被当作同一条去重；
 * 当前各调用点 key 前缀各异，实际碰撞概率极低。
 */
const IDEMPOTENCY_KEY_MAX = 50;
function clampIdempotencyKey(key: string): string {
  return key.length <= IDEMPOTENCY_KEY_MAX ? key : key.slice(0, IDEMPOTENCY_KEY_MAX);
}

export interface ExecOptions {
  /** 写操作幂等键（自动注入 --idempotency-key） */
  idempotencyKey?: string;
  /** stdin 内容（配合 --content @- 等） */
  stdin?: string;
  timeoutMs?: number;
}

/**
 * 一次性 lark-cli 命令。
 * 契约（LARK-CLI.md §7）：
 * - 固定 --format json；cwd 固定项目根（--image 相对路径由此成立）
 * - 成败看退出码 + ok 字段，不看 code
 * - 非 0 → 解析 stderr 信封 → 抛 LarkCliError（不吞错）
 * - 网络类错误自动重试 2 次（写操作有幂等键，重试安全）
 */
export async function larkExec<T = any>(args: string[], opts: ExecOptions = {}): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      return await larkExecOnce<T>(args, opts);
    } catch (e) {
      lastErr = e;
      const retryable = e instanceof LarkCliError && (e.type === 'network' || e.exitCode === 4 || e.exitCode === 5);
      if (!retryable || attempt === 2) throw e;
      bus.activity('system', `lark-cli 网络波动，${2 * (attempt + 1)}s 后重试`, args.slice(0, 3).join(' '));
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function larkExecOnce<T = any>(args: string[], opts: ExecOptions = {}): Promise<T> {
  const finalArgs = [...args];
  if (!finalArgs.includes('--format')) finalArgs.push('--format', 'json');
  if (opts.idempotencyKey) finalArgs.push('--idempotency-key', clampIdempotencyKey(opts.idempotencyKey));

  const started = Date.now();
  const child = spawn(config.lark.bin, finalArgs, {
    cwd: config.root,
    stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (d) => (stdout += d));
  child.stderr!.on('data', (d) => (stderr += d));
  if (opts.stdin !== undefined) {
    child.stdin!.write(opts.stdin);
    child.stdin!.end();
  }

  const timeoutMs = opts.timeoutMs ?? 60_000;
  const exitCode: number = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new LarkCliError({ message: `lark-cli 超时（${timeoutMs}ms）: ${args.slice(0, 3).join(' ')}`, exitCode: -1 }));
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code ?? -1); });
  });

  const elapsed = Date.now() - started;
  const cmdSummary = args.filter((a) => !a.startsWith('sk-')).slice(0, 6).join(' ');

  if (exitCode !== 0) {
    let envelope: any = null;
    try { envelope = JSON.parse(stderr.trim().split('\n').filter(Boolean).pop() ?? ''); } catch { /* 非 JSON stderr */ }
    const err = new LarkCliError({
      message: envelope?.error?.message ?? `lark-cli 退出码 ${exitCode}: ${stderr.slice(0, 400)}`,
      type: envelope?.error?.type,
      subtype: envelope?.error?.subtype,
      code: envelope?.error?.code ?? null,
      hint: envelope?.error?.hint ?? null,
      missingScopes: envelope?.error?.missing_scopes ?? [],
      consoleUrl: envelope?.error?.console_url ?? null,
      exitCode,
    });
    bus.activity('system', `lark-cli 失败: ${cmdSummary}`, `${err.type}/${err.subtype} ${err.message.slice(0, 200)}`);
    throw err;
  }

  let envelope: any;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new LarkCliError({ message: `lark-cli stdout 非 JSON: ${stdout.slice(0, 300)}`, exitCode: 0 });
  }
  if (envelope.ok !== true) {
    throw new LarkCliError({
      message: envelope?.error?.message ?? 'ok=false',
      type: envelope?.error?.type,
      subtype: envelope?.error?.subtype,
      code: envelope?.error?.code ?? null,
      hint: envelope?.error?.hint ?? null,
      missingScopes: envelope?.error?.missing_scopes ?? [],
      consoleUrl: envelope?.error?.console_url ?? null,
      exitCode: 0,
    });
  }
  // audit（只记摘要，不刷屏）
  if (elapsed > 3000) bus.activity('system', `lark-cli 慢调用 ${elapsed}ms`, cmdSummary);
  return envelope.data as T;
}

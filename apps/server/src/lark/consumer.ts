import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { config } from '../config.js';
import { bus } from '../bus.js';

/**
 * 常驻 `lark-cli event consume <key>` 子进程。
 * 六条硬约束（LARK-CLI.md §4）：
 * 1. 阻塞读 stderr 直到 `[event] ready`，不用 sleep 兜底
 * 2. stdin 保持可写（pipe），EOF 会被当成优雅退出
 * 3. 停用 SIGTERM，禁止 kill -9
 * 4. 退出码语义：0 正常；非 0 → 指数退避重启 + 活动流告警
 * 5. 重启后由上层回捞（onRestart 回调）
 * 6. 不用 --quiet
 */
export class EventConsumer {
  private child: ChildProcess | null = null;
  private stopped = false;
  private backoffMs = 1000;
  private restartCount = 0;

  constructor(
    private readonly eventKey: string,
    private readonly onEvent: (evt: any) => void,
    private readonly onRestart?: () => void,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.spawnOnce();
  }

  private async spawnOnce(): Promise<void> {
    if (this.stopped) return;
    const child = spawn(config.lark.bin, ['event', 'consume', this.eventKey, '--as', 'bot'], {
      cwd: config.root,
      stdio: ['pipe', 'pipe', 'pipe'], // stdin 保持打开（约束 2）
      env: process.env,
    });
    this.child = child;

    // 约束 1：等 ready
    const ready = await new Promise<boolean>((resolve) => {
      const rl = readline.createInterface({ input: child.stderr! });
      const timer = setTimeout(() => resolve(false), 30_000);
      rl.on('line', (line) => {
        if (line.includes('[event] ready')) {
          clearTimeout(timer);
          resolve(true);
        } else if (line.trim()) {
          // 其余 stderr（告警、退出原因）记录到活动流
          if (/warn|error|exit/i.test(line)) bus.activity('system', `event(${this.eventKey}) stderr`, line.slice(0, 300));
        }
      });
      child.on('close', () => { clearTimeout(timer); resolve(false); });
    });

    if (!ready) {
      bus.activity('system', `event(${this.eventKey}) 启动未就绪，重试`, `第 ${this.restartCount + 1} 次`);
      this.scheduleRestart();
      return;
    }

    bus.activity('system', `事件订阅就绪`, this.eventKey);
    this.backoffMs = 1000; // 就绪后重置退避

    // NDJSON 逐行解析
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const evt = JSON.parse(trimmed);
        this.onEvent(evt);
      } catch {
        // 非 JSON 行忽略（CLI 可能输出人类可读提示）
      }
    });

    child.on('close', (code) => {
      if (this.stopped) return;
      bus.activity('system', `event(${this.eventKey}) 进程退出 code=${code}`, code === 0 ? '正常' : '异常，退避重启');
      this.scheduleRestart();
    });
  }

  private scheduleRestart() {
    if (this.stopped) return;
    this.restartCount += 1;
    const delay = Math.min(this.backoffMs, 60_000);
    this.backoffMs *= 2;
    setTimeout(() => {
      if (this.stopped) return;
      this.spawnOnce().then(() => this.onRestart?.());
    }, delay);
  }

  /** 约束 3：SIGTERM 优雅退出 */
  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 8000);
      child.on('close', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }
}

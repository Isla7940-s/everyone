/**
 * 验证一：真实 Codex 引擎驱动远程求助沙箱（跨端协同.md §十/§十二）。
 *
 * 与 smoke:collab（mock 引擎）的区别：本脚本用本机真实 `codex exec` 处理求助，
 * 通过"暗号值"断言 Codex 真的读了沙箱里的原始会话与工作区快照，并经沙箱 CLI 提交回复。
 * 需要：本机已安装并登录 codex CLI。运行：pnpm --filter @everyone/server verify:codex-help
 */
import './env-codexhelp.js';
import '../store/db.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startAdminApi } from '../admin-api/index.js';
import { createAgentSession } from '../agent/session.js';
import { config } from '../config.js';
import { setAdapter } from '../context.js';
import { MockAdapter } from '../lark/mock.js';
import { initMemory } from '../memory/index.js';
import { seedPersons } from '../seed.js';
import { persons } from '../store/repo.js';

const results: Array<{ step: string; ok: boolean }> = [];
function record(step: string, ok: boolean, detail = '') {
  results.push({ step, ok });
  console.log(`${ok ? '✅' : '❌'} ${step}${detail ? ` — ${detail}` : ''}`);
}
function finish(): never {
  const bad = results.filter((r) => !r.ok);
  console.log(`\n=== 真实 Codex 求助验证：${results.length - bad.length}/${results.length} 通过 ===`);
  process.exit(bad.length ? 1 : 0);
}

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'everyone-codexhelp-'));
// codex 凭证在真实 HOME 下：把 ~/.codex 软链进隔离 HOME，其余（.everyone）保持隔离
fs.symlinkSync(path.join(os.homedir(), '.codex'), path.join(tmpHome, '.codex'));

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? tmpHome,
      env: { ...process.env, HOME: tmpHome, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); process.stdout.write(d); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    const timer = setTimeout(() => { out += ' [超时强杀]'; child.kill('SIGKILL'); }, opts.timeoutMs ?? 60_000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: `${out} [spawn错误] ${e}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out }); });
  });
}

const ROOT = config.root;
const CLI = path.join(ROOT, 'cli/everyone.mjs');
const PYCLIENT = path.join(ROOT, 'clients/everyone_local_client.py');

let rpcId = 0;
async function mcpCall(base: string, token: string, name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const r = JSON.parse(await res.text());
  const content = r?.result?.content ?? [];
  return { text: content.map((c: any) => c?.text ?? '').join('\n'), isError: !!r?.result?.isError || !!r?.error };
}

async function main() {
  console.log('\n=== 验证一：真实 Codex 引擎处理远程求助 ===\n');
  await initMemory();
  await seedPersons();
  const mock = new MockAdapter();
  setAdapter(mock);
  await mock.start();
  startAdminApi();
  const base = `http://127.0.0.1:${config.serverPort}`;
  await new Promise((r) => setTimeout(r, 800));

  const me = persons.byId('xiaoming')!;
  const tokenRes = await (await fetch(`${base}/api/collab/admin/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ personId: me.id, label: 'codex-verify' }),
  })).json() as { token: string };

  // ===== 构造带"暗号"的真实工作区与会话（暗号只存在于本地，云端总结里没有）=====
  const workspace = path.join(tmpHome, 'pay-service');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src/retry-config.json'), JSON.stringify({
    max_attempts: 5,
    backoff_base_ms: 1750, // 暗号：只有读了快照/会话才知道
    dead_letter_table: 'pay_callback_dlq_v3',
  }, null, 2));
  const sessionFile = path.join(tmpHome, 'codex-session-pay.jsonl');
  fs.writeFileSync(sessionFile, [
    JSON.stringify({ role: 'user', text: '支付回调重试的退避基数定多少合适？' }),
    JSON.stringify({ role: 'assistant', text: '结合压测 P99，退避基数定为 1750ms（写进 src/retry-config.json 的 backoff_base_ms），最多 5 次，死信表用 pay_callback_dlq_v3。' }),
    JSON.stringify({ role: 'user', text: '好，就按 1750ms 定版。' }),
  ].join('\n'));

  const cliEnv = { EVERYONE_BASE_URL: base, EVERYONE_TOKEN: tokenRes.token };
  const up = await run(process.execPath, [CLI, 'sessions', 'upload',
    '--tool', 'codex', '--requirement', '支付系统升级', '--subtask', '支付回调重试',
    '--brief', '定版回调重试参数并落地配置',
    '--detail', '与用户确认回调重试策略并写入配置文件；具体参数值在本地会话与配置中。',
    '--local-path', sessionFile, '--workspace', workspace, '--json'], { env: cliEnv });
  const sessionId = JSON.parse(up.out).session.id as string;
  record('总结上传+映射登记', /^[A-Z0-9]{16}$/.test(sessionId), sessionId);

  // ===== 本地客户端：engine=codex，放行沙箱网络（沙箱 CLI 要调回环回传结果）=====
  const init = await run('python3', [PYCLIENT, 'init', '--base-url', base, '--token', tokenRes.token, '--engine', 'codex']);
  record('Python 客户端 init（engine=codex）', init.code === 0);
  // 用客户端默认 codex_cmd（workspace-write + 网络放行 + skip-git-repo-check），只缩短超时
  const clientCfgFile = path.join(tmpHome, '.everyone/client.json');
  const clientCfg = JSON.parse(fs.readFileSync(clientCfgFile, 'utf-8'));
  clientCfg.engine_timeout_sec = 600;
  fs.writeFileSync(clientCfgFile, JSON.stringify(clientCfg, null, 2));

  // ===== 云端 Agent 发起求助（阻塞）=====
  const agent = createAgentSession({
    mode: 'chat', chatId: mock.demoChatId, personId: 'laowang',
    workspaceDir: path.join(config.workspacesDir, '_agent', 'codex-verify'),
    label: '真实 Codex 验证 Agent', ttlMs: 30 * 60_000,
  });
  fs.mkdirSync(agent.workspaceDir, { recursive: true });

  const helpPromise = mcpCall(base, agent.token, 'collab_request_remote_help', {
    session_id: sessionId,
    question: '当时支付回调重试的退避基数定的是多少毫秒？死信表叫什么名字？',
    background: '云端在写支付系统运维手册，云端只有总结、没有具体参数值',
    expectation: '给出退避基数毫秒数与死信表名，并注明依据来自哪份文件/对话',
    timeout_sec: 900,
  });

  // 等求助入库后跑真实 codex
  await new Promise((r) => setTimeout(r, 1500));
  console.log('\n--- 本地客户端开始处理（真实 codex exec，可能需要几分钟）---\n');
  const pyRun = await run('python3', [PYCLIENT, 'run', '--once'], { timeoutMs: 650_000 });
  record('本地客户端 + 真实 Codex 执行完成', pyRun.code === 0, pyRun.out.split('\n').filter((l) => l.includes('求助')).pop()?.slice(0, 100) ?? '');

  const result = await Promise.race([
    helpPromise,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('MCP 60s 未返回')), 60_000)),
  ]).catch((e) => ({ text: String(e), isError: true }));

  record('MCP 阻塞调用返回成功', !result.isError, result.text.split('\n')[0]?.slice(0, 80));
  record('回复含暗号「1750」（真读了本地会话/快照）', result.text.includes('1750'));
  record('回复含死信表暗号「pay_callback_dlq_v3」', result.text.includes('pay_callback_dlq_v3'));
  record('回复由沙箱 CLI 提交（非 stdout 兜底）', !result.text.includes('未经沙箱 CLI 提交'));
  console.log('\n--- MCP 返回全文 ---\n' + result.text + '\n');
  finish();
}

main().catch((e) => {
  console.error('验证异常退出：', e);
  record('未捕获异常', false);
  finish();
});

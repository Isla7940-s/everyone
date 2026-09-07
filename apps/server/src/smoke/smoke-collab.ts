/**
 * pnpm smoke:collab —— 跨端协同全链路冒烟（跨端协同.md），零模型成本：
 *
 *   token 签发 → CLI 登录 → 工作总结上传（+本地映射）→ MCP 总结查询 →
 *   MCP 阻塞式远程求助（飞书告知消息）→ Python 本地客户端领取/建沙箱/mock 引擎/沙箱 CLI 提交 →
 *   MCP 拿到回复与附件 → wait/get_help_result → 时间去向上传 → 时间穿透聚合 →
 *   任务完成草稿/确认流程 → 沙箱 CLI 能力隔离断言
 *
 * 真实组件：真 HTTP server、真 MCP 通道、真 CLI 子进程、真 Python 客户端子进程。
 */
import './env-collab.js';
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
import { persons, tasks } from '../store/repo.js';

const results: Array<{ step: string; ok: boolean; detail: string }> = [];
function record(step: string, ok: boolean, detail = '') {
  results.push({ step, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${step}${detail ? ` — ${detail}` : ''}`);
}
function finish(code: number): never {
  const bad = results.filter((r) => !r.ok);
  console.log(`\n=== 跨端协同冒烟：${results.length - bad.length}/${results.length} 通过 ===`);
  process.exit(bad.length ? 1 : code);
}
async function waitFor<T>(fn: () => T | Promise<T>, ms: number, interval = 300): Promise<T | null> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, interval));
  }
  return null;
}

// ===== 子进程工具 =====

const ROOT = config.root;
const CLI = path.join(ROOT, 'cli/everyone.mjs');
const PYCLIENT = path.join(ROOT, 'clients/everyone_local_client.py');
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'everyone-collab-'));

/** 异步 spawn：HTTP 服务与冒烟同进程，同步 spawn 会锁死事件循环导致子进程连不上服务 */
function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? tmpHome,
      env: { ...process.env, HOME: tmpHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    const timer = setTimeout(() => { out += ' [超时强杀]'; child.kill('SIGKILL'); }, opts.timeoutMs ?? 60_000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: `${out} [spawn错误] ${e}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out }); });
  });
}

const runCli = (args: string[], opts: { cwd?: string } = {}) => run(process.execPath, [CLI, ...args], opts);
const runPy = (args: string[]) => run('python3', [PYCLIENT, ...args], { timeoutMs: 120_000 });

// ===== MCP 客户端（对齐 fake-opencode 的通道用法）=====

let rpcId = 0;
async function mcpRpc(base: string, token: string, method: string, params: unknown): Promise<any> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const line = text.split('\n').filter((l) => l.startsWith('data:')).pop();
    return line ? JSON.parse(line.slice(5)) : null;
  }
}
async function mcpCall(base: string, token: string, name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  const r = await mcpRpc(base, token, 'tools/call', { name, arguments: args });
  const content = r?.result?.content ?? [];
  return {
    text: content.map((c: any) => c?.text ?? '').join('\n'),
    isError: !!r?.result?.isError || !!r?.error,
  };
}

async function main() {
  console.log('\n=== Everyone 跨端协同冒烟 ===\n');
  await initMemory();
  await seedPersons();
  const mock = new MockAdapter();
  setAdapter(mock);
  await mock.start();
  startAdminApi();

  const base = `http://127.0.0.1:${config.serverPort}`;
  const up = await waitFor(async () => {
    try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
  }, 15_000);
  record('HTTP 服务就绪', !!up, base);
  if (!up) return finish(1);

  const me = persons.byId('xiaoming')!;
  record('演示成员就绪', !!me, me?.name);

  // ===== 1. token 签发 + CLI 登录 =====
  const tokenRes = await (await fetch(`${base}/api/collab/admin/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ personId: me.id, label: 'smoke' }),
  })).json() as { token: string };
  record('签发个人 token', !!tokenRes.token?.startsWith('ct_'), tokenRes.token?.slice(0, 12));

  const login = await runCli(['auth', 'login', '--base-url', base, '--token', tokenRes.token]);
  record('CLI auth login', login.code === 0 && login.out.includes('已登录'), login.out.trim().slice(0, 200) || `code=${login.code}`);

  // ===== 2. 工作总结上传（带本地映射）=====
  const fakeWorkspace = path.join(tmpHome, 'proj');
  fs.mkdirSync(fakeWorkspace, { recursive: true });
  fs.writeFileSync(path.join(fakeWorkspace, 'notes.md'), '# 项目笔记\n重试上限定为 5 次，退避基数 2s。\n');
  const fakeSession = path.join(tmpHome, 'fake-codex-session.jsonl');
  fs.writeFileSync(fakeSession, [
    JSON.stringify({ role: 'user', text: '帮我实现支付回调的重试机制' }),
    JSON.stringify({ role: 'assistant', text: '方案：指数退避重试最多 5 次（2s 基数），失败落死信表 pay_callback_dead，已补 12 个单测全部通过。' }),
  ].join('\n'));

  const nowIso = new Date().toISOString();
  const up1 = await runCli([
    'sessions', 'upload', '--tool', 'codex',
    '--requirement', '支付系统升级', '--subtask', '支付回调重试',
    '--brief', '实现回调指数退避重试并补齐单测',
    '--detail', '在 webhook 处理层加入指数退避重试（最多5次、基数2s），失败写入死信表 pay_callback_dead；补充单测 12 个全部通过；遗留：死信表报警未接。',
    '--at', nowIso, '--local-path', fakeSession, '--workspace', fakeWorkspace, '--json',
  ]);
  let sessionId = '';
  try { sessionId = JSON.parse(up1.out).session.id; } catch { /* 断言在下面 */ }
  record('CLI 上传工作总结（16 位 ID）', /^[A-Z0-9]{16}$/.test(sessionId), sessionId || up1.out.slice(0, 120));

  const mapFile = path.join(tmpHome, '.everyone/session-map.json');
  const map = JSON.parse(fs.readFileSync(mapFile, 'utf-8'));
  record('本地映射登记（§十一）', map[sessionId]?.path === fakeSession, `${sessionId} → ${map[sessionId]?.path}`);

  // 第二条总结（同需求不同子任务，供相关会话/搜索断言）
  const up2 = await runCli([
    'sessions', 'upload', '--tool', 'cursor',
    '--requirement', '支付系统升级', '--subtask', '对账单导出',
    '--brief', '对账单导出接口完成并通过验收',
    '--detail', '新增对账单按日期范围导出 CSV 的接口，含权限校验与分页流式输出，验收通过。',
    '--at', nowIso, '--json',
  ]);
  record('CLI 上传第二条总结', up2.code === 0, '');

  // ===== 3. 云端 Agent（MCP）查询总结 =====
  const agent = createAgentSession({
    mode: 'chat',
    chatId: mock.demoChatId,
    personId: 'laowang',
    workspaceDir: path.join(config.workspacesDir, '_agent', 'collab-smoke'),
    label: '协同冒烟 Agent',
  });
  fs.mkdirSync(agent.workspaceDir, { recursive: true });
  await mcpRpc(base, agent.token, 'initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke-collab', version: '0.0.1' },
  });

  const list = await mcpCall(base, agent.token, 'collab_list_work_summaries', { limit: 5 });
  record('MCP 总结列表（启动注入同源）', !list.isError && list.text.includes(sessionId), list.text.split('\n')[1]?.slice(0, 80));

  const search = await mcpCall(base, agent.token, 'collab_search_work_summaries', { query: '重试 单测' });
  record('MCP 关键词搜索', !search.isError && search.text.includes(sessionId), '');

  const detail = await mcpCall(base, agent.token, 'collab_get_work_session_detail', { session_id: sessionId });
  record('MCP 详细总结（100 字）', !detail.isError && detail.text.includes('死信表'), '');

  const related = await mcpCall(base, agent.token, 'collab_get_related_work_sessions', { session_id: sessionId });
  record('MCP 相关会话（同大需求）', !related.isError && related.text.includes('对账单导出'), '');

  // ===== 4. 阻塞式远程求助（§九）→ Python 客户端处理（§十）=====
  const helpPromise = mcpCall(base, agent.token, 'collab_request_remote_help', {
    session_id: sessionId,
    question: '当时重试上限和退避参数是怎么定的？死信表叫什么名字？',
    background: '云端在写支付系统的运维手册，缺当时的实现细节',
    expectation: '给出重试参数、死信表名，并附上依据',
    context_info: '手册草稿已有重试流程图，缺参数表',
  });

  const pendingHelp = await waitFor(async () => {
    const r = await (await fetch(`${base}/api/collab/help/pending`, { headers: { authorization: `Bearer ${tokenRes.token}` } })).json() as any;
    return r.helps?.[0];
  }, 10_000);
  record('求助已创建并等待本地领取', !!pendingHelp, pendingHelp?.id);
  if (!pendingHelp) return finish(1);

  const noticed = mock.history.some((m) => m.senderIsBot && (m.text ?? '').includes('远程求助'));
  record('飞书告知消息（§八）', noticed, '');

  const pyInit = await runPy(['init', '--base-url', base, '--token', tokenRes.token, '--engine', 'mock']);
  record('Python 客户端 init', pyInit.code === 0, pyInit.out.trim().split('\n').pop()?.slice(0, 80) ?? '');

  const pyRun = await runPy(['run', '--once']);
  record('Python 客户端处理求助（沙箱+mock 引擎）', pyRun.code === 0 && pyRun.out.includes('沙箱就绪'), pyRun.out.trim().split('\n').filter((l) => l.includes('[')).pop()?.slice(0, 100) ?? '');

  const helpResult = await Promise.race([
    helpPromise,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('MCP 阻塞调用 60s 未返回')), 60_000)),
  ]).catch((e) => ({ text: String(e), isError: true }));
  record('request_remote_help 阻塞返回回复', !helpResult.isError && helpResult.text.includes('远程求助已完成'), helpResult.text.split('\n')[0]?.slice(0, 80));
  record('回复含本地原始会话内容', helpResult.text.includes('pay_callback_dead') || helpResult.text.includes('指数退避'), '');

  const attachDir = path.join(agent.workspaceDir, 'help', pendingHelp.id);
  const attached = fs.existsSync(attachDir) && fs.readdirSync(attachDir).length > 0;
  record('附件同步进云端沙箱（§十二）', attached, attached ? fs.readdirSync(attachDir).join('、') : attachDir);

  // 沙箱构造断言
  const sandboxDir = path.join(tmpHome, '.everyone/sandboxes', pendingHelp.id);
  const sandboxOk = ['HELP.md', 'AGENTS.md', 'everyone.mjs', 'everyone-sandbox.json'].every((f) => fs.existsSync(path.join(sandboxDir, f)))
    && fs.existsSync(path.join(sandboxDir, 'session'))
    && fs.existsSync(path.join(sandboxDir, 'workspace/notes.md'));
  record('沙箱七件套齐全（快照/会话/任务书/CLI/Skill）', sandboxOk, sandboxDir);

  // 沙箱 CLI 能力隔离：任务命令不可用，只有 help reply/attach
  const sandboxRestricted = await runCli(['tasks', 'list'], { cwd: sandboxDir });
  record('沙箱 CLI 只保留两项能力', sandboxRestricted.code === 1 && sandboxRestricted.out.includes('沙箱模式'), '');
  // 普通 CLI 没有 reply/attach（打印用法并报非零）
  const normalNoReply = await runCli(['help', 'reply', '--text', 'x']);
  record('普通 CLI 无提交回复能力', normalNoReply.code === 1, '');

  // ===== 5. wait / get_help_result（第二次求助走非阻塞→继续等待路径）=====
  const help2Promise = mcpCall(base, agent.token, 'collab_request_remote_help', {
    session_id: sessionId,
    question: '单测覆盖了哪些场景？',
    timeout_sec: 120,
  });
  const pending2 = await waitFor(async () => {
    const r = await (await fetch(`${base}/api/collab/help/pending`, { headers: { authorization: `Bearer ${tokenRes.token}` } })).json() as any;
    return r.helps?.[0];
  }, 10_000);
  record('第二次求助创建', !!pending2, pending2?.id);

  const peek = await mcpCall(base, agent.token, 'collab_get_help_result', { help_id: pending2.id });
  record('get_help_result 非阻塞查询（进行中）', !peek.isError && peek.text.includes('进行中'), '');

  const py2 = await runPy(['run', '--once']);
  record('Python 客户端处理第二次求助', py2.code === 0, '');
  const wait2 = await mcpCall(base, agent.token, 'collab_wait_help_result', { help_id: pending2.id });
  record('wait_help_result 返回已完成结果', !wait2.isError && wait2.text.includes('远程求助已完成'), '');
  await help2Promise; // 原始阻塞调用也应正常返回

  // 失败路径：映射不存在的会话 → 本地客户端错误回传（§十一）
  const up3 = await runCli([
    'sessions', 'upload', '--tool', 'claude-code',
    '--requirement', '支付系统升级', '--subtask', '灰度发布脚本',
    '--brief', '灰度发布脚本调通', '--detail', '编写灰度发布脚本并在预发验证通过。', '--json',
  ]);
  const orphanId = JSON.parse(up3.out).session.id as string;
  const help3Promise = mcpCall(base, agent.token, 'collab_request_remote_help', {
    session_id: orphanId, question: '脚本在哪个目录？', timeout_sec: 60,
  });
  await waitFor(async () => {
    const r = await (await fetch(`${base}/api/collab/help/pending`, { headers: { authorization: `Bearer ${tokenRes.token}` } })).json() as any;
    return r.helps?.length;
  }, 10_000);
  await runPy(['run', '--once']);
  const help3 = await help3Promise;
  record('会话缺映射 → 失败信息回传（§十一）', help3.isError && help3.text.includes('映射'), help3.text.slice(0, 90));

  // ===== 6. 时间去向 → 时间穿透 =====
  const today = new Date().toLocaleDateString('sv-SE');
  const draft = {
    date: today,
    entries: [
      { requirement: '支付系统升级', subtask: '支付回调重试', sessionId, startedAt: `${today}T09:30:00+08:00`, endedAt: `${today}T11:30:00+08:00` },
      { requirement: '支付系统升级', subtask: '对账单导出', minutes: 90, briefSummary: '导出接口联调与验收' },
      { requirement: '内部工具维护', subtask: '构建脚本修复', minutes: 45, briefSummary: '修复 CI 构建脚本', detailSummary: '定位 pnpm 缓存击穿问题并修复。', sourceTool: 'cursor' },
    ],
  };
  const noConfirm = await runCli(['time', 'submit', '--data', JSON.stringify(draft)]);
  record('时间上传缺确认被拒（§七）', noConfirm.code === 1 && noConfirm.out.includes('--confirmed'), '');
  const submit = await runCli(['time', 'submit', '--data', JSON.stringify(draft), '--confirmed']);
  record('时间去向正式上传', submit.code === 0 && submit.out.includes('3 条'), submit.out.trim());

  const pierce = await (await fetch(`${base}/api/collab/admin/pierce?personId=${me.id}`)).json() as any;
  const day = pierce.days.find((d: any) => d.date === today);
  const payReq = day?.requirements.find((r: any) => r.name === '支付系统升级');
  const retrySub = payReq?.subtasks.find((s: any) => s.name === '支付回调重试');
  record('时间穿透聚合（天→需求→子任务）', day?.totalMinutes === 120 + 90 + 45 && payReq?.minutes === 210, `day=${day?.totalMinutes}min`);
  record('穿透下钻带会话总结（§十三）', retrySub?.entries?.[0]?.briefSummary?.includes('重试') && retrySub?.entries?.[0]?.minutes === 120, retrySub?.entries?.[0]?.briefSummary ?? '');

  const overview = await (await fetch(`${base}/api/collab/admin/overview`)).json() as any;
  record('管理员团队周总览', overview.members?.some((m: any) => m.personId === me.id && m.totalMinutes === 255), '');

  // ===== 7. 任务完成流程（§七）=====
  const task = tasks.create({
    ownerId: me.id, creatorId: 'laowang', title: '支付回调重试上线', source: 'manual',
    important: true, urgent: false, dueAt: null, status: 'todo', confidence: 1,
  });
  const tlist = await runCli(['tasks', 'list']);
  record('CLI 任务与排期查询', tlist.code === 0 && tlist.out.includes(task.id), '');

  const mcpTasks = await mcpCall(base, agent.token, 'collab_list_tasks', { person: '小明' });
  record('MCP 查询任务和排期（§二）', !mcpTasks.isError && mcpTasks.text.includes(task.id), '');

  const evidence = path.join(tmpHome, '变更报告.md');
  fs.writeFileSync(evidence, '# 变更报告\n\n重试机制上线，12 个单测全过。\n');
  const draftRes = await runCli(['tasks', 'complete-draft', task.id, '--note', '重试机制已上线并验证', '--leftover', '死信报警待接', '--sessions', sessionId, '--attach', evidence]);
  record('任务完成草稿上报（含产出物附件）', draftRes.code === 0 && draftRes.out.includes('1 个产出物附件') && tasks.byId(task.id)?.status === 'todo', `状态仍为 ${tasks.byId(task.id)?.status}`);

  const noConfirmTask = await runCli(['tasks', 'complete', task.id]);
  record('任务完成缺确认被拒', noConfirmTask.code === 1 && noConfirmTask.out.includes('--confirmed'), '');

  const done = await runCli(['tasks', 'complete', task.id, '--confirmed']);
  const after = tasks.byId(task.id);
  record('确认后任务标记完成（§七）', done.code === 0 && after?.status === 'published', `status=${after?.status}`);

  const detail2 = await (await fetch(`${base}/api/collab/tasks/${task.id}`, { headers: { authorization: `Bearer ${tokenRes.token}` } })).json() as any;
  record('完成记录+会话关联落库', detail2.task?.completion?.note?.includes('重试') && detail2.task?.sessions?.some((s: any) => s.id === sessionId), '');
  const evidenceSaved = detail2.task?.completion?.attachments?.[0];
  record('产出物附件随完成记录保存（§七）',
    !!evidenceSaved && fs.existsSync(path.join(config.dataDir, evidenceSaved.relPath)), evidenceSaved?.name ?? '');

  finish(0);
}

main().catch((e) => {
  console.error('冒烟异常退出：', e);
  record('未捕获异常', false, String(e?.message ?? e).slice(0, 200));
  finish(1);
});

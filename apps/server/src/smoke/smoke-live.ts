/**
 * pnpm smoke:live（FR-H5）：读 .env，向真实飞书发一条私信 + 一张渲染图。
 * 前提：lark-cli 已装机授权、DEMO_CHAT_ID 已配置。
 */
process.env.CHAT_ADAPTER = 'lark';

import '../store/db.js';
import { execSync } from 'node:child_process';
import { config } from '../config.js';
import { larkExec } from '../lark/exec.js';
import * as im from '../lark/im.js';
import { renderQuadrant } from '../render/quadrant.js';
import { seedPersons } from '../seed.js';
import { tasks } from '../store/repo.js';

const results: Array<{ step: string; ok: boolean; detail: string }> = [];
function record(step: string, ok: boolean, detail = '') {
  results.push({ step, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${step}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  console.log('\n=== Everyone smoke:live（真实飞书连通性）===\n');

  // 1) doctor
  try {
    const out = execSync(`${config.lark.bin} doctor`, { stdio: 'pipe' }).toString();
    const ok = out.includes('"ok": true') || out.includes('"ok":true');
    record('lark-cli doctor', ok, ok ? '' : out.slice(0, 200));
    if (!ok) return finish(1);
  } catch (e) {
    record('lark-cli doctor', false, String(e).slice(0, 200));
    return finish(1);
  }

  // 2) 关键 scope 断言（§7.4）；消息接收 scope 缺失只警告（轮询降级可用）
  for (const [scope, required] of [['im:message', true], ['im:resource', true], ['im:message.p2p_msg:readonly', false]] as Array<[string, boolean]>) {
    try {
      execSync(`${config.lark.bin} auth check --scope "${scope}"`, { stdio: 'pipe' });
      record(`scope ${scope}`, true);
    } catch {
      record(`scope ${scope}`, !required, required ? `补授权：lark-cli auth login --scope "${scope}"` : '缺失（轮询降级可用，建议开通）');
    }
  }

  // 3) demo 群检查
  if (!config.lark.demoChatId) {
    record('DEMO_CHAT_ID 已配置', false, '先运行 pnpm setup:chat 创建 demo 群');
    return finish(1);
  }
  record('DEMO_CHAT_ID 已配置', true, config.lark.demoChatId);

  // 4) 发文本到群
  try {
    const sent = await im.sendText({ chatId: config.lark.demoChatId }, `🔌 Everyone smoke:live 连通性验证 ${new Date().toLocaleString('zh-CN')}`, `smoke-${Date.now()}`);
    record('发群文本消息', !!sent.message_id, sent.message_id);
  } catch (e) {
    record('发群文本消息', false, String(e).slice(0, 200));
  }

  // 5) 渲染四象限 → 发图
  try {
    await seedPersons();
    const png = renderQuadrant('小明', tasks.openTasksOf('xiaoming'));
    const sent = await im.sendImage({ chatId: config.lark.demoChatId }, png, `smokeimg-${Date.now()}`);
    record('渲染 PNG → 发群图片', !!sent.message_id, png);
  } catch (e) {
    record('渲染 PNG → 发群图片', false, String(e).slice(0, 200));
  }

  // 6) 私信自己（user open_id 从 auth status 拿；auth status 无 ok 信封，原始解析）
  try {
    const raw = execSync(`${config.lark.bin} auth status`, { stdio: 'pipe' }).toString();
    const status = JSON.parse(raw.slice(raw.indexOf('{')));
    const openId = status?.identities?.user?.openId;
    if (openId) {
      const sent = await im.sendText({ openId }, '📩 Everyone smoke:live 私信通道验证 OK', `smokedm-${Date.now()}`);
      record('发私信', !!sent.message_id, sent.message_id);
    } else {
      record('发私信', false, '拿不到 user openId');
    }
  } catch (e) {
    record('发私信', false, String(e).slice(0, 200));
  }

  finish(results.every((r) => r.ok) ? 0 : 1);
}

function finish(code: number) {
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== smoke:live 结果：${pass}/${results.length} 通过 ===\n`);
  process.exit(code);
}

main().catch((e) => {
  console.error('smoke:live 崩溃：', e);
  process.exit(1);
});

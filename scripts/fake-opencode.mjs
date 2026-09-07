#!/usr/bin/env node
/**
 * 冒烟用假 OpenCode 引擎：不连模型，按提示词里的路径「假装干活」，
 * 然后走真实的 feishu MCP HTTP 通道交付——冒烟由此覆盖
 * 「spawn → MCP initialize/tools/call → 回复/转云文档/部署页面」全链路，且零模型成本。
 * 输出对齐真实引擎的 `--format json` NDJSON 事件流（轨迹/抢救逻辑同一条代码路径）。
 * 用法：smoke 把 OPENCODE_BIN 指到本文件。
 * 环境开关：FAKE_OPENCODE_SILENT=1 → 不调 MCP，只在 stdout 输出最终文本（测零交付抢救）。
 */
import fs from 'node:fs';
import path from 'node:path';

// 调用形如 `fake-opencode.mjs run <prompt> --model x --format json --auto`：
// 取 run 之后第一个非选项参数为提示词；布尔 flag 不吞下一个参数
const VALUE_FLAGS = new Set(['--model', '--format', '--log-level', '--agent', '--session', '--dir', '--port', '--variant', '--title', '--attach', '-m', '-s', '-p', '-u', '-f', '--file', '--password', '--username', '--command']);
let prompt = '';
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'run') continue;
    if (a.startsWith('-')) {
      if (VALUE_FLAGS.has(a)) i++; // 带值 flag 跳过其值；布尔 flag 不跳
      continue;
    }
    prompt = a;
    break;
  }
}

/** 对齐真实引擎的 NDJSON 事件输出 */
function emitText(text) {
  process.stdout.write(`${JSON.stringify({ type: 'text', timestamp: Date.now(), sessionID: 'ses_fake', part: { type: 'text', messageID: 'msg_fake_final', text } })}\n`);
}

const url = process.env.EVERYONE_MCP_URL;
const token = process.env.EVERYONE_AGENT_TOKEN;
if (!url || !token) {
  console.error('fake-opencode：缺少 EVERYONE_MCP_URL / EVERYONE_AGENT_TOKEN');
  process.exit(1);
}

let rpcId = 0;
async function post(body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    // SSE 兜底：取最后一行 data:
    const line = text.split('\n').filter((l) => l.startsWith('data:')).pop();
    return line ? JSON.parse(line.slice(5)) : null;
  }
}

async function rpc(method, params) {
  const r = await post({ jsonrpc: '2.0', id: ++rpcId, method, params });
  if (r?.error) throw new Error(`${method} rpc error: ${JSON.stringify(r.error)}`);
  return r?.result;
}

async function call(name, args) {
  const result = await rpc('tools/call', { name, arguments: args });
  if (result?.isError) throw new Error(`tool ${name} 报错：${JSON.stringify(result.content).slice(0, 300)}`);
  return result;
}

async function main() {
  if (process.env.FAKE_OPENCODE_SILENT === '1') {
    // 零交付场景：模型把答案当聊天输出、没走 MCP —— 服务端应抢救这段文本代发
    emitText('调查结论：AI+∞ 大赛第二期的核心奖品是 NVIDIA 赞助的 60 台 DGX Spark（假引擎静默模式输出）。');
    process.exit(0);
  }

  await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'fake-opencode', version: '0.0.2' },
  });
  await post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

  const chatMatch = prompt.match(/sessions\/(as-[0-9a-f]+)\//);
  const heartbeatMatch = prompt.match(/_heartbeat\/(hb-[0-9a-f]+)\//);
  const taskMatch = prompt.match(/tasks\/([\w-]+)\/brief\.md/);
  const wikiMode = prompt.includes('_wiki') || prompt.includes('feishu_update_wiki');

  if (wikiMode) {
    // 群知识库维护模式：写 wiki.md → update_wiki（唯一交付出口，无回复用户工具）
    fs.writeFileSync(
      path.join(process.cwd(), 'wiki.md'),
      '# 群知识库\n\n## 群定位与基本情况\n\n- 星航项目群（冒烟假引擎维护）\n\n## 关键决策与结论\n\n- 08-29 定：单场预算 5 万封顶（假引擎示例）\n',
    );
    await call('update_wiki', {});
    emitText('知识库已发布');
  } else if (heartbeatMatch) {
    // 心跳模式：查一次历史消息（覆盖 search_messages 通道），然后文本交付
    let found = '';
    try {
      const r = await call('search_messages', { query: '压测', limit: 3 });
      found = (r?.content ?? []).map((c) => c?.text ?? '').join('').slice(0, 80);
    } catch { /* 查询失败不阻断交付 */ }
    await call('reply', { text: `（假引擎心跳）例行播报完成。历史消息检索样例：${found || '（无命中）'}` });
    emitText('心跳播报已交付');
  } else if (chatMatch) {
    // 对话 Agent 模式：产出单文件 HTML → reply 附件（覆盖自动部署 + 链接卡片）
    const sid = chatMatch[1];
    const rel = `sessions/${sid}/notes/demo.html`;
    fs.mkdirSync(path.dirname(path.join(process.cwd(), rel)), { recursive: true });
    fs.writeFileSync(
      path.join(process.cwd(), rel),
      '<!doctype html><html><head><meta charset="utf-8"><title>冒烟看板</title></head><body><h1>冒烟数据看板</h1><p>fake-opencode 生成</p></body></html>',
    );
    await call('reply', { text: '（假引擎）看板做好了，点卡片查看', attachment_path: rel });
    emitText('看板已交付');
  } else if (taskMatch) {
    // 任务模式：写 draft.md → reply 附件（覆盖 md → 云文档转档）
    const tid = taskMatch[1];
    const rel = `tasks/${tid}/draft.md`;
    fs.mkdirSync(path.dirname(path.join(process.cwd(), rel)), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), rel), '# 假引擎成稿\n\n这是冒烟测试的任务成稿正文，用于验证 MCP 交付链路。\n');
    await call('reply', { text: '（假引擎）成稿已交', attachment_path: rel });
    emitText('成稿已交付');
  } else {
    await call('reply', { text: '（假引擎）没识别出任务书路径，直接文本交付' });
    emitText('文本已交付');
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('fake-opencode 失败：', e?.message ?? e);
    process.exit(1);
  },
);

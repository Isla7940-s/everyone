#!/usr/bin/env node
/**
 * Everyone CLI（跨端协同.md §四）——只装在用户本地，云端 Agent 沙箱不装（它用 MCP）。
 *
 * 单文件、零依赖（Node ≥ 18）。两种运行形态：
 *  - 普通模式：任务与排期 / 时间去向 / 工作总结 / 远程求助查询（无「提交回复/上传附件」能力）
 *  - 沙箱模式：目录里有 everyone-sandbox.json 时自动进入，只保留两项能力——提交回复、上传附件
 *
 * 配置解析顺序：环境变量 EVERYONE_BASE_URL / EVERYONE_TOKEN → ~/.everyone/config.json
 * 会话映射（§十一）：sessions upload --local-path 会把「会话 ID → 本地原始位置」写进 ~/.everyone/session-map.json
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const HOME_DIR = path.join(os.homedir(), '.everyone');
const CONFIG_FILE = path.join(HOME_DIR, 'config.json');
const MAP_FILE = path.join(HOME_DIR, 'session-map.json');
const SANDBOX_FILE = 'everyone-sandbox.json';

// ===== 基础工具 =====

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}
function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
function ok(msg) {
  console.log(`✓ ${msg}`);
}

/** 从 cwd 向上找 everyone-sandbox.json（远程求助沙箱标志） */
function findSandbox() {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const f = path.join(dir, SANDBOX_FILE);
    if (fs.existsSync(f)) {
      const conf = readJson(f, null);
      if (conf?.helpId && conf?.helpToken && conf?.baseUrl) return { ...conf, file: f };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 解析参数：--key value / --key=value / --flag；其余进 positional */
function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[a.slice(2)] = argv[i + 1];
        i += 1;
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

function resolveConfig() {
  const file = readJson(CONFIG_FILE, {});
  const baseUrl = (process.env.EVERYONE_BASE_URL || file.baseUrl || '').replace(/\/$/, '');
  const token = process.env.EVERYONE_TOKEN || file.token || '';
  return { baseUrl, token };
}

async function api(baseUrl, token, method, apiPath, body) {
  let res;
  try {
    res = await fetch(`${baseUrl}${apiPath}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    fail(`连不上 Everyone 云端（${baseUrl}）：${e?.message ?? e}`);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 300) }; }
  if (!res.ok) fail(data?.error ?? `HTTP ${res.status}`);
  return data;
}

const fmtDue = (iso) => (iso ? iso.slice(0, 16).replace('T', ' ') : '未设定');
const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}` : `${m}m`);
const maybeJson = (flags, data) => {
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
    return true;
  }
  return false;
};

// ===== 沙箱模式（§四/§十二）：只保留「提交回复」「上传附件」两项能力 =====

async function sandboxMain(sandbox, argv) {
  const { flags, pos } = parseArgs(argv);
  const [group, action] = pos;
  const call = (method, p, body) => api(sandbox.baseUrl, sandbox.helpToken, method, p, body);

  if (group === 'help' && action === 'reply') {
    let text = typeof flags.text === 'string' ? flags.text : '';
    if (flags.file) {
      const f = path.resolve(String(flags.file));
      if (!fs.existsSync(f)) fail(`--file 不存在：${f}`);
      text = fs.readFileSync(f, 'utf-8');
    }
    const failed = !!flags.failed;
    if (!failed && !text.trim()) fail('必须提供回复内容：--text "..." 或 --file 回复文件.md');
    const r = await call('POST', `/api/collab/help/${sandbox.helpId}/reply`, {
      text,
      note: typeof flags.note === 'string' ? flags.note : undefined,
      status: failed ? 'failed' : 'succeeded',
      error: typeof flags.error === 'string' ? flags.error : undefined,
    });
    if (maybeJson(flags, r)) return;
    ok(failed ? '已提交失败状态' : `回复已提交（${text.length} 字），云端 Agent 将立即收到`);
    return;
  }

  if (group === 'help' && action === 'attach') {
    const files = pos.slice(2);
    if (!files.length) fail('用法：everyone help attach <文件...>（先 attach 后 reply）');
    for (const f of files) {
      const abs = path.resolve(f);
      if (!fs.existsSync(abs)) fail(`文件不存在：${abs}`);
      const buf = fs.readFileSync(abs);
      if (buf.length > 10 * 1024 * 1024) fail(`附件超过 10MB：${abs}`);
      const r = await call('POST', `/api/collab/help/${sandbox.helpId}/attachments`, {
        filename: path.basename(abs),
        contentBase64: buf.toString('base64'),
      });
      ok(`附件已上传：${r.attachment.name}（${(r.attachment.size / 1024).toFixed(1)}KB，已同步进云端 Agent 沙箱）`);
    }
    return;
  }

  console.log(`Everyone CLI · 远程求助沙箱模式（求助 ${sandbox.helpId}）

这个沙箱里的 CLI 只有两项能力（跨端协同.md §四）：

  everyone help attach <文件...>                 上传附件（可多次；在 reply 之前做）
  everyone help reply --text "回复内容"           提交文字回复（求助就此完成）
                      --file 回复.md              （长回复写进文件再提交）
                      [--note "任务完成说明"]
  everyone help reply --failed --error "原因"     报告执行失败

普通模式的任务/时间/总结命令在这里不可用。`);
  process.exit(group ? 1 : 0);
}

// ===== 普通模式 =====

const USAGE = `Everyone CLI —— 本地 Agent 与 Everyone 云端的通道（跨端协同）

配置
  everyone auth login --base-url http://... --token ct_xxx    保存配置到 ~/.everyone/config.json
  everyone auth status                                        验证身份

任务和排期
  everyone tasks list [--all]                    我的任务（默认只看未完成；--all 含已完成/取消）
  everyone tasks get <taskId>                    任务详情（状态/截止/关联会话/完成草稿）
  everyone tasks schedule                        排期视图（按截止时间）
  everyone tasks complete-draft <taskId> --note "完成说明" [--leftover "遗留"] [--sessions ID,ID]
                                         [--attach 产出物.md,报告.png]
                                                 上报完成草稿（不改任务状态，先给用户看；附件即产出物/证据）
  everyone tasks complete <taskId> --confirmed [--note ...] [--leftover ...] [--sessions ...]
                                                 用户确认后正式提交（任务直接标记完成）

工作总结（会话 ID = 16 位字母数字；原文永远留在本地）
  everyone sessions upload --tool codex --requirement "大需求" --subtask "子任务" \\
      --brief "25字短总结" --detail "100字详细总结" [--id <16位>] [--at ISO时间] \\
      [--task t-xxx] [--local-path /本地会话文件路径]
                                                 上传总结；--local-path 同时登记本地映射（供远程求助还原）
  everyone sessions list [--limit 20] [--days 7] [--keyword "关键词"] [--all-members]
  everyone sessions get <会话ID>                  详细总结 + 关联任务
  everyone sessions related <会话ID>              相关会话

时间去向（先草稿给用户确认，再正式上传）
  everyone time draft [--date YYYY-MM-DD]        由当天已上传会话生成草稿 JSON（打印后自行编辑）
  everyone time submit --file 草稿.json --confirmed
                                                 正式上传（同日整体替换）
  everyone time week [--week YYYY-MM-DD]         查看某周时间记录

远程协作（查询；「提交回复/上传附件」只存在于求助沙箱内的 CLI）
  everyone help list [--all]                     待处理（--all 全部）求助
  everyone help status <helpId>                  求助执行状态

通用：--json 输出原始 JSON`;

async function main() {
  const sandbox = findSandbox();
  const argv = process.argv.slice(2);
  if (sandbox) return sandboxMain(sandbox, argv);

  const { flags, pos } = parseArgs(argv);
  const [group, action, ...rest] = pos;
  const cfg = resolveConfig();

  // --- auth ---
  if (group === 'auth' && action === 'login') {
    const baseUrl = String(flags['base-url'] ?? cfg.baseUrl ?? '').replace(/\/$/, '');
    const token = String(flags.token ?? '');
    if (!baseUrl || !token) fail('用法：everyone auth login --base-url http://主机:8902 --token ct_xxx（token 在后台「跨端协同」页生成）');
    const who = await api(baseUrl, token, 'GET', '/api/collab/whoami');
    writeJson(CONFIG_FILE, { baseUrl, token });
    ok(`已登录：${who.name}（${who.personId}）· 配置已写入 ${CONFIG_FILE}`);
    return;
  }
  if (!cfg.baseUrl || !cfg.token) {
    if (!group || group === 'help' && !action) { console.log(USAGE); return; }
    fail('还没配置：先运行 everyone auth login --base-url ... --token ...（或设 EVERYONE_BASE_URL / EVERYONE_TOKEN）');
  }
  const call = (method, p, body) => api(cfg.baseUrl, cfg.token, method, p, body);

  if (group === 'auth' && action === 'status') {
    const who = await call('GET', '/api/collab/whoami');
    if (maybeJson(flags, who)) return;
    ok(`身份有效：${who.name}（${who.personId}）· ${cfg.baseUrl}`);
    return;
  }

  // --- tasks ---
  if (group === 'tasks') {
    if (action === 'list' || action === 'schedule') {
      const data = await call('GET', `/api/collab/tasks${flags.all ? '?all=1' : ''}`);
      if (maybeJson(flags, data)) return;
      if (!data.tasks.length) { console.log('（没有任务）'); return; }
      console.log(action === 'schedule' ? `我的排期（按截止时间，${data.tasks.length} 项）：` : `我的任务（${data.tasks.length} 项）：`);
      for (const t of data.tasks) {
        const flagsTxt = [t.important ? '重要' : '', t.urgent ? '紧急' : ''].filter(Boolean).join('+') || '普通';
        console.log(`- [${t.id}] ${t.title}`);
        console.log(`    状态 ${t.status} · ${flagsTxt} · 截止 ${fmtDue(t.dueAt)}${t.completionDraft ? ' · 有完成草稿待确认' : ''}${t.sessions.length ? ` · 关联会话 ${t.sessions.length} 个` : ''}`);
      }
      return;
    }
    if (action === 'get') {
      const id = rest[0] ?? '';
      if (!id) fail('用法：everyone tasks get <taskId>');
      const data = await call('GET', `/api/collab/tasks/${id}`);
      if (maybeJson(flags, data)) return;
      const t = data.task;
      console.log(`[${t.id}] ${t.title}
状态：${t.status} · 重要=${t.important} 紧急=${t.urgent} · 截止 ${fmtDue(t.dueAt)} · 来源 ${t.source}`);
      if (t.sessions.length) {
        console.log('关联工作会话：');
        for (const s of t.sessions) console.log(`  - [${s.id}] ${s.requirement} / ${s.subtask}：${s.briefSummary}`);
      }
      if (t.completionDraft) console.log(`完成草稿（待确认）：${t.completionDraft.note}${t.completionDraft.leftover ? `（遗留：${t.completionDraft.leftover}）` : ''}`);
      if (t.completion) console.log(`完成记录：${t.completion.note}（确认于 ${fmtDue(t.completion.confirmedAt)}）`);
      return;
    }
    if (action === 'complete-draft' || action === 'complete') {
      const id = rest[0] ?? '';
      if (!id) fail(`用法：everyone tasks ${action} <taskId> ...`);
      const sessionIds = typeof flags.sessions === 'string' ? flags.sessions.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      if (action === 'complete-draft') {
        if (typeof flags.note !== 'string' || !flags.note.trim()) fail('必须提供 --note "完成说明"');
        // 产出物/证据附件（§七）：逗号分隔多个文件
        const attachments = [];
        if (typeof flags.attach === 'string') {
          for (const f of flags.attach.split(',').map((s) => s.trim()).filter(Boolean)) {
            const abs = path.resolve(f);
            if (!fs.existsSync(abs)) fail(`附件不存在：${abs}`);
            const buf = fs.readFileSync(abs);
            if (buf.length > 10 * 1024 * 1024) fail(`附件超过 10MB：${abs}`);
            attachments.push({ filename: path.basename(abs), contentBase64: buf.toString('base64') });
          }
        }
        const r = await call('POST', `/api/collab/tasks/${id}/completion-draft`, {
          note: flags.note,
          leftover: typeof flags.leftover === 'string' ? flags.leftover : undefined,
          sessionIds,
          attachments: attachments.length ? attachments : undefined,
        });
        if (maybeJson(flags, r)) return;
        ok(`完成草稿已上报${attachments.length ? `（含 ${attachments.length} 个产出物附件）` : ''}。把草稿念给用户听，用户说没问题后再执行：`);
        console.log(`  everyone tasks complete ${id} --confirmed`);
        return;
      }
      if (flags.confirmed !== true) fail('缺少 --confirmed：任务完成必须先经用户确认（先 complete-draft，用户点头后再来）');
      const r = await call('POST', `/api/collab/tasks/${id}/complete`, {
        confirmed: true,
        note: typeof flags.note === 'string' ? flags.note : undefined,
        leftover: typeof flags.leftover === 'string' ? flags.leftover : undefined,
        sessionIds,
      });
      if (maybeJson(flags, r)) return;
      ok(`任务已正式完成并标记：[${r.task.id}] ${r.task.title}（状态 ${r.task.status}）`);
      return;
    }
  }

  // --- sessions ---
  if (group === 'sessions') {
    if (action === 'upload') {
      const required = ['tool', 'requirement', 'subtask', 'brief', 'detail'];
      const missing = required.filter((k) => typeof flags[k] !== 'string' || !flags[k].trim());
      if (missing.length) fail(`缺少参数：${missing.map((m) => `--${m}`).join(' ')}`);
      const body = {
        id: typeof flags.id === 'string' ? flags.id : undefined,
        tool: flags.tool, requirement: flags.requirement, subtask: flags.subtask,
        brief: flags.brief, detail: flags.detail,
        at: typeof flags.at === 'string' ? flags.at : undefined,
        taskId: typeof flags.task === 'string' ? flags.task : undefined,
      };
      const r = await call('POST', '/api/collab/sessions', body);
      const s = r.session;
      // §十一：登记「会话 ID → 本地原始位置」映射（远程求助按它还原原文）
      if (typeof flags['local-path'] === 'string' && flags['local-path'].trim()) {
        const localPath = path.resolve(flags['local-path'].trim());
        const map = readJson(MAP_FILE, {});
        const nowIso = new Date().toISOString();
        map[s.id] = {
          tool: s.sourceTool,
          workspace: typeof flags.workspace === 'string' ? path.resolve(flags.workspace) : path.dirname(localPath),
          path: localPath,
          createdAt: map[s.id]?.createdAt ?? nowIso,
          updatedAt: nowIso,
        };
        writeJson(MAP_FILE, map);
      }
      if (maybeJson(flags, r)) return;
      ok(`工作总结已上传：[${s.id}] ${s.requirement} / ${s.subtask}`);
      if (typeof flags['local-path'] === 'string') console.log(`  本地映射已登记 → ${MAP_FILE}`);
      else console.log('  （提示：加 --local-path <本地会话文件> 可登记映射，云端 Agent 才能对这个会话发起远程求助）');
      return;
    }
    if (action === 'list') {
      const qs = new URLSearchParams();
      if (flags.limit) qs.set('limit', String(flags.limit));
      if (flags.days) qs.set('days', String(flags.days));
      if (typeof flags.keyword === 'string') qs.set('keyword', flags.keyword);
      if (flags['all-members']) qs.set('mine', '0');
      const data = await call('GET', `/api/collab/sessions?${qs}`);
      if (maybeJson(flags, data)) return;
      if (!data.sessions.length) { console.log('（没有工作总结）'); return; }
      for (const s of data.sessions) {
        console.log(`- [${s.id}] ${s.sessionAt.slice(0, 16).replace('T', ' ')} ${s.personName} · ${s.requirement} / ${s.subtask}（${s.sourceTool}）\n    ${s.briefSummary}`);
      }
      return;
    }
    if (action === 'get' || action === 'related') {
      const id = rest[0] ?? '';
      if (!id) fail(`用法：everyone sessions ${action} <会话ID>`);
      if (action === 'get') {
        const data = await call('GET', `/api/collab/sessions/${id}`);
        if (maybeJson(flags, data)) return;
        const s = data.session;
        console.log(`[${s.id}] ${s.requirement} / ${s.subtask}（${s.sourceTool} · ${s.personName} · ${s.sessionAt.slice(0, 16).replace('T', ' ')}）
短总结：${s.briefSummary}
详细总结：${s.detailSummary}`);
        if (data.task) console.log(`关联任务：[${data.task.id}] ${data.task.title}（${data.task.status}，截止 ${fmtDue(data.task.dueAt)}）`);
        return;
      }
      const data = await call('GET', `/api/collab/sessions/${id}/related`);
      if (maybeJson(flags, data)) return;
      if (!data.sessions.length) { console.log('（没有相关会话）'); return; }
      for (const s of data.sessions) console.log(`- [${s.id}] ${s.subtask}：${s.briefSummary}`);
      return;
    }
  }

  // --- time ---
  if (group === 'time') {
    if (action === 'draft') {
      const date = typeof flags.date === 'string' ? flags.date : new Date().toLocaleDateString('sv-SE');
      const data = await call('GET', `/api/collab/sessions?days=3&limit=50`);
      const daySessions = data.sessions.filter((s) => s.sessionAt.slice(0, 10) === date);
      const draft = {
        date,
        confirmed: false,
        entries: daySessions.map((s) => ({
          requirement: s.requirement,
          subtask: s.subtask,
          sessionId: s.id,
          startedAt: s.sessionAt,
          minutes: 60,
          briefSummary: s.briefSummary,
          detailSummary: s.detailSummary,
          sourceTool: s.sourceTool,
        })),
      };
      console.log(JSON.stringify(draft, null, 2));
      console.error(`\n（草稿基于 ${date} 已上传的 ${daySessions.length} 个工作会话生成；minutes 默认 60，请按实际修改。
给用户确认后：everyone time submit --file 草稿.json --confirmed）`);
      return;
    }
    if (action === 'submit') {
      let draft;
      if (typeof flags.file === 'string') {
        const f = path.resolve(flags.file);
        if (!fs.existsSync(f)) fail(`草稿文件不存在：${f}`);
        draft = readJson(f, null);
      } else if (typeof flags.data === 'string') {
        try { draft = JSON.parse(flags.data); } catch { fail('--data 不是合法 JSON'); }
      }
      if (!draft) fail('用法：everyone time submit --file 草稿.json --confirmed');
      if (flags.confirmed !== true) fail('缺少 --confirmed：时间去向必须先给用户看草稿、用户确认后再上传');
      const r = await call('POST', '/api/collab/time-entries', { ...draft, confirmed: true });
      if (maybeJson(flags, r)) return;
      ok(`时间去向已上传：${r.date} 共 ${r.entries.length} 条 · ${fmtMin(r.totalMinutes)}`);
      return;
    }
    if (action === 'week') {
      const qs = typeof flags.week === 'string' ? `?week=${flags.week}` : '';
      const data = await call('GET', `/api/collab/time-entries${qs}`);
      if (maybeJson(flags, data)) return;
      console.log(`${data.weekStart} ~ ${data.weekEnd} 共 ${fmtMin(data.totalMinutes)}`);
      for (const d of data.days) {
        if (!d.totalMinutes) continue;
        console.log(`${d.date}（${d.weekday}）${fmtMin(d.totalMinutes)}`);
        for (const rq of d.requirements) {
          console.log(`  ${rq.name} ${fmtMin(rq.minutes)}`);
          for (const st of rq.subtasks) console.log(`    - ${st.name} ${fmtMin(st.minutes)}（${st.entries.length} 段）`);
        }
      }
      return;
    }
  }

  // --- help（查询求助；提交回复/上传附件只在沙箱 CLI 里有）---
  if (group === 'help') {
    if (action === 'list') {
      const data = await call('GET', flags.all ? '/api/collab/help' : '/api/collab/help/pending');
      if (maybeJson(flags, data)) return;
      if (!data.helps.length) { console.log('（没有求助）'); return; }
      for (const h of data.helps) {
        console.log(`- [${h.id}] ${h.status} · 目标会话 ${h.sessionId} · ${h.createdAt.slice(0, 16).replace('T', ' ')}\n    ${h.question.slice(0, 120)}`);
      }
      return;
    }
    if (action === 'status') {
      const id = rest[0] ?? '';
      if (!id) fail('用法：everyone help status <helpId>');
      const data = await call('GET', `/api/collab/help/${id}`);
      if (maybeJson(flags, data)) return;
      const h = data.help;
      console.log(`[${h.id}] 状态 ${h.status}
目标会话：${h.sessionId}（${h.session ? `${h.session.requirement} / ${h.session.subtask}` : '总结缺失'}）
问题：${h.question}`);
      if (h.replyText) console.log(`回复：${h.replyText.slice(0, 400)}`);
      if (h.error) console.log(`错误：${h.error}`);
      if (h.attachments.length) console.log(`附件：${h.attachments.map((a) => a.name).join('、')}`);
      return;
    }
  }

  console.log(USAGE);
  if (group) process.exit(1);
}

main().catch((e) => fail(String(e?.message ?? e)));

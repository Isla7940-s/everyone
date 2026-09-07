import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { mountAgentMcp } from '../agent/mcp.js';
import { bus } from '../bus.js';
import { mountCollabApi } from '../collab/api.js';
import { config } from '../config.js';
import { adapter, mockAdapter } from '../context.js';
import { generateAndSendDigest, digestState } from '../digest/index.js';
import { readMockDoc } from '../executor/docstore.js';
import { briefRel, draftRel, listWorkspaceFiles } from '../executor/workspace.js';
import { bitableState, ledgerUrl } from '../ledger/bitable.js';
import { completionRate } from '../ledger/tasks.js';
import * as memory from '../memory/index.js';
import { reviewEnabled, setReviewEnabled } from '../reviewer/index.js';
import {
  agentRuns, assists, chats, heartbeats, persons, reviewComments, runs, tasks,
} from '../store/repo.js';
import { tracePath } from '../executor/opencode.js';

/** admin REST + SSE（FR-G，供 apps/admin 与 mock 群聊 UI 使用） */
export function startAdminApi(): void {
  const app = new Hono();
  app.use('*', cors());

  // ===== 状态总览 =====
  app.get('/api/state', async (c) => {
    const { calendarState } = await import('../lark/calendar.js');
    return c.json({
      mode: config.chatAdapter,
      demoMode: config.demoMode,
      memoryEngineUp: memory.memoryEngineUp(),
      bitable: { ...bitableState(), url: ledgerUrl() },
      calendar: { available: calendarState.available, reason: calendarState.reason },
      digest: { enabled: digestState.enabled, time: digestState.time },
      wiki: { time: config.wikiTime },
      reviewEnabled,
      completionRate: completionRate(),
      persons: persons.all(),
      tasks: tasks.all(),
      runs: runs.all(50),
      assists: assists.all(50),
      reviews: reviewComments.all(50),
      activities: bus.recentActivities.slice(-200),
      // 七项需求 2/3/6/7：Agent 运行、群采集、心跳任务
      agentRuns: agentRuns.all(80),
      chats: chats.all(),
      heartbeats: heartbeats.all(),
    });
  });

  // ===== 健康与压测观测 =====
  app.get('/api/health', async (c) => {
    const { intentBacklog } = await import('../ingest/pipeline.js');
    const { db } = await import('../store/db.js');
    const count = (sql: string) => (db.prepare(sql).get() as any)?.n ?? 0;
    return c.json({
      ok: true,
      uptimeSec: Math.round(process.uptime()),
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      intent: intentBacklog(),
      counts: {
        seen: count('SELECT COUNT(*) n FROM messages_seen'),
        chatMessages: count('SELECT COUNT(*) n FROM chat_messages'),
        // 用户消息单列（需求③后 bot outbound 也入档，「不丢消息」断言以此为准）
        chatMessagesUser: count(`SELECT COUNT(*) n FROM chat_messages WHERE sender_open_id != 'everyone-bot'`),
        tasks: count('SELECT COUNT(*) n FROM tasks'),
        assists: count('SELECT COUNT(*) n FROM assists'),
      },
    });
  });
  // ===== SSE 实时流 =====
  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const send = (event: string, data: unknown) =>
        stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {});
      const onActivity = (a: unknown) => send('activity', a);
      const onMock = (m: unknown) => send('mock_message', m);
      const onRecall = (id: unknown) => send('mock_recall', { msgId: id });
      const onCardUpdate = (u: unknown) => send('mock_card_update', u);
      const onReaction = (u: unknown) => send('mock_reaction', u);
      const onChanged = (what: string) => () => send('changed', { what });
      const handlers: Array<[string, (...args: any[]) => void]> = [
        ['activity', onActivity],
        ['mock:message', onMock],
        ['mock:recall', onRecall],
        ['mock:card-update', onCardUpdate],
        ['mock:reaction', onReaction],
        ['task:changed', onChanged('task')],
        ['run:changed', onChanged('run')],
        ['assist:changed', onChanged('assist')],
        ['person:changed', onChanged('person')],
      ];
      for (const [ev, h] of handlers) bus.on(ev, h);
      send('hello', { ts: Date.now() });
      // 心跳保活
      const hb = setInterval(() => send('ping', { ts: Date.now() }), 15_000);
      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener('abort', () => resolve());
      });
      clearInterval(hb);
      for (const [ev, h] of handlers) bus.off(ev, h);
    }),
  );

  // ===== mock 群聊（用户要求的 mock 前端数据接口）=====
  app.get('/api/mock/history', (c) => {
    const mock = mockAdapter();
    if (!mock) return c.json([]); // live 模式没有 mock 历史：返回空数组（避免前端启动时报 400）
    const chatId = c.req.query('chatId');
    const list = chatId ? mock.history.filter((m) => m.chatId === chatId) : mock.history;
    return c.json(list);
  });
  app.post('/api/mock/message', async (c) => {
    const mock = mockAdapter();
    if (!mock) return c.json({ error: 'not in mock mode' }, 400);
    const body = await c.req.json<{ personId: string; text: string; chatKind?: 'group' | 'p2p' }>();
    const p = persons.byId(body.personId);
    if (!p) return c.json({ error: 'unknown person' }, 400);
    const msg = mock.injectUserMessage({ personId: p.id, personName: p.name, text: body.text, chatKind: body.chatKind ?? 'group' });
    return c.json({ ok: true, msgId: msg.msgId });
  });
  app.post('/api/mock/card-click', async (c) => {
    const mock = mockAdapter();
    if (!mock) return c.json({ error: 'not in mock mode' }, 400);
    const body = await c.req.json<{ msgId: string; operatorId: string; value: Record<string, string> }>();
    mock.injectCardClick(body);
    return c.json({ ok: true });
  });
  // 拉新人进群（新功能 1 的 mock 触发源）：建 person + 工作区 → 触发入群事件 → 快速指引私信
  app.post('/api/mock/join', async (c) => {
    const mock = mockAdapter();
    if (!mock) return c.json({ error: 'not in mock mode' }, 400);
    const body = await c.req.json<{ name: string }>();
    const name = (body.name ?? '').trim().slice(0, 20);
    if (!name) return c.json({ error: 'name required' }, 400);
    if (persons.byName(name)) return c.json({ error: `已有同名成员「${name}」` }, 400);
    const { randomUUID } = await import('node:crypto');
    const { ensureWorkspace } = await import('../executor/workspace.js');
    const id = `m_${randomUUID().slice(0, 6)}`;
    persons.upsert({
      id, feishuOpenId: null, name,
      workspaceDir: `${config.workspacesRel}/${id}`,
      avatarColor: ['#3370FF', '#F54A45', '#34C724', '#FF8800', '#7B67EE'][Math.floor(Math.random() * 5)],
      isBot: false,
    });
    ensureWorkspace(id, name);
    bus.changed('person');
    mock.injectMemberJoin({ personId: id, personName: name });
    return c.json({ ok: true, personId: id });
  });
  // 模拟忙闲（新需求 4 演示/回归用）：minutes>0 = 此人从现在起「开会」N 分钟；<=0 = 清除
  app.post('/api/mock/busy', async (c) => {
    const body = await c.req.json<{ personId: string; minutes: number }>();
    const p = persons.byId(body.personId);
    if (!p) return c.json({ error: 'unknown person' }, 400);
    const { kv } = await import('../store/repo.js');
    const { clearBusyCache } = await import('../lark/freebusy.js');
    if ((body.minutes ?? 0) > 0) {
      const until = new Date(Date.now() + body.minutes * 60_000).toISOString();
      kv.set(`mock_busy:${p.id}`, until);
      bus.activity('system', `模拟忙闲：${p.name} 开会中`, `至 ${until}`);
    } else {
      kv.set(`mock_busy:${p.id}`, '');
      bus.activity('system', `模拟忙闲：${p.name} 已空闲`);
    }
    clearBusyCache(p.id);
    return c.json({ ok: true });
  });
  app.get('/api/mock/doc/:taskId', (c) => {
    const md = readMockDoc(c.req.param('taskId'));
    if (md === null) return c.json({ error: 'not found' }, 404);
    const t = tasks.all().find((x) => x.id === c.req.param('taskId'));
    return c.json({ markdown: md, task: t ?? null });
  });

  // ===== 个人工作空间（FR-G2）=====
  // 伪工作区（需求 3：管理员查看维护超级代理本身的沙箱）：_agent = 对话模式按天沙箱，_heartbeat = 心跳任务沙箱，_wiki = 群知识库沙箱
  const PSEUDO_WS: Record<string, string> = { _agent: '超级代理沙箱', _heartbeat: '心跳任务沙箱', _wiki: '群知识库沙箱' };
  app.get('/api/workspace/:personId', (c) => {
    const pid = c.req.param('personId');
    if (PSEUDO_WS[pid]) {
      return c.json({
        person: { id: pid, name: PSEUDO_WS[pid], workspaceDir: `${config.workspacesRel}/${pid}`, feishuOpenId: null },
        memory: '', skills: [], files: listWorkspaceFiles(pid), tasks: [], assists: [],
      });
    }
    const p = persons.byId(pid);
    if (!p) return c.json({ error: 'unknown person' }, 404);
    return c.json({
      person: p,
      memory: memory.readPersonMemory(pid),
      skills: memory.readPersonSkills(pid),
      files: listWorkspaceFiles(pid),
      tasks: tasks.all({ ownerId: pid }),
      assists: assists.all(100).filter((a) => a.personId === pid),
    });
  });
  app.put('/api/workspace/:personId/memory', async (c) => {
    const pid = c.req.param('personId');
    const { content } = await c.req.json<{ content: string }>();
    memory.writePersonMemory(pid, content);
    bus.activity('memory', `${persons.byId(pid)?.name} 在后台更新了 memory.md`);
    return c.json({ ok: true });
  });
  // 预制 skill 库：随产品发布的通用写作模板，用户挑一个装进自己的分身即可
  app.get('/api/skills/presets', (c) => c.json({ presets: memory.listPresetSkills() }));
  app.put('/api/workspace/:personId/skill/:name', async (c) => {
    const pid = c.req.param('personId');
    const name = c.req.param('name');
    const { content, enabled } = await c.req.json<{ content: string; enabled: boolean }>();
    const dir = path.join(config.workspacesDir, pid, 'skills');
    fs.mkdirSync(dir, { recursive: true });
    // 停用 = 下划线前缀
    const onPath = path.join(dir, `${name}.md`);
    const offPath = path.join(dir, `_${name}.md`);
    fs.rmSync(onPath, { force: true });
    fs.rmSync(offPath, { force: true });
    fs.writeFileSync(enabled ? onPath : offPath, content);
    bus.activity('system', `${persons.byId(pid)?.name} 更新了 skill：${name}（${enabled ? '启用' : '停用'}）`);
    return c.json({ ok: true });
  });
  app.delete('/api/workspace/:personId/skill/:name', (c) => {
    const pid = c.req.param('personId');
    const name = c.req.param('name');
    const dir = path.join(config.workspacesDir, pid, 'skills');
    fs.rmSync(path.join(dir, `${name}.md`), { force: true });
    fs.rmSync(path.join(dir, `_${name}.md`), { force: true });
    return c.json({ ok: true });
  });
  // 上传文件进沙箱 repo/（给分身喂上下文：代码、文档、数据——代答与任务执行都会用到）
  app.post('/api/workspace/:personId/upload', async (c) => {
    const pid = c.req.param('personId');
    const p = persons.byId(pid);
    if (!p) return c.json({ error: 'unknown person' }, 404);
    const body = await c.req.json<{ path: string; contentBase64: string }>();
    const rel = (body.path ?? '').replaceAll('\\', '/').replace(/^\/+/, '');
    if (!rel.startsWith('repo/')) return c.json({ error: '只允许上传到 repo/ 目录（分身的长期上下文仓）' }, 400);
    const root = path.resolve(config.workspacesDir, pid);
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep)) return c.json({ error: 'bad path' }, 400);
    let buf: Buffer;
    try {
      buf = Buffer.from(body.contentBase64 ?? '', 'base64');
    } catch {
      return c.json({ error: 'bad base64' }, 400);
    }
    if (!buf.length) return c.json({ error: 'empty file' }, 400);
    if (buf.length > 5 * 1024 * 1024) return c.json({ error: '单文件最大 5MB' }, 400);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    bus.activity('system', `${p.name} 上传了文件到沙箱`, `${rel}（${(buf.length / 1024).toFixed(1)}KB）`);
    return c.json({ ok: true, path: rel, size: buf.length });
  });

  app.get('/api/workspace/:personId/file', (c) => {
    const pid = c.req.param('personId');
    if (!PSEUDO_WS[pid] && !persons.byId(pid)) return c.json({ error: 'unknown person' }, 404);
    const root = path.resolve(config.workspacesDir, pid);
    const abs = path.resolve(root, c.req.query('path') ?? '');
    // 必须落在本人工作区内。前缀比较要带分隔符，否则 xiaoming 能读到 xiaoming2/
    if (abs !== root && !abs.startsWith(root + path.sep)) return c.json({ error: 'bad path' }, 400);
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory()) return c.json({ error: 'is directory' }, 400);
      const MAX = 512 * 1024;
      const buf = fs.readFileSync(abs);
      const head = buf.subarray(0, 4096);
      if (head.includes(0)) return c.json({ binary: true, size: st.size, content: '' });
      return c.json({
        size: st.size,
        truncated: st.size > MAX,
        content: buf.subarray(0, MAX).toString('utf-8'),
      });
    } catch {
      return c.json({ error: 'not found' }, 404);
    }
  });
  app.post('/api/person/:id/toggle', async (c) => {
    const pid = c.req.param('id');
    const { key, on } = await c.req.json<{ key: 'collect' | 'answer'; on: boolean }>();
    persons.setToggle(pid, key === 'collect' ? 'collect_enabled' : 'answer_enabled', on);
    bus.changed('person');
    bus.activity('system', `${persons.byId(pid)?.name} ${on ? '开启' : '关闭'}了「${key === 'collect' ? '帮你收' : '帮你答'}」`);
    return c.json({ ok: true });
  });

  // ===== 消息采集按群启停（需求 6）=====
  app.post('/api/chat/:id/toggle', async (c) => {
    const id = c.req.param('id');
    const chat = chats.byId(id);
    if (!chat) return c.json({ error: 'unknown chat' }, 404);
    const { on } = await c.req.json<{ on: boolean }>();
    chats.setCollect(id, on);
    bus.changed('person');
    bus.activity('system', `消息采集${on ? '启用' : '禁用'}：${chat.name ?? id.slice(0, 16)}`, `管理员操作`);
    return c.json({ ok: true, chat: chats.byId(id) });
  });

  // ===== 群知识库（2026-08-29 需求⑥）=====
  app.post('/api/chat/:id/wiki-toggle', async (c) => {
    const id = c.req.param('id');
    const chat = chats.byId(id);
    if (!chat) return c.json({ error: 'unknown chat' }, 404);
    const { on } = await c.req.json<{ on: boolean }>();
    chats.setWikiEnabled(id, on);
    bus.changed('person');
    bus.activity('system', `群知识库${on ? '启用' : '停用'}：${chat.name ?? id.slice(0, 16)}`, '管理员操作');
    if (on) {
      // 启用即出第一版，不必等到当天定时点
      const { runWikiUpdate } = await import('../agent/wiki.js');
      runWikiUpdate(id, '管理员启用').catch((e) => bus.activity('system', '群知识库首建失败', String(e).slice(0, 150)));
    }
    return c.json({ ok: true, chat: chats.byId(id) });
  });
  app.post('/api/chat/:id/wiki-run', async (c) => {
    const id = c.req.param('id');
    const chat = chats.byId(id);
    if (!chat) return c.json({ error: 'unknown chat' }, 404);
    if (!chat.wikiEnabled) return c.json({ error: '先启用群知识库' }, 400);
    const { runWikiUpdate } = await import('../agent/wiki.js');
    runWikiUpdate(id, '管理员手动').catch((e) => bus.activity('system', '群知识库手动更新失败', String(e).slice(0, 150)));
    return c.json({ ok: true });
  });
  // 换绑在线文档链接（后续 update_wiki 覆盖写入新文档）；传空链接 = 解绑，下次发布自动新建
  app.post('/api/chat/:id/wiki-doc', async (c) => {
    const id = c.req.param('id');
    const chat = chats.byId(id);
    if (!chat) return c.json({ error: 'unknown chat' }, 404);
    const { url } = await c.req.json<{ url: string }>();
    const trimmed = (url ?? '').trim();
    if (!trimmed) {
      chats.setWikiDoc(id, null, null);
      bus.changed('person');
      bus.activity('system', `群知识库文档已解绑（下次发布自动新建）`, chat.name ?? id.slice(0, 16));
      return c.json({ ok: true, chat: chats.byId(id) });
    }
    const token = /\/(?:docx|docs|wiki)\/([A-Za-z0-9_-]{10,})/.exec(trimmed)?.[1];
    if (!token) return c.json({ error: '无法从链接解析文档 token（需要飞书 docx 链接）' }, 400);
    chats.setWikiDoc(id, token, trimmed);
    bus.changed('person');
    bus.activity('system', `群知识库文档已换绑`, trimmed.slice(0, 80));
    return c.json({ ok: true, chat: chats.byId(id) });
  });

  // ===== Agent 运行轨迹（需求 3：OpenCode 原始轨迹，成员看自己的、管理员看全部——过滤在前端会话层）=====
  app.get('/api/agent-runs', (c) => {
    const pid = c.req.query('personId');
    return c.json({ runs: pid ? agentRuns.ofPerson(pid, 100) : agentRuns.all(100) });
  });
  app.get('/api/agent-run/:id/trace', (c) => {
    const id = c.req.param('id');
    if (!/^as-[0-9a-f]+$/.test(id)) return c.json({ error: 'bad id' }, 400);
    const run = agentRuns.byId(id);
    if (!run) return c.json({ error: 'not found' }, 404);
    let content = '';
    try {
      const buf = fs.readFileSync(tracePath(id));
      const MAX = 1024 * 1024;
      content = buf.subarray(-MAX).toString('utf-8');
    } catch {
      content = '';
    }
    return c.json({ run, trace: content, running: run.status === 'running' });
  });

  // ===== 心跳任务管理（需求 7：前端查看/编辑触发频率、时间、需求）=====
  app.get('/api/heartbeats', (c) => {
    const pid = c.req.query('personId');
    return c.json({ heartbeats: pid ? heartbeats.ofCreator(pid) : heartbeats.all() });
  });
  app.post('/api/heartbeat/:id/confirm', async (c) => {
    const { activateHeartbeat } = await import('../agent/heartbeat.js');
    const hb = activateHeartbeat(c.req.param('id'));
    if (!hb) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true, heartbeat: hb });
  });
  app.patch('/api/heartbeat/:id', async (c) => {
    const id = c.req.param('id');
    const hb = heartbeats.byId(id);
    if (!hb) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json<{
      requirement?: string; nextRunAt?: string; intervalMin?: number; totalRuns?: number;
      status?: 'active' | 'paused' | 'cancelled';
    }>();
    const patch: Parameters<typeof heartbeats.update>[1] = {};
    if (body.requirement?.trim()) patch.requirement = body.requirement.trim().slice(0, 2000);
    if (body.intervalMin !== undefined) {
      if (!Number.isFinite(body.intervalMin) || (body.intervalMin < 5 && body.intervalMin !== 0)) {
        return c.json({ error: '间隔必须 ≥5 分钟（0 = 一次性）' }, 400);
      }
      patch.intervalMin = Math.floor(body.intervalMin);
    }
    if (body.totalRuns !== undefined) {
      if (!Number.isFinite(body.totalRuns) || body.totalRuns < 0) return c.json({ error: '次数必须 ≥0（0 = 无限）' }, 400);
      patch.totalRuns = Math.floor(body.totalRuns);
    }
    if (body.nextRunAt !== undefined) {
      const t = new Date(body.nextRunAt).getTime();
      if (!Number.isFinite(t)) return c.json({ error: '下次触发时间无法解析' }, 400);
      patch.nextRunAt = new Date(t).toISOString();
      // 改时间同时把网格起点也挪过去，后续间隔从新时间起算
      patch.firstAt = new Date(t).toISOString();
    }
    if (body.status) {
      if (!['active', 'paused', 'cancelled'].includes(body.status)) return c.json({ error: 'bad status' }, 400);
      patch.status = body.status;
      if (body.status === 'active' && !hb.nextRunAt && !patch.nextRunAt) {
        // 恢复一个没有排期的任务：从现在按间隔排下一次
        patch.nextRunAt = new Date(Date.now() + Math.max(hb.intervalMin, 1) * 60_000).toISOString();
      }
      if (body.status === 'cancelled') patch.nextRunAt = null;
    }
    heartbeats.update(id, patch);
    bus.changed('task');
    bus.activity('task', `心跳任务已调整：${(patch.requirement ?? hb.requirement).slice(0, 40)}`, Object.keys(patch).join(' '));
    return c.json({ ok: true, heartbeat: heartbeats.byId(id) });
  });
  app.delete('/api/heartbeat/:id', (c) => {
    const id = c.req.param('id');
    const hb = heartbeats.byId(id);
    if (!hb) return c.json({ error: 'not found' }, 404);
    heartbeats.update(id, { status: 'cancelled', nextRunAt: null });
    bus.changed('task');
    bus.activity('task', `心跳任务已删除：${hb.requirement.slice(0, 40)}`);
    return c.json({ ok: true });
  });

  // ===== 任务手动调整（PRD-next N2/N3）=====
  app.patch('/api/task/:id', async (c) => {
    const id = c.req.param('id');
    const t = tasks.byId(id);
    if (!t) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json<{ important?: boolean; urgent?: boolean; dueAt?: string | null; status?: string }>();
    const patch: Record<string, unknown> = {};
    if (body.important !== undefined) patch.important = body.important;
    if (body.urgent !== undefined) patch.urgent = body.urgent;
    if (body.dueAt !== undefined) patch.dueAt = body.dueAt;
    if (body.status !== undefined && ['todo', 'cancelled', 'pending_confirm'].includes(body.status)) patch.status = body.status;
    tasks.update(id, patch);
    const updated = tasks.byId(id)!;
    bus.changed('task');
    bus.activity('task', `后台手动调整：${updated.title}`, Object.entries(body).map(([k, v]) => `${k}=${v}`).join(' '));
    const { syncTaskToBitable } = await import('../ledger/bitable.js');
    syncTaskToBitable(updated).catch(() => {});
    // 日程随台账走：取消删日程，改期改日程（新功能 4）
    const { removeTaskCalendarEvent, syncTaskCalendarEvent } = await import('../lark/calendar.js');
    if (body.status === 'cancelled') removeTaskCalendarEvent(updated, '后台取消').catch(() => {});
    else if (body.dueAt !== undefined && updated.status === 'todo') syncTaskCalendarEvent(updated).catch(() => {});
    return c.json({ ok: true, task: updated });
  });

  // ===== 任务详情（PRD-next N1.2：runs 历史 + 沙箱产物）=====
  app.get('/api/task/:id/detail', (c) => {
    const id = c.req.param('id');
    const t = tasks.byId(id);
    if (!t) return c.json({ error: 'not found' }, 404);
    const taskRuns = runs.ofTask(id);
    const owner = persons.byId(t.ownerId);
    const files: Array<{ name: string; path: string; exists: boolean }> = [];
    if (owner) {
      const brief = briefRel(t.ownerId, id);
      const draft = draftRel(t.ownerId, id);
      files.push(
        { name: 'brief.md（任务书）', path: brief.rel, exists: brief.exists },
        { name: 'draft.md（成稿）', path: draft.rel, exists: draft.exists },
      );
      // 任务目录里分身自己放的其它东西（notes/ 等）也一并透视
      const own = listWorkspaceFiles(t.ownerId).filter(
        (x) => !x.dir && x.path.startsWith(`tasks/${id}/`) && !files.some((f) => f.path === x.path),
      );
      for (const f of own.slice(0, 30)) {
        files.push({ name: f.path.replace(`tasks/${id}/`, ''), path: f.path, exists: true });
      }
      // 代码任务：repo 文件也可透视（沙箱完全可见）
      if (t.taskKind === 'code') {
        for (const f of listWorkspaceFiles(t.ownerId).filter((x) => !x.dir && x.path.startsWith('repo/')).slice(0, 30)) {
          files.push({ name: f.path.replace(/^repo\//, 'repo: '), path: f.path, exists: true });
        }
      }
    }
    return c.json({
      task: t, owner, runs: taskRuns, sandboxFiles: files,
      sandbox: {
        dir: `${config.workspacesRel}/${t.ownerId}/tasks/${id}/`,
        note: '一任务一目录：任务书、成稿、过程笔记都在这里。分身执行子进程 cwd 锁死在 '
          + `${config.workspacesRel}/${t.ownerId}/，只能读写本人工作区；`
          + '代码任务执行前后做全仓哈希快照核对变更',
      },
    });
  });

  // ===== 管理操作 =====
  app.post('/api/digest/run', async (c) => {
    generateAndSendDigest().catch((e) => bus.activity('system', '日报手动生成失败', String(e).slice(0, 200)));
    // 日报分层：手动触发也同时发个人日报
    const { generateAndSendPersonalDigests } = await import('../digest/index.js');
    generateAndSendPersonalDigests().catch((e) => bus.activity('system', '个人日报手动生成失败', String(e).slice(0, 200)));
    return c.json({ ok: true });
  });
  app.post('/api/digest/config', async (c) => {
    const { enabled, time } = await c.req.json<{ enabled?: boolean; time?: string }>();
    if (enabled !== undefined) digestState.enabled = enabled;
    if (time) digestState.time = time;
    return c.json({ ok: true, digest: { enabled: digestState.enabled, time: digestState.time } });
  });
  app.post('/api/review/toggle', async (c) => {
    const { on } = await c.req.json<{ on: boolean }>();
    setReviewEnabled(on);
    return c.json({ ok: true });
  });

  // ===== Agent MCP 端点（新需求 1：OpenCode 以 remote MCP 连入，Bearer=会话 token）=====
  mountAgentMcp(app);

  // ===== 跨端协同（跨端协同.md）：Everyone CLI / 本地客户端 / 时间穿透的云端后端 =====
  mountCollabApi(app);

  // ===== HTML 自动部署页面（新需求 3：不鉴权，24h 失效）=====
  app.get('/p/:id', async (c) => {
    const { getPage } = await import('../pages/index.js');
    const page = getPage(c.req.param('id'));
    if (page.state === 'ok') return c.html(page.html);
    if (page.state === 'expired') {
      return c.html(
        `<!doctype html><meta charset="utf-8"><title>页面已过期</title><body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;color:#333"><div style="text-align:center"><h2>「${page.title}」已过期</h2><p>部署页面 24 小时自动失效。需要的话在群里让分身重新生成一份。</p></div></body>`,
        410,
      );
    }
    return c.html('<!doctype html><meta charset="utf-8"><title>404</title><body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;color:#333"><h2>页面不存在</h2></body>', 404);
  });

  // ===== 渲染产物静态服务（mock UI 显示图片）=====
  app.use('/out/*', serveStatic({ root: path.relative(process.cwd(), config.root) || '.' }));

  // ===== admin 构建产物（生产模式一体化服务）=====
  const adminDist = path.join(config.root, 'apps/admin/dist');
  if (fs.existsSync(adminDist)) {
    app.use('/*', serveStatic({ root: path.relative(process.cwd(), adminDist) || '.' }));
  }

  serve({ fetch: app.fetch, port: config.serverPort }, (info) => {
    bus.activity('system', `admin API 已启动`, `http://localhost:${info.port}`);
  });
}

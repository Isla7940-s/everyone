import fs from 'node:fs';
import path from 'node:path';
import type { Context, Hono } from 'hono';
import { bus } from '../bus.js';
import { config } from '../config.js';
import { persons, tasks } from '../store/repo.js';
import {
  buildPierceWeek, finishHelp, saveHelpAttachment, weekStartOf,
} from './service.js';
import {
  SESSION_ID_RE, collabTokens, helpRequests, newSessionId, taskCompletions, timeEntries, workSessions,
  type HelpRow,
} from './store.js';

/**
 * 跨端协同 REST API（跨端协同.md §四）：Everyone CLI 与本地 Python 客户端的云端后端。
 * - /api/collab/*        本地侧接口（Bearer 鉴权：ct_ 个人 token / hs_ 求助沙箱 token）
 * - /api/collab/admin/*  前端接口（与现有 admin API 一致：演示环境不鉴权）
 * - /api/collab/kit/*    分发件（CLI / Skill / 本地客户端），本地一条 curl 就能装
 */

type Auth =
  | { via: 'person'; personId: string }
  | { via: 'sandbox'; help: HelpRow };

function authOf(c: Context): Auth | null {
  const raw = c.req.header('authorization') ?? '';
  const token = raw.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  if (token.startsWith('hs_')) {
    const help = helpRequests.bySandboxToken(token);
    return help ? { via: 'sandbox', help } : null;
  }
  const hit = collabTokens.resolve(token);
  return hit ? { via: 'person', personId: hit.personId } : null;
}

const err = (c: Context, status: 400 | 401 | 403 | 404 | 409, message: string) =>
  c.json({ error: message }, status);

/** 任务视图（CLI 输出口径）：附完成草稿与关联会话 */
function taskView(t: NonNullable<ReturnType<typeof tasks.byId>>) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    important: t.important,
    urgent: t.urgent,
    dueAt: t.dueAt,
    source: t.source,
    taskKind: t.taskKind,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    docUrl: t.docUrl,
    completionDraft: taskCompletions.draftOfTask(t.id),
    completion: taskCompletions.confirmedOfTask(t.id),
    sessions: workSessions.ofTask(t.id).map((s) => ({
      id: s.id, requirement: s.requirement, subtask: s.subtask, briefSummary: s.briefSummary, sessionAt: s.sessionAt,
    })),
  };
}

function sessionView(s: ReturnType<typeof workSessions.recent>[number]) {
  return { ...s, personName: persons.byId(s.personId)?.name ?? s.personId };
}

/** 求助视图：本地客户端领取后要还原上下文，带上目标会话总结 */
function helpView(h: HelpRow, opts: { withSandboxToken?: boolean } = {}) {
  const session = workSessions.byId(h.sessionId);
  const { sandboxToken, requesterWorkspaceDir: _drop, ...pub } = h;
  return {
    ...pub,
    personName: persons.byId(h.personId)?.name ?? h.personId,
    session: session
      ? {
          id: session.id, sourceTool: session.sourceTool, requirement: session.requirement,
          subtask: session.subtask, briefSummary: session.briefSummary, detailSummary: session.detailSummary,
          sessionAt: session.sessionAt, taskId: session.taskId,
        }
      : null,
    ...(opts.withSandboxToken ? { sandboxToken } : {}),
  };
}

export function mountCollabApi(app: Hono): void {
  // ===== 分发件（无鉴权：安装引导用）=====
  const kit: Record<string, { file: string; type: string }> = {
    cli: { file: path.join(config.root, 'cli/everyone.mjs'), type: 'text/javascript; charset=utf-8' },
    skill: { file: path.join(config.root, 'skills/everyone-collab/SKILL.md'), type: 'text/markdown; charset=utf-8' },
    'sandbox-skill': { file: path.join(config.root, 'skills/everyone-collab/SANDBOX_SKILL.md'), type: 'text/markdown; charset=utf-8' },
    client: { file: path.join(config.root, 'clients/everyone_local_client.py'), type: 'text/x-python; charset=utf-8' },
    install: { file: path.join(config.root, 'skills/everyone-collab/install.sh'), type: 'text/x-shellscript; charset=utf-8' },
  };
  app.get('/api/collab/kit/:name', (c) => {
    const entry = kit[c.req.param('name')];
    if (!entry) return err(c, 404, 'unknown kit');
    try {
      return c.body(fs.readFileSync(entry.file, 'utf-8'), 200, { 'content-type': entry.type });
    } catch {
      return err(c, 404, 'kit file missing');
    }
  });

  // ===== 前端接口（演示环境不鉴权，与现有 admin API 同规）=====
  app.post('/api/collab/admin/token', async (c) => {
    const { personId, label } = await c.req.json<{ personId: string; label?: string }>();
    const p = persons.byId(personId);
    if (!p) return err(c, 404, 'unknown person');
    const token = collabTokens.issue(personId, label ?? 'cli');
    bus.activity('system', `签发跨端协同 token：${p.name}`, label ?? 'cli');
    return c.json({ ok: true, token });
  });
  app.get('/api/collab/admin/tokens', (c) => {
    const pid = c.req.query('personId') ?? '';
    if (!persons.byId(pid)) return err(c, 404, 'unknown person');
    return c.json({ tokens: collabTokens.ofPerson(pid) });
  });
  app.delete('/api/collab/admin/token/:token', (c) => {
    collabTokens.revoke(c.req.param('token'));
    return c.json({ ok: true });
  });
  app.get('/api/collab/admin/pierce', (c) => {
    const pid = c.req.query('personId') ?? '';
    if (!persons.byId(pid)) return err(c, 404, 'unknown person');
    return c.json(buildPierceWeek(pid, c.req.query('week')));
  });
  /** 团队周总览（管理员）：每人每日总分钟，用于成员切换与横向对比 */
  app.get('/api/collab/admin/overview', (c) => {
    const weekStart = weekStartOf(c.req.query('week'));
    const members = persons.all().map((p) => {
      const week = buildPierceWeek(p.id, weekStart);
      return {
        personId: p.id,
        name: p.name,
        avatarColor: p.avatarColor,
        totalMinutes: week.totalMinutes,
        dayMinutes: week.days.map((d) => d.totalMinutes),
      };
    });
    return c.json({ weekStart, members });
  });
  /** 成员「跨端协同」页数据：最近总结 + 求助记录 + token */
  app.get('/api/collab/admin/state', (c) => {
    const pid = c.req.query('personId') ?? '';
    if (!persons.byId(pid)) return err(c, 404, 'unknown person');
    return c.json({
      sessions: workSessions.recent({ personId: pid, limit: 30 }).map(sessionView),
      helps: helpRequests.ofPerson(pid, 20).map((h) => helpView(h)),
      tokens: collabTokens.ofPerson(pid),
      baseUrl: config.publicBaseUrl,
    });
  });

  // ===== 本地侧接口（Bearer 鉴权）=====

  app.get('/api/collab/whoami', (c) => {
    const auth = authOf(c);
    if (!auth) return err(c, 401, '缺少或无效的 token（个人 token 在后台「跨端协同」页生成）');
    if (auth.via === 'sandbox') {
      return c.json({ mode: 'sandbox', helpId: auth.help.id, status: auth.help.status });
    }
    const p = persons.byId(auth.personId)!;
    return c.json({ mode: 'person', personId: p.id, name: p.name });
  });

  // --- 任务与排期（§四）---
  app.get('/api/collab/tasks', (c) => {
    const auth = authOf(c);
    if (!auth || auth.via !== 'person') return err(c, 401, '需要个人 token');
    const all = c.req.query('all') === '1';
    const list = tasks.all({ ownerId: auth.personId }).filter((t) => all || !['published', 'cancelled'].includes(t.status));
    // 排期口径：截止时间升序（无截止的排最后）
    list.sort((a, b) => (a.dueAt ?? '9999') < (b.dueAt ?? '9999') ? -1 : 1);
    return c.json({ tasks: list.map(taskView) });
  });
  app.get('/api/collab/tasks/:id', (c) => {
    const auth = authOf(c);
    if (!auth || auth.via !== 'person') return err(c, 401, '需要个人 token');
    const t = tasks.byId(c.req.param('id'));
    if (!t || t.ownerId !== auth.personId) return err(c, 404, '任务不存在或不属于你');
    return c.json({ task: taskView(t) });
  });
  /** 上报任务完成草稿（§四/§七）：草稿不改任务状态，等用户确认；可随稿带产出物附件 */
  app.post('/api/collab/tasks/:id/completion-draft', async (c) => {
    const auth = authOf(c);
    if (!auth || auth.via !== 'person') return err(c, 401, '需要个人 token');
    const t = tasks.byId(c.req.param('id'));
    if (!t || t.ownerId !== auth.personId) return err(c, 404, '任务不存在或不属于你');
    const body = await c.req.json<{
      note: string; leftover?: string; sessionIds?: string[];
      attachments?: Array<{ filename: string; contentBase64: string }>;
    }>();
    if (!body.note?.trim()) return err(c, 400, 'note（完成说明）不能为空');
    // 产出物/证据附件落盘（§七：上传成功后保存相关附件或证据）
    const saved: Array<{ name: string; relPath: string; size: number }> = [];
    for (const a of (body.attachments ?? []).slice(0, 10)) {
      if (!a.filename?.trim()) return err(c, 400, '附件缺少 filename');
      let buf: Buffer;
      try { buf = Buffer.from(a.contentBase64 ?? '', 'base64'); } catch { return err(c, 400, `附件 ${a.filename} base64 解码失败`); }
      if (!buf.length) return err(c, 400, `附件 ${a.filename} 内容为空`);
      if (buf.length > 10 * 1024 * 1024) return err(c, 400, `附件 ${a.filename} 超过 10MB`);
      const safe = (path.basename(a.filename) || 'attachment').replace(/[^\w.\u4e00-\u9fa5-]+/g, '_').slice(0, 120);
      const dir = path.join(config.dataDir, 'collab', 'completions', t.id);
      fs.mkdirSync(dir, { recursive: true });
      const abs = path.join(dir, safe);
      fs.writeFileSync(abs, buf);
      saved.push({ name: safe, relPath: path.relative(config.dataDir, abs), size: buf.length });
    }
    const draft = taskCompletions.saveDraft({
      taskId: t.id, personId: auth.personId, note: body.note.trim().slice(0, 4000),
      leftover: body.leftover?.trim() || null,
      sessionIds: (body.sessionIds ?? []).filter((s) => SESSION_ID_RE.test(s)).slice(0, 20),
      attachments: saved,
    });
    bus.activity('task', `任务完成草稿已上报：${t.title}`, `等本人确认后正式提交${saved.length ? ` · ${saved.length} 个附件` : ''}`);
    return c.json({ ok: true, draft });
  });
  /** 正式提交任务完成（§七）：必须显式 confirmed；成功后任务直接标记完成 */
  app.post('/api/collab/tasks/:id/complete', async (c) => {
    const auth = authOf(c);
    if (!auth || auth.via !== 'person') return err(c, 401, '需要个人 token');
    const t = tasks.byId(c.req.param('id'));
    if (!t || t.ownerId !== auth.personId) return err(c, 404, '任务不存在或不属于你');
    if (['published', 'cancelled'].includes(t.status)) return err(c, 409, `任务已是终态（${t.status}）`);
    const body = await c.req.json<{ confirmed?: boolean; note?: string; leftover?: string; sessionIds?: string[] }>();
    if (body.confirmed !== true) {
      return err(c, 400, '缺少 confirmed=true——任务完成必须先经用户确认（先传草稿给用户看，用户答应了再带 confirmed 提交）');
    }
    // 参数优先，缺省回落到已上报的草稿
    const draft = taskCompletions.draftOfTask(t.id);
    const note = body.note?.trim() || draft?.note || '';
    if (!note) return err(c, 400, '缺少 note（完成说明）：直接传 note，或先上报 completion-draft');
    const sessionIds = (body.sessionIds ?? draft?.sessionIds ?? []).filter((s) => SESSION_ID_RE.test(s)).slice(0, 20);
    const saved = draft && !body.note && !body.leftover && !body.sessionIds
      ? draft
      : taskCompletions.saveDraft({
          taskId: t.id, personId: auth.personId, note,
          leftover: body.leftover?.trim() || draft?.leftover || null, sessionIds,
          attachments: draft?.attachments ?? [], // 覆盖参数时保留草稿已传的产出物附件
        });
    const completion = taskCompletions.confirm(saved.id)!;
    // 关联工作会话（会话反向挂到任务上，详情/穿透都能带出）
    for (const sid of sessionIds) {
      const s = workSessions.byId(sid);
      if (s && s.personId === auth.personId) workSessions.upsert({ ...s, taskId: t.id });
    }
    tasks.update(t.id, { status: 'published' });
    const updated = tasks.byId(t.id)!;
    bus.changed('task');
    bus.activity('task', `任务完成（本地 Agent 经确认上传）：${t.title}`, note.slice(0, 100));
    import('../ledger/bitable.js').then(({ syncTaskToBitable }) => syncTaskToBitable(updated).catch(() => {})).catch(() => {});
    return c.json({ ok: true, task: taskView(updated), completion });
  });

  // --- 工作会话总结（§四/§五）---
  app.post('/api/collab/sessions', async (c) => {
    const auth = authOf(c);
    if (!auth || auth.via !== 'person') return err(c, 401, '需要个人 token');
    const b = await c.req.json<{
      id?: string; tool?: string; requirement?: string; subtask?: string;
      brief?: string; detail?: string; at?: string; taskId?: string;
    }>();
    const missing = (['tool', 'requirement', 'subtask', 'brief', 'detail'] as const).filter((k) => !b[k]?.trim());
    if (missing.length) return err(c, 400, `缺少字段：${missing.join('、')}`);
    let id = (b.id ?? '').trim().toUpperCase();
    if (id && !SESSION_ID_RE.test(id)) return err(c, 400, '会话 ID 必须是 16 位字母数字');
    if (!id) id = newSessionId();
    const exists = workSessions.byId(id);
    if (exists && exists.personId !== auth.personId) return err(c, 409, '该会话 ID 已被其他成员占用');
    if (b.taskId) {
      const t = tasks.byId(b.taskId);
      if (!t || t.ownerId !== auth.personId) return err(c, 400, `关联任务 ${b.taskId} 不存在或不属于你`);
    }
    const at = b.at ? new Date(b.at) : new Date();
    if (!Number.isFinite(at.getTime())) return err(c, 400, 'at 时间无法解析（用 ISO 格式）');
    const session = workSessions.upsert({
      id,
      personId: auth.personId,
      sourceTool: b.tool!.trim().toLowerCase().slice(0, 30),
      requirement: b.requirement!.trim().slice(0, 60),
      subtask: b.subtask!.trim().slice(0, 60),
      briefSummary: b.brief!.trim().slice(0, 60),
      detailSummary: b.detail!.trim().slice(0, 400),
      sessionAt: at.toISOString(),
      taskId: b.taskId ?? null,
    });
    bus.activity('run', `${persons.byId(auth.personId)?.name} 上传工作总结`, `[${session.id}] ${session.requirement} / ${session.subtask}`);
    return c.json({ ok: true, session });
  });
  app.get('/api/collab/sessions', (c) => {
    const auth = authOf(c);
    if (!auth || auth.via !== 'person') return err(c, 401, '需要个人 token');
    const keyword = (c.req.query('keyword') ?? '').trim();
    const mine = c.req.query('mine') !== '0'; // 默认查自己的
    const personId = mine ? auth.personId : null;
    const limit = Number(c.req.query('limit') ?? 20);
    const list = keyword
      ? workSessions.search(keyword.split(/\s+/).filter(Boolean), { personId, limit })
      : workSessions.recent({ personId, limit, days: Number(c.req.query('days')) || undefined });
    return c.json({ sessions: list.map(sessionView) });
  });
  app.get('/api/collab/sessions/:id', (c) => {
    const auth = authOf(c);
    if (!auth || auth.via !== 'person') return err(c, 401, '需要个人 token');
    const s = workSessions.byId(c.req.param('id'));
    if (!s) return err(c, 404, '会话不存在');
    const task = s.taskId ? tasks.byId(s.taskId) : null;
    return c.json({
      session: sessionView(s),
      task: task ? { id: task.id, title: task.title, status: task.status, dueAt: task.dueAt } : null,
    });
  });
  app.get('/api/collab/sessions/:id/related', (c) => {
    const auth = authOf(c);
    if (!auth || auth.via !== 'person') return err(c, 401, '需要个人 token');
    const s = workSessions.byId(c.req.param('id'));
    if (!s) return err(c, 404, '会话不存在');
    return c.json({ sessions: workSessions.related(s, Number(c.req.query('limit') ?? 10)).map(sessionView) });
  });

  // --- 时间去向（§四/§七）---
  app.post('/api/collab/time-entries', async (c) => {
    const auth = authOf(c);
    if (!auth || auth.via !== 'person') return err(c, 401, '需要个人 token');
    const b = await c.req.json<{
      date?: string; confirmed?: boolean;
      entries?: Array<{
        requirement: string; subtask: string; sessionId?: string; startedAt?: string; endedAt?: string;
        minutes?: number; briefSummary?: string; detailSummary?: string; sourceTool?: string;
      }>;
    }>();
    if (b.confirmed !== true) {
      return err(c, 400, '缺少 confirmed=true——时间去向必须先给用户看草稿，用户确认后再正式上传');
    }
    const date = (b.date ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return err(c, 400, 'date 必须是 YYYY-MM-DD');
    if (!Array.isArray(b.entries) || !b.entries.length) return err(c, 400, 'entries 不能为空');
    if (b.entries.length > 60) return err(c, 400, '一天最多 60 条记录');
    const normalized = [];
    for (const [i, e] of b.entries.entries()) {
      if (!e.requirement?.trim() || !e.subtask?.trim()) return err(c, 400, `第 ${i + 1} 条缺少 requirement/subtask`);
      let minutes = Number(e.minutes ?? 0);
      if ((!minutes || minutes <= 0) && e.startedAt && e.endedAt) {
        minutes = Math.round((new Date(e.endedAt).getTime() - new Date(e.startedAt).getTime()) / 60_000);
      }
      if (!Number.isFinite(minutes) || minutes <= 0) {
        return err(c, 400, `第 ${i + 1} 条无法确定时长：传 minutes，或同时传 startedAt/endedAt`);
      }
      if (e.sessionId && !workSessions.byId(e.sessionId)) {
        return err(c, 400, `第 ${i + 1} 条关联的会话 ${e.sessionId} 不存在（先上传会话总结）`);
      }
      normalized.push({
        requirement: e.requirement.trim().slice(0, 60),
        subtask: e.subtask.trim().slice(0, 60),
        sessionId: e.sessionId?.toUpperCase() ?? null,
        startedAt: e.startedAt ?? null,
        endedAt: e.endedAt ?? null,
        minutes: Math.min(minutes, 24 * 60),
        briefSummary: e.briefSummary?.trim().slice(0, 60) || null,
        detailSummary: e.detailSummary?.trim().slice(0, 400) || null,
        sourceTool: e.sourceTool?.trim().toLowerCase().slice(0, 30) || null,
      });
    }
    const saved = timeEntries.replaceDay(auth.personId, date, normalized);
    const total = saved.reduce((acc, x) => acc + x.minutes, 0);
    bus.activity('run', `${persons.byId(auth.personId)?.name} 上传时间去向`, `${date} · ${saved.length} 条 · 共 ${(total / 60).toFixed(1)}h`);
    bus.changed('run');
    return c.json({ ok: true, date, entries: saved, totalMinutes: total });
  });
  app.get('/api/collab/time-entries', (c) => {
    const auth = authOf(c);
    if (!auth || auth.via !== 'person') return err(c, 401, '需要个人 token');
    const week = buildPierceWeek(auth.personId, c.req.query('week'));
    return c.json(week);
  });

  // --- 远程求助（§四/§十：本地客户端接口）---
  app.get('/api/collab/help/pending', (c) => {
    const auth = authOf(c);
    if (!auth || auth.via !== 'person') return err(c, 401, '需要个人 token');
    return c.json({ helps: helpRequests.pendingOf(auth.personId).map((h) => helpView(h)) });
  });
  app.get('/api/collab/help', (c) => {
    const auth = authOf(c);
    if (!auth || auth.via !== 'person') return err(c, 401, '需要个人 token');
    return c.json({ helps: helpRequests.ofPerson(auth.personId, Number(c.req.query('limit') ?? 30)).map((h) => helpView(h)) });
  });
  app.get('/api/collab/help/:id', (c) => {
    const auth = authOf(c);
    if (!auth) return err(c, 401, '需要 token');
    const h = helpRequests.byId(c.req.param('id'));
    if (!h) return err(c, 404, '求助不存在');
    if (auth.via === 'sandbox' && auth.help.id !== h.id) return err(c, 403, '沙箱 token 只能查询本次求助');
    if (auth.via === 'person' && h.personId !== auth.personId) return err(c, 403, '这个求助不是发给你的');
    return c.json({ help: helpView(h) });
  });
  /** 领取求助（本地客户端）：返回沙箱 token（连同任务一起放进沙箱） */
  app.post('/api/collab/help/:id/claim', (c) => {
    const auth = authOf(c);
    if (!auth || auth.via !== 'person') return err(c, 401, '需要个人 token');
    const h = helpRequests.byId(c.req.param('id'));
    if (!h) return err(c, 404, '求助不存在');
    if (h.personId !== auth.personId) return err(c, 403, '这个求助不是发给你的');
    const claimed = helpRequests.claim(h.id);
    if (!claimed) return err(c, 409, `求助已被处理（当前状态 ${h.status}）`);
    bus.activity('run', `本地客户端领取远程求助`, `${persons.byId(h.personId)?.name} · ${h.question.slice(0, 60)}`);
    return c.json({ ok: true, help: helpView(claimed, { withSandboxToken: true }) });
  });
  app.post('/api/collab/help/:id/status', async (c) => {
    const auth = authOf(c);
    if (!auth) return err(c, 401, '需要 token');
    const h = helpRequests.byId(c.req.param('id'));
    if (!h) return err(c, 404, '求助不存在');
    if (auth.via === 'sandbox' && auth.help.id !== h.id) return err(c, 403, '沙箱 token 只能操作本次求助');
    if (auth.via === 'person' && h.personId !== auth.personId) return err(c, 403, '这个求助不是发给你的');
    const { status } = await c.req.json<{ status: string }>();
    if (status !== 'running') return err(c, 400, '只支持置为 running');
    helpRequests.markRunning(h.id);
    return c.json({ ok: true });
  });
  /** 提交回复（沙箱 CLI 的两项能力之一；本地客户端兜底也走这里） */
  app.post('/api/collab/help/:id/reply', async (c) => {
    const auth = authOf(c);
    if (!auth) return err(c, 401, '需要 token');
    const h = helpRequests.byId(c.req.param('id'));
    if (!h) return err(c, 404, '求助不存在');
    if (auth.via === 'sandbox' && auth.help.id !== h.id) return err(c, 403, '沙箱 token 只能回复本次求助');
    if (auth.via === 'person' && h.personId !== auth.personId) return err(c, 403, '这个求助不是发给你的');
    if (h.status === 'succeeded' || h.status === 'failed') return err(c, 409, `求助已结束（${h.status}），不能重复提交`);
    const b = await c.req.json<{ text?: string; note?: string; status?: string; error?: string }>();
    const status = b.status === 'failed' ? 'failed' : 'succeeded';
    const text = (b.text ?? '').trim();
    if (status === 'succeeded' && !text) return err(c, 400, 'text（文字回复）不能为空');
    const updated = finishHelp(h.id, {
      status,
      replyText: text || null,
      replyNote: b.note?.trim() || null,
      error: status === 'failed' ? (b.error?.trim() || '本地执行失败（未提供原因）') : null,
    });
    return c.json({ ok: true, help: updated ? helpView(updated) : null });
  });
  /** 上传附件（沙箱 CLI 的两项能力之二）：落库并同步进发起方云端沙箱 */
  app.post('/api/collab/help/:id/attachments', async (c) => {
    const auth = authOf(c);
    if (!auth) return err(c, 401, '需要 token');
    const h = helpRequests.byId(c.req.param('id'));
    if (!h) return err(c, 404, '求助不存在');
    if (auth.via === 'sandbox' && auth.help.id !== h.id) return err(c, 403, '沙箱 token 只能上传到本次求助');
    if (auth.via === 'person' && h.personId !== auth.personId) return err(c, 403, '这个求助不是发给你的');
    if (h.status === 'succeeded' || h.status === 'failed') return err(c, 409, '求助已结束，先于 reply 前上传附件');
    const b = await c.req.json<{ filename?: string; contentBase64?: string }>();
    if (!b.filename?.trim()) return err(c, 400, '缺少 filename');
    let buf: Buffer;
    try {
      buf = Buffer.from(b.contentBase64 ?? '', 'base64');
    } catch {
      return err(c, 400, 'contentBase64 解码失败');
    }
    if (!buf.length) return err(c, 400, '附件内容为空');
    if (buf.length > 10 * 1024 * 1024) return err(c, 400, '附件最大 10MB');
    const saved = saveHelpAttachment(h, b.filename.trim(), buf);
    return c.json({ ok: true, attachment: { name: path.basename(saved.relPath), size: saved.size } });
  });
}

import { randomBytes, randomUUID } from 'node:crypto';
import type { HelpRequest, HelpStatus, TaskCompletion, TimeEntry, WorkSession } from '@everyone/shared';
import { db } from '../store/db.js';

/**
 * 跨端协同数据层（跨端协同.md）：
 * 工作会话总结 / 时间去向 / 任务完成记录 / 远程求助 / 本地 CLI 凭证。
 * 隐私边界（§五）：云端只存总结与元数据，完整聊天原文永远留在用户本地。
 */

db.exec(`
CREATE TABLE IF NOT EXISTS work_sessions (
  id TEXT PRIMARY KEY,              -- 16 位字母数字（本地按此 ID 还原原文）
  person_id TEXT NOT NULL,
  source_tool TEXT NOT NULL,        -- codex / cursor / claude-code / ...
  requirement TEXT NOT NULL,        -- 大需求名称（统一命名，聚合键）
  subtask TEXT NOT NULL,            -- 子任务名称
  brief_summary TEXT NOT NULL,      -- 25 字短总结
  detail_summary TEXT NOT NULL,     -- 100 字详细总结
  session_at TEXT NOT NULL,
  task_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_sessions_person ON work_sessions(person_id, session_at);

CREATE TABLE IF NOT EXISTS time_entries (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  date TEXT NOT NULL,               -- YYYY-MM-DD（本地日）
  requirement TEXT NOT NULL,
  subtask TEXT NOT NULL,
  session_id TEXT,
  started_at TEXT,
  ended_at TEXT,
  minutes INTEGER NOT NULL,
  brief_summary TEXT,
  detail_summary TEXT,
  source_tool TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_time_entries_person_date ON time_entries(person_id, date);

CREATE TABLE IF NOT EXISTS task_completions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  status TEXT NOT NULL,             -- draft / confirmed
  note TEXT NOT NULL,
  leftover TEXT,
  session_ids TEXT NOT NULL,        -- JSON 数组
  attachments TEXT NOT NULL,        -- JSON 数组 [{name, relPath, size}]
  created_at TEXT NOT NULL,
  confirmed_at TEXT
);

CREATE TABLE IF NOT EXISTS help_requests (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,         -- 目标工作会话
  person_id TEXT NOT NULL,          -- 目标用户（会话归属人）
  question TEXT NOT NULL,
  background TEXT,
  expectation TEXT,
  context_info TEXT,
  status TEXT NOT NULL,             -- pending / claimed / running / succeeded / failed
  reply_text TEXT,
  reply_note TEXT,
  error TEXT,
  sandbox_token TEXT NOT NULL,      -- 沙箱 CLI 专用 token（只能回复本求助）
  requester_label TEXT,
  requester_person_id TEXT,
  requester_workspace_dir TEXT,     -- 附件同步目的地（发起求助的云端沙箱）
  claimed_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_help_requests_person ON help_requests(person_id, status);

CREATE TABLE IF NOT EXISTS help_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  help_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  rel_path TEXT NOT NULL,           -- DATA_DIR 下相对路径
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collab_tokens (
  token TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
`);

const now = () => new Date().toISOString();

// ===== 会话 ID（§五：16 位字母数字）=====

/** 去掉易混淆字符（0O1IL）的大写字母数字表 */
const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newSessionId(): string {
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i += 1) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

export const SESSION_ID_RE = /^[A-Za-z0-9]{16}$/;

// ===== work_sessions =====

function rowToSession(r: any): WorkSession {
  return {
    id: r.id,
    personId: r.person_id,
    sourceTool: r.source_tool,
    requirement: r.requirement,
    subtask: r.subtask,
    briefSummary: r.brief_summary,
    detailSummary: r.detail_summary,
    sessionAt: r.session_at,
    taskId: r.task_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const workSessions = {
  upsert(s: {
    id: string; personId: string; sourceTool: string; requirement: string; subtask: string;
    briefSummary: string; detailSummary: string; sessionAt: string; taskId?: string | null;
  }): WorkSession {
    const ts = now();
    db.prepare(
      `INSERT INTO work_sessions (id, person_id, source_tool, requirement, subtask, brief_summary, detail_summary, session_at, task_id, created_at, updated_at)
       VALUES (@id, @personId, @sourceTool, @requirement, @subtask, @briefSummary, @detailSummary, @sessionAt, @taskId, @ts, @ts)
       ON CONFLICT(id) DO UPDATE SET
         source_tool=@sourceTool, requirement=@requirement, subtask=@subtask,
         brief_summary=@briefSummary, detail_summary=@detailSummary,
         session_at=@sessionAt, task_id=COALESCE(@taskId, work_sessions.task_id), updated_at=@ts`,
    ).run({ ...s, taskId: s.taskId ?? null, ts });
    return this.byId(s.id)!;
  },
  byId(id: string): WorkSession | null {
    const r = db.prepare(`SELECT * FROM work_sessions WHERE id=?`).get(id.toUpperCase())
      ?? db.prepare(`SELECT * FROM work_sessions WHERE id=?`).get(id);
    return r ? rowToSession(r) : null;
  },
  recent(args: { personId?: string | null; limit?: number; days?: number } = {}): WorkSession[] {
    const conds: string[] = [];
    const vals: unknown[] = [];
    if (args.personId) { conds.push(`person_id=?`); vals.push(args.personId); }
    if (args.days) { conds.push(`session_at>=?`); vals.push(new Date(Date.now() - args.days * 86400_000).toISOString()); }
    const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
    return db.prepare(`SELECT * FROM work_sessions${where} ORDER BY session_at DESC LIMIT ?`)
      .all(...vals, Math.min(args.limit ?? 20, 100)).map(rowToSession);
  },
  /** 关键词检索（多关键词 AND，命中总结/需求/子任务任一字段） */
  search(keywords: string[], args: { personId?: string | null; limit?: number } = {}): WorkSession[] {
    const conds: string[] = [];
    const vals: unknown[] = [];
    for (const kw of keywords.slice(0, 6)) {
      conds.push(`(brief_summary LIKE ? OR detail_summary LIKE ? OR requirement LIKE ? OR subtask LIKE ?)`);
      const like = `%${kw}%`;
      vals.push(like, like, like, like);
    }
    if (args.personId) { conds.push(`person_id=?`); vals.push(args.personId); }
    const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
    return db.prepare(`SELECT * FROM work_sessions${where} ORDER BY session_at DESC LIMIT ?`)
      .all(...vals, Math.min(args.limit ?? 20, 50)).map(rowToSession);
  },
  /** 相关会话：同大需求（优先同子任务）的其他会话 */
  related(session: WorkSession, limit = 10): WorkSession[] {
    return db.prepare(
      `SELECT * FROM work_sessions WHERE id!=? AND requirement=?
       ORDER BY (subtask=?) DESC, session_at DESC LIMIT ?`,
    ).all(session.id, session.requirement, session.subtask, Math.min(limit, 30)).map(rowToSession);
  },
  ofTask(taskId: string): WorkSession[] {
    return db.prepare(`SELECT * FROM work_sessions WHERE task_id=? ORDER BY session_at`).all(taskId).map(rowToSession);
  },
};

// ===== time_entries =====

function rowToEntry(r: any): TimeEntry {
  return {
    id: r.id,
    personId: r.person_id,
    date: r.date,
    requirement: r.requirement,
    subtask: r.subtask,
    sessionId: r.session_id ?? null,
    startedAt: r.started_at ?? null,
    endedAt: r.ended_at ?? null,
    minutes: r.minutes,
    briefSummary: r.brief_summary ?? null,
    detailSummary: r.detail_summary ?? null,
    sourceTool: r.source_tool ?? null,
    createdAt: r.created_at,
  };
}

export const timeEntries = {
  /** 正式上传一天的时间去向（§七）：同人同日整体替换，允许当天多次修正 */
  replaceDay(personId: string, date: string, entries: Array<{
    requirement: string; subtask: string; sessionId?: string | null;
    startedAt?: string | null; endedAt?: string | null; minutes: number;
    briefSummary?: string | null; detailSummary?: string | null; sourceTool?: string | null;
  }>): TimeEntry[] {
    const insert = db.prepare(
      `INSERT INTO time_entries (id, person_id, date, requirement, subtask, session_id, started_at, ended_at, minutes, brief_summary, detail_summary, source_tool, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM time_entries WHERE person_id=? AND date=?`).run(personId, date);
      for (const e of entries) {
        insert.run(
          `te-${randomUUID().slice(0, 8)}`, personId, date, e.requirement, e.subtask,
          e.sessionId ?? null, e.startedAt ?? null, e.endedAt ?? null, Math.max(1, Math.round(e.minutes)),
          e.briefSummary ?? null, e.detailSummary ?? null, e.sourceTool ?? null, now(),
        );
      }
    });
    tx();
    return this.ofDay(personId, date);
  },
  ofDay(personId: string, date: string): TimeEntry[] {
    return db.prepare(`SELECT * FROM time_entries WHERE person_id=? AND date=? ORDER BY started_at, created_at`)
      .all(personId, date).map(rowToEntry);
  },
  ofRange(personId: string, fromDate: string, toDate: string): TimeEntry[] {
    return db.prepare(`SELECT * FROM time_entries WHERE person_id=? AND date>=? AND date<=? ORDER BY date, started_at`)
      .all(personId, fromDate, toDate).map(rowToEntry);
  },
};

// ===== task_completions =====

function rowToCompletion(r: any): TaskCompletion {
  return {
    id: r.id,
    taskId: r.task_id,
    personId: r.person_id,
    status: r.status,
    note: r.note,
    leftover: r.leftover ?? null,
    sessionIds: JSON.parse(r.session_ids || '[]'),
    attachments: JSON.parse(r.attachments || '[]'),
    createdAt: r.created_at,
    confirmedAt: r.confirmed_at ?? null,
  };
}

export const taskCompletions = {
  saveDraft(c: {
    taskId: string; personId: string; note: string; leftover?: string | null;
    sessionIds?: string[]; attachments?: Array<{ name: string; relPath: string; size: number }>;
  }): TaskCompletion {
    // 一任务一草稿：新草稿覆盖旧草稿
    db.prepare(`DELETE FROM task_completions WHERE task_id=? AND status='draft'`).run(c.taskId);
    const id = `tc-${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO task_completions (id, task_id, person_id, status, note, leftover, session_ids, attachments, created_at)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
    ).run(id, c.taskId, c.personId, c.note, c.leftover ?? null,
      JSON.stringify(c.sessionIds ?? []), JSON.stringify(c.attachments ?? []), now());
    return this.byId(id)!;
  },
  confirm(id: string): TaskCompletion | null {
    db.prepare(`UPDATE task_completions SET status='confirmed', confirmed_at=? WHERE id=?`).run(now(), id);
    return this.byId(id);
  },
  byId(id: string): TaskCompletion | null {
    const r = db.prepare(`SELECT * FROM task_completions WHERE id=?`).get(id);
    return r ? rowToCompletion(r) : null;
  },
  draftOfTask(taskId: string): TaskCompletion | null {
    const r = db.prepare(`SELECT * FROM task_completions WHERE task_id=? AND status='draft' ORDER BY created_at DESC LIMIT 1`).get(taskId);
    return r ? rowToCompletion(r) : null;
  },
  confirmedOfTask(taskId: string): TaskCompletion | null {
    const r = db.prepare(`SELECT * FROM task_completions WHERE task_id=? AND status='confirmed' ORDER BY confirmed_at DESC LIMIT 1`).get(taskId);
    return r ? rowToCompletion(r) : null;
  },
};

// ===== help_requests =====

function rowToHelp(r: any): HelpRequest & { sandboxToken: string; requesterWorkspaceDir: string | null } {
  return {
    id: r.id,
    sessionId: r.session_id,
    personId: r.person_id,
    question: r.question,
    background: r.background ?? null,
    expectation: r.expectation ?? null,
    contextInfo: r.context_info ?? null,
    status: r.status as HelpStatus,
    replyText: r.reply_text ?? null,
    replyNote: r.reply_note ?? null,
    error: r.error ?? null,
    requesterLabel: r.requester_label ?? null,
    requesterPersonId: r.requester_person_id ?? null,
    attachments: helpAttachments.ofHelp(r.id),
    claimedAt: r.claimed_at ?? null,
    finishedAt: r.finished_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sandboxToken: r.sandbox_token,
    requesterWorkspaceDir: r.requester_workspace_dir ?? null,
  };
}

export type HelpRow = ReturnType<typeof rowToHelp>;

export const helpRequests = {
  create(h: {
    sessionId: string; personId: string; question: string;
    background?: string | null; expectation?: string | null; contextInfo?: string | null;
    requesterLabel?: string | null; requesterPersonId?: string | null; requesterWorkspaceDir?: string | null;
  }): HelpRow {
    const id = `hr-${randomUUID().slice(0, 8)}`;
    const ts = now();
    db.prepare(
      `INSERT INTO help_requests (id, session_id, person_id, question, background, expectation, context_info, status, sandbox_token, requester_label, requester_person_id, requester_workspace_dir, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, h.sessionId, h.personId, h.question, h.background ?? null, h.expectation ?? null, h.contextInfo ?? null,
      `hs_${randomUUID().replaceAll('-', '')}`, h.requesterLabel ?? null, h.requesterPersonId ?? null,
      h.requesterWorkspaceDir ?? null, ts, ts,
    );
    return this.byId(id)!;
  },
  byId(id: string): HelpRow | null {
    const r = db.prepare(`SELECT * FROM help_requests WHERE id=?`).get(id);
    return r ? rowToHelp(r) : null;
  },
  bySandboxToken(token: string): HelpRow | null {
    const r = db.prepare(`SELECT * FROM help_requests WHERE sandbox_token=?`).get(token);
    return r ? rowToHelp(r) : null;
  },
  /** 待本地领取的求助（目标用户视角） */
  pendingOf(personId: string): HelpRow[] {
    return db.prepare(`SELECT * FROM help_requests WHERE person_id=? AND status='pending' ORDER BY created_at`)
      .all(personId).map(rowToHelp);
  },
  ofPerson(personId: string, limit = 30): HelpRow[] {
    return db.prepare(`SELECT * FROM help_requests WHERE person_id=? ORDER BY created_at DESC LIMIT ?`)
      .all(personId, limit).map(rowToHelp);
  },
  all(limit = 50): HelpRow[] {
    return db.prepare(`SELECT * FROM help_requests ORDER BY created_at DESC LIMIT ?`).all(limit).map(rowToHelp);
  },
  claim(id: string): HelpRow | null {
    const r = db.prepare(
      `UPDATE help_requests SET status='claimed', claimed_at=?, updated_at=? WHERE id=? AND status='pending'`,
    ).run(now(), now(), id);
    return r.changes ? this.byId(id) : null;
  },
  markRunning(id: string): void {
    db.prepare(`UPDATE help_requests SET status='running', updated_at=? WHERE id=? AND status IN ('pending','claimed')`)
      .run(now(), id);
  },
  finish(id: string, args: { status: 'succeeded' | 'failed'; replyText?: string | null; replyNote?: string | null; error?: string | null }): HelpRow | null {
    db.prepare(
      `UPDATE help_requests SET status=?, reply_text=?, reply_note=?, error=?, finished_at=?, updated_at=? WHERE id=?`,
    ).run(args.status, args.replyText ?? null, args.replyNote ?? null, args.error ?? null, now(), now(), id);
    return this.byId(id);
  },
};

export const helpAttachments = {
  add(helpId: string, a: { filename: string; relPath: string; size: number }): void {
    db.prepare(`INSERT INTO help_attachments (help_id, filename, rel_path, size, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(helpId, a.filename, a.relPath, a.size, now());
  },
  ofHelp(helpId: string): Array<{ name: string; relPath: string; size: number }> {
    return (db.prepare(`SELECT filename, rel_path, size FROM help_attachments WHERE help_id=? ORDER BY id`).all(helpId) as any[])
      .map((r) => ({ name: r.filename, relPath: r.rel_path, size: r.size }));
  },
};

// ===== collab_tokens（本地 CLI / 本地客户端凭证）=====

export const collabTokens = {
  issue(personId: string, label?: string): string {
    const token = `ct_${randomUUID().replaceAll('-', '')}`;
    db.prepare(`INSERT INTO collab_tokens (token, person_id, label, created_at) VALUES (?, ?, ?, ?)`)
      .run(token, personId, label ?? null, now());
    return token;
  },
  resolve(token: string): { personId: string } | null {
    const r = db.prepare(`SELECT person_id FROM collab_tokens WHERE token=?`).get(token) as any;
    if (!r) return null;
    db.prepare(`UPDATE collab_tokens SET last_used_at=? WHERE token=?`).run(now(), token);
    return { personId: r.person_id };
  },
  ofPerson(personId: string): Array<{ token: string; label: string | null; createdAt: string; lastUsedAt: string | null }> {
    return (db.prepare(`SELECT token, label, created_at, last_used_at FROM collab_tokens WHERE person_id=? ORDER BY created_at DESC`)
      .all(personId) as any[])
      .map((r) => ({ token: r.token, label: r.label, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
  },
  revoke(token: string): void {
    db.prepare(`DELETE FROM collab_tokens WHERE token=?`).run(token);
  },
};

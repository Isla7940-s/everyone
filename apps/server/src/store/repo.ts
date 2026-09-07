import { randomUUID } from 'node:crypto';
import type {
  AgentRun,
  AgentRunMode,
  Assist,
  AssistStatus,
  AssistType,
  ChatInfo,
  Heartbeat,
  HeartbeatStatus,
  IncomingMessage,
  Person,
  Run,
  RunStatus,
  Task,
  TaskSource,
  TaskStatus,
} from '@everyone/shared';
import { db } from './db.js';

const now = () => new Date().toISOString();

// ===== persons =====
function rowToPerson(r: any): Person {
  return {
    id: r.id,
    feishuOpenId: r.feishu_open_id,
    name: r.name,
    workspaceDir: r.workspace_dir,
    avatarColor: r.avatar_color ?? undefined,
    isBot: !!r.is_bot,
    collectEnabled: !!r.collect_enabled,
    answerEnabled: !!r.answer_enabled,
  };
}

export const persons = {
  upsert(p: Omit<Person, 'collectEnabled' | 'answerEnabled'> & Partial<Person>) {
    db.prepare(
      `INSERT INTO persons (id, feishu_open_id, name, workspace_dir, avatar_color, is_bot, collect_enabled, answer_enabled)
       VALUES (@id, @feishuOpenId, @name, @workspaceDir, @avatarColor, @isBot, @collectEnabled, @answerEnabled)
       ON CONFLICT(id) DO UPDATE SET feishu_open_id=@feishuOpenId, name=@name, workspace_dir=@workspaceDir, avatar_color=@avatarColor`,
    ).run({
      id: p.id,
      feishuOpenId: p.feishuOpenId ?? null,
      name: p.name,
      workspaceDir: p.workspaceDir,
      avatarColor: p.avatarColor ?? null,
      isBot: p.isBot ? 1 : 0,
      collectEnabled: p.collectEnabled === false ? 0 : 1,
      answerEnabled: p.answerEnabled === false ? 0 : 1,
    });
  },
  all(): Person[] {
    return db.prepare(`SELECT * FROM persons WHERE is_bot=0 ORDER BY id`).all().map(rowToPerson);
  },
  byId(id: string): Person | null {
    const r = db.prepare(`SELECT * FROM persons WHERE id=?`).get(id);
    return r ? rowToPerson(r) : null;
  },
  byOpenId(openId: string): Person | null {
    const r = db.prepare(`SELECT * FROM persons WHERE feishu_open_id=?`).get(openId);
    return r ? rowToPerson(r) : null;
  },
  byName(name: string): Person | null {
    const r = db.prepare(`SELECT * FROM persons WHERE name=?`).get(name);
    return r ? rowToPerson(r) : null;
  },
  setToggle(id: string, key: 'collect_enabled' | 'answer_enabled', on: boolean) {
    db.prepare(`UPDATE persons SET ${key}=? WHERE id=?`).run(on ? 1 : 0, id);
  },
};

// ===== tasks =====
function rowToTask(r: any): Task {
  return {
    id: r.id,
    bitableRecordId: r.bitable_record_id,
    ownerId: r.owner_id,
    creatorId: r.creator_id ?? null,
    title: r.title,
    source: r.source as TaskSource,
    important: !!r.important,
    urgent: !!r.urgent,
    dueAt: r.due_at,
    status: r.status as TaskStatus,
    confidence: r.confidence,
    srcMsgLink: r.src_msg_link,
    srcMsgId: r.src_msg_id,
    chatId: r.chat_id,
    canDo: r.can_do === null ? null : !!r.can_do,
    canDoReason: r.can_do_reason,
    taskKind: r.task_kind ?? null,
    docToken: r.doc_token,
    docUrl: r.doc_url,
    calendarEventId: r.calendar_event_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const tasks = {
  create(t: {
    ownerId: string;
    creatorId?: string | null;
    title: string;
    source: TaskSource;
    important: boolean;
    urgent: boolean;
    dueAt: string | null;
    status: TaskStatus;
    confidence: number;
    srcMsgLink?: string | null;
    srcMsgId?: string | null;
    chatId?: string | null;
  }): Task {
    const id = `t-${randomUUID().slice(0, 8)}`;
    const ts = now();
    db.prepare(
      `INSERT INTO tasks (id, owner_id, creator_id, title, source, important, urgent, due_at, status, confidence, src_msg_link, src_msg_id, chat_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, t.ownerId, t.creatorId ?? null, t.title, t.source,
      t.important ? 1 : 0, t.urgent ? 1 : 0,
      t.dueAt, t.status, t.confidence,
      t.srcMsgLink ?? null, t.srcMsgId ?? null, t.chatId ?? null, ts, ts,
    );
    return this.byId(id)!;
  },
  byId(id: string): Task | null {
    const r = db.prepare(`SELECT * FROM tasks WHERE id=?`).get(id);
    return r ? rowToTask(r) : null;
  },
  update(id: string, patch: Partial<Record<string, unknown>>) {
    const map: Record<string, string> = {
      ownerId: 'owner_id', creatorId: 'creator_id', title: 'title', important: 'important', urgent: 'urgent',
      dueAt: 'due_at', status: 'status', bitableRecordId: 'bitable_record_id',
      canDo: 'can_do', canDoReason: 'can_do_reason', taskKind: 'task_kind', docToken: 'doc_token', docUrl: 'doc_url',
      calendarEventId: 'calendar_event_id',
      confidence: 'confidence',
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = map[k];
      if (!col) continue;
      sets.push(`${col}=?`);
      vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    if (!sets.length) return;
    sets.push(`updated_at=?`);
    vals.push(now(), id);
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id=?`).run(...vals);
  },
  all(filter?: { ownerId?: string; statuses?: TaskStatus[] }): Task[] {
    let sql = `SELECT * FROM tasks`;
    const conds: string[] = [];
    const vals: unknown[] = [];
    if (filter?.ownerId) { conds.push(`owner_id=?`); vals.push(filter.ownerId); }
    if (filter?.statuses?.length) {
      conds.push(`status IN (${filter.statuses.map(() => '?').join(',')})`);
      vals.push(...filter.statuses);
    }
    if (conds.length) sql += ` WHERE ` + conds.join(' AND ');
    sql += ` ORDER BY created_at DESC`;
    return db.prepare(sql).all(...vals).map(rowToTask);
  },
  /** 未完成任务（四象限展示口径） */
  openTasksOf(ownerId: string): Task[] {
    return this.all({ ownerId, statuses: ['todo', 'running', 'reviewing', 'pending_confirm'] });
  },
};

// ===== runs =====
function rowToRun(r: any): Run {
  return {
    id: r.id, taskId: r.task_id, engine: r.engine, status: r.status as RunStatus,
    startedAt: r.started_at, finishedAt: r.finished_at, docToken: r.doc_token,
    iteration: r.iteration, error: r.error,
  };
}
export const runs = {
  create(taskId: string, engine: 'opencode' | 'builtin', iteration: number): Run {
    const id = `r-${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO runs (id, task_id, engine, status, started_at, iteration) VALUES (?, ?, ?, 'running', ?, ?)`,
    ).run(id, taskId, engine, now(), iteration);
    return this.byId(id)!;
  },
  byId(id: string): Run | null {
    const r = db.prepare(`SELECT * FROM runs WHERE id=?`).get(id);
    return r ? rowToRun(r) : null;
  },
  finish(id: string, status: RunStatus, patch?: { docToken?: string; error?: string }) {
    db.prepare(`UPDATE runs SET status=?, finished_at=?, doc_token=COALESCE(?, doc_token), error=? WHERE id=?`)
      .run(status, now(), patch?.docToken ?? null, patch?.error ?? null, id);
  },
  ofTask(taskId: string): Run[] {
    return db.prepare(`SELECT * FROM runs WHERE task_id=? ORDER BY started_at`).all(taskId).map(rowToRun);
  },
  latestOfTask(taskId: string): Run | null {
    const r = db.prepare(`SELECT * FROM runs WHERE task_id=? ORDER BY started_at DESC LIMIT 1`).get(taskId);
    return r ? rowToRun(r) : null;
  },
  all(limit = 100): Run[] {
    return db.prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`).all(limit).map(rowToRun);
  },
};

// ===== messages_seen（幂等，FR-A2）=====
export const seen = {
  /** 返回 true = 第一次见到（并记录）；false = 重复消息 */
  firstTime(msgId: string): boolean {
    try {
      db.prepare(`INSERT INTO messages_seen (msg_id, processed_at) VALUES (?, ?)`).run(msgId, now());
      return true;
    } catch {
      return false;
    }
  },
  /** 只查不写（轮询预检用） */
  peek(msgId: string): boolean {
    return !!db.prepare(`SELECT 1 FROM messages_seen WHERE msg_id=?`).get(msgId);
  },
};

// ===== chat_messages 全量存档 =====
export const chatLog = {
  save(m: IncomingMessage, senderPersonId: string | null) {
    db.prepare(
      `INSERT OR IGNORE INTO chat_messages (msg_id, chat_id, chat_kind, sender_open_id, sender_person_id, sender_name, msg_type, text, msg_link, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(m.msgId, m.chatId, m.chatKind, m.senderOpenId, senderPersonId, m.senderName ?? null, m.msgType, m.text, m.msgLink ?? null, m.ts);
  },
  /** 机器人 outbound 消息存档（需求③：喂给 Agent 的上下文里包含 Everyone 自己的发言，署名区分超级代理/分身） */
  saveBot(m: { msgId: string; chatId: string; chatKind: string; senderName: string; text: string; msgType?: string }) {
    db.prepare(
      `INSERT OR IGNORE INTO chat_messages (msg_id, chat_id, chat_kind, sender_open_id, sender_person_id, sender_name, msg_type, text, msg_link, ts)
       VALUES (?, ?, ?, 'everyone-bot', NULL, ?, ?, ?, NULL, ?)`,
    ).run(m.msgId, m.chatId, m.chatKind, m.senderName, m.msgType ?? 'text', m.text, new Date().toISOString());
  },
  /** 按消息 id 反查会话（回复类 outbound 存档需要定位原消息所在会话） */
  byMsgId(msgId: string): { chatId: string; chatKind: string } | null {
    const r = db.prepare(`SELECT chat_id as chatId, chat_kind as chatKind FROM chat_messages WHERE msg_id=?`).get(msgId) as any;
    return r ?? null;
  },
  todayOf(chatId: string): Array<{ senderName: string; text: string; ts: string; msgId: string }> {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    return db.prepare(
      `SELECT sender_name as senderName, text, ts, msg_id as msgId FROM chat_messages WHERE chat_id=? AND ts>=? ORDER BY ts`,
    ).all(chatId, start.toISOString()) as any[];
  },
  search(personId: string | null, keyword: string, limit = 8): Array<{ text: string; senderName: string; ts: string; msgLink: string | null; msgId: string }> {
    const like = `%${keyword}%`;
    if (personId) {
      return db.prepare(
        `SELECT text, sender_name as senderName, ts, msg_link as msgLink, msg_id as msgId FROM chat_messages WHERE sender_person_id=? AND text LIKE ? ORDER BY ts DESC LIMIT ?`,
      ).all(personId, like, limit) as any[];
    }
    return db.prepare(
      `SELECT text, sender_name as senderName, ts, msg_link as msgLink, msg_id as msgId FROM chat_messages WHERE text LIKE ? ORDER BY ts DESC LIMIT ?`,
    ).all(like, limit) as any[];
  },
  recent(chatId: string, limit = 30): Array<{ senderName: string; text: string; ts: string }> {
    return db.prepare(
      `SELECT sender_name as senderName, text, ts FROM chat_messages WHERE chat_id=? ORDER BY ts DESC LIMIT ?`,
    ).all(chatId, limit).reverse() as any[];
  },
  /**
   * 历史消息检索（需求 6，供 MCP search_messages）：
   * 多关键词 AND（LIKE），可按会话 / 发言人 / 时间窗过滤，倒序返回。
   */
  query(args: {
    keywords: string[];
    chatId?: string | null;
    senderName?: string | null;
    sinceIso?: string | null;
    untilIso?: string | null;
    limit?: number;
  }): Array<{ msgId: string; chatId: string; senderName: string | null; text: string; ts: string; msgLink: string | null }> {
    const conds: string[] = [];
    const vals: unknown[] = [];
    for (const kw of args.keywords.slice(0, 6)) {
      conds.push(`text LIKE ?`);
      vals.push(`%${kw}%`);
    }
    if (args.chatId) { conds.push(`chat_id=?`); vals.push(args.chatId); }
    if (args.senderName) { conds.push(`sender_name LIKE ?`); vals.push(`%${args.senderName}%`); }
    if (args.sinceIso) { conds.push(`ts>=?`); vals.push(args.sinceIso); }
    if (args.untilIso) { conds.push(`ts<=?`); vals.push(args.untilIso); }
    const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
    return db.prepare(
      `SELECT msg_id as msgId, chat_id as chatId, sender_name as senderName, text, ts, msg_link as msgLink
       FROM chat_messages${where} ORDER BY ts DESC LIMIT ?`,
    ).all(...vals, Math.min(args.limit ?? 20, 100)) as any[];
  },
};

// ===== chats 群聊注册表（需求 6：消息采集按群启停）=====
function rowToChat(r: any): ChatInfo {
  return {
    chatId: r.chat_id, kind: r.kind, name: r.name,
    collectEnabled: !!r.collect_enabled,
    msgCount: r.msg_count, lastMsgAt: r.last_msg_at, firstSeenAt: r.first_seen_at,
    wikiEnabled: !!r.wiki_enabled,
    wikiDocToken: r.wiki_doc_token ?? null,
    wikiDocUrl: r.wiki_doc_url ?? null,
    wikiUpdatedAt: r.wiki_updated_at ?? null,
  };
}
export const chats = {
  /** 每条消息进来都 touch：首见注册（默认启用采集），累计计数 */
  touch(chatId: string, kind: string, name?: string | null): ChatInfo {
    db.prepare(
      `INSERT INTO chats (chat_id, kind, name, collect_enabled, msg_count, last_msg_at, first_seen_at)
       VALUES (?, ?, ?, 1, 0, NULL, ?)
       ON CONFLICT(chat_id) DO UPDATE SET name=COALESCE(excluded.name, chats.name)`,
    ).run(chatId, kind, name ?? null, now());
    return rowToChat(db.prepare(`SELECT * FROM chats WHERE chat_id=?`).get(chatId));
  },
  bumpCount(chatId: string, ts: string) {
    db.prepare(`UPDATE chats SET msg_count=msg_count+1, last_msg_at=? WHERE chat_id=?`).run(ts, chatId);
  },
  byId(chatId: string): ChatInfo | null {
    const r = db.prepare(`SELECT * FROM chats WHERE chat_id=?`).get(chatId);
    return r ? rowToChat(r) : null;
  },
  all(): ChatInfo[] {
    return db.prepare(`SELECT * FROM chats ORDER BY last_msg_at DESC`).all().map(rowToChat);
  },
  setCollect(chatId: string, on: boolean) {
    db.prepare(`UPDATE chats SET collect_enabled=? WHERE chat_id=?`).run(on ? 1 : 0, chatId);
  },
  setName(chatId: string, name: string) {
    db.prepare(`UPDATE chats SET name=? WHERE chat_id=?`).run(name, chatId);
  },
  // ===== 群知识库（需求⑥）=====
  setWikiEnabled(chatId: string, on: boolean) {
    db.prepare(`UPDATE chats SET wiki_enabled=? WHERE chat_id=?`).run(on ? 1 : 0, chatId);
  },
  setWikiDoc(chatId: string, token: string | null, url: string | null) {
    db.prepare(`UPDATE chats SET wiki_doc_token=?, wiki_doc_url=? WHERE chat_id=?`).run(token, url, chatId);
  },
  markWikiUpdated(chatId: string) {
    db.prepare(`UPDATE chats SET wiki_updated_at=? WHERE chat_id=?`).run(new Date().toISOString(), chatId);
  },
};

// ===== agent_runs（需求 2/3：每次 OpenCode 运行留痕 + 轨迹索引）=====
function rowToAgentRun(r: any): AgentRun {
  return {
    id: r.id, mode: r.mode as AgentRunMode,
    personId: r.person_id, personName: r.person_name,
    taskId: r.task_id, heartbeatId: r.heartbeat_id,
    label: r.label, request: r.request, workspaceDir: r.workspace_dir,
    status: r.status, deliveries: r.deliveries, deliverySummary: r.delivery_summary,
    error: r.error, startedAt: r.started_at, finishedAt: r.finished_at,
  };
}
export const agentRuns = {
  start(a: {
    id: string; mode: AgentRunMode; personId?: string | null; personName?: string | null;
    taskId?: string | null; heartbeatId?: string | null; label: string; request: string; workspaceDir: string;
  }): AgentRun {
    db.prepare(
      `INSERT OR REPLACE INTO agent_runs (id, mode, person_id, person_name, task_id, heartbeat_id, label, request, workspace_dir, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
    ).run(a.id, a.mode, a.personId ?? null, a.personName ?? null, a.taskId ?? null, a.heartbeatId ?? null,
      a.label, a.request.slice(0, 500), a.workspaceDir, now());
    return this.byId(a.id)!;
  },
  finish(id: string, status: 'succeeded' | 'failed' | 'timeout', patch?: { deliveries?: number; deliverySummary?: string; error?: string }) {
    db.prepare(
      `UPDATE agent_runs SET status=?, finished_at=?, deliveries=COALESCE(?, deliveries), delivery_summary=COALESCE(?, delivery_summary), error=? WHERE id=?`,
    ).run(status, now(), patch?.deliveries ?? null, patch?.deliverySummary?.slice(0, 300) ?? null, patch?.error?.slice(0, 500) ?? null, id);
  },
  byId(id: string): AgentRun | null {
    const r = db.prepare(`SELECT * FROM agent_runs WHERE id=?`).get(id);
    return r ? rowToAgentRun(r) : null;
  },
  all(limit = 100): AgentRun[] {
    return db.prepare(`SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT ?`).all(limit).map(rowToAgentRun);
  },
  ofPerson(personId: string, limit = 100): AgentRun[] {
    return db.prepare(`SELECT * FROM agent_runs WHERE person_id=? ORDER BY started_at DESC LIMIT ?`).all(personId, limit).map(rowToAgentRun);
  },
  running(): AgentRun[] {
    return db.prepare(`SELECT * FROM agent_runs WHERE status='running' ORDER BY started_at DESC LIMIT 20`).all().map(rowToAgentRun);
  },
  /** 启动恢复：进程重启时孤儿 running 记录一律判 failed（子进程已随主进程消亡） */
  failOrphans(): number {
    const r = db.prepare(`UPDATE agent_runs SET status='failed', finished_at=?, error='服务重启，执行被打断' WHERE status='running'`).run(now());
    return r.changes;
  },
};

// ===== heartbeats（需求 7：心跳任务）=====
function rowToHeartbeat(r: any): Heartbeat {
  return {
    id: r.id, creatorId: r.creator_id, requirement: r.requirement,
    firstAt: r.first_at, intervalMin: r.interval_min, totalRuns: r.total_runs,
    runsDone: r.runs_done, nextRunAt: r.next_run_at, status: r.status as HeartbeatStatus,
    chatId: r.chat_id, workspaceDir: r.workspace_dir,
    lastRunAt: r.last_run_at, lastSummary: r.last_summary,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
export const heartbeats = {
  create(h: {
    id?: string; creatorId: string; requirement: string; firstAt: string; intervalMin: number;
    totalRuns: number; chatId?: string | null; workspaceDir: string;
  }): Heartbeat {
    const id = h.id ?? `hb-${randomUUID().slice(0, 8)}`;
    const ts = now();
    db.prepare(
      `INSERT INTO heartbeats (id, creator_id, requirement, first_at, interval_min, total_runs, runs_done, next_run_at, status, chat_id, workspace_dir, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'pending_confirm', ?, ?, ?, ?)`,
    ).run(id, h.creatorId, h.requirement, h.firstAt, h.intervalMin, h.totalRuns, h.firstAt, h.chatId ?? null, h.workspaceDir, ts, ts);
    return this.byId(id)!;
  },
  byId(id: string): Heartbeat | null {
    const r = db.prepare(`SELECT * FROM heartbeats WHERE id=?`).get(id);
    return r ? rowToHeartbeat(r) : null;
  },
  update(id: string, patch: Partial<{
    requirement: string; firstAt: string; intervalMin: number; totalRuns: number;
    runsDone: number; nextRunAt: string | null; status: HeartbeatStatus;
    lastRunAt: string; lastSummary: string;
  }>) {
    const map: Record<string, string> = {
      requirement: 'requirement', firstAt: 'first_at', intervalMin: 'interval_min', totalRuns: 'total_runs',
      runsDone: 'runs_done', nextRunAt: 'next_run_at', status: 'status', lastRunAt: 'last_run_at', lastSummary: 'last_summary',
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = map[k];
      if (!col) continue;
      sets.push(`${col}=?`);
      vals.push(v as never);
    }
    if (!sets.length) return;
    sets.push(`updated_at=?`);
    vals.push(now(), id);
    db.prepare(`UPDATE heartbeats SET ${sets.join(', ')} WHERE id=?`).run(...vals);
  },
  all(): Heartbeat[] {
    return db.prepare(`SELECT * FROM heartbeats ORDER BY created_at DESC`).all().map(rowToHeartbeat);
  },
  ofCreator(creatorId: string): Heartbeat[] {
    return db.prepare(`SELECT * FROM heartbeats WHERE creator_id=? ORDER BY created_at DESC`).all(creatorId).map(rowToHeartbeat);
  },
  /** 到点应触发的任务 */
  due(nowIso: string): Heartbeat[] {
    return db.prepare(`SELECT * FROM heartbeats WHERE status='active' AND next_run_at IS NOT NULL AND next_run_at<=?`)
      .all(nowIso).map(rowToHeartbeat);
  },
};

// ===== memory_events（S7 沉淀审计）=====
export const memoryEvents = {
  add(personId: string, content: string, sourceRunId?: string) {
    db.prepare(`INSERT INTO memory_events (person_id, content, source_run_id, created_at) VALUES (?, ?, ?, ?)`)
      .run(personId, content, sourceRunId ?? null, now());
  },
  ofPerson(personId: string, limit = 50) {
    return db.prepare(`SELECT * FROM memory_events WHERE person_id=? ORDER BY created_at DESC LIMIT ?`).all(personId, limit);
  },
};

// ===== assists（帮你收/帮你答审计，FR-J6）=====
function rowToAssist(r: any): Assist {
  return {
    id: r.id, type: r.type as AssistType, personId: r.person_id,
    srcMsgLink: r.src_msg_link, evidenceLink: r.evidence_link,
    content: r.content, status: r.status as AssistStatus, createdAt: r.created_at,
  };
}
export const assists = {
  create(a: { type: AssistType; personId: string; content: string; srcMsgLink?: string | null; evidenceLink?: string | null; status: AssistStatus }): Assist {
    const id = `as-${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO assists (id, type, person_id, src_msg_link, evidence_link, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, a.type, a.personId, a.srcMsgLink ?? null, a.evidenceLink ?? null, a.content, a.status, now());
    return rowToAssist(db.prepare(`SELECT * FROM assists WHERE id=?`).get(id));
  },
  setStatus(id: string, status: AssistStatus) {
    db.prepare(`UPDATE assists SET status=? WHERE id=?`).run(status, id);
  },
  byId(id: string): Assist | null {
    const r = db.prepare(`SELECT * FROM assists WHERE id=?`).get(id);
    return r ? rowToAssist(r) : null;
  },
  all(limit = 100): Assist[] {
    return db.prepare(`SELECT * FROM assists ORDER BY created_at DESC LIMIT ?`).all(limit).map(rowToAssist);
  },
  /** 某人某天（本地日）以来的 assists（个人日报用） */
  ofPersonSince(personId: string, sinceIso: string): Assist[] {
    return db.prepare(`SELECT * FROM assists WHERE person_id=? AND created_at>=? ORDER BY created_at`)
      .all(personId, sinceIso).map(rowToAssist);
  },
  /** 某人最近一条指定类型/状态的 assist（文字指令兜底用） */
  latestOf(personId: string, type: AssistType, statuses: AssistStatus[]): Assist | null {
    if (!statuses.length) return null;
    const r = db.prepare(
      `SELECT * FROM assists WHERE person_id=? AND type=? AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 1`,
    ).get(personId, type, ...statuses);
    return r ? rowToAssist(r) : null;
  },
};

// ===== review_comments =====
export const reviewComments = {
  add(c: { runId?: string | null; taskId?: string | null; persona: string; quotedText: string; content: string }) {
    db.prepare(
      `INSERT INTO review_comments (run_id, task_id, persona, quoted_text, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(c.runId ?? null, c.taskId ?? null, c.persona, c.quotedText, c.content, now());
  },
  all(limit = 100) {
    return db.prepare(`SELECT * FROM review_comments ORDER BY created_at DESC LIMIT ?`).all(limit);
  },
};

// ===== pending_cards（卡片回调路由）=====
export const pendingCards = {
  save(cardMsgId: string, kind: string, payload: Record<string, unknown>) {
    db.prepare(`INSERT OR REPLACE INTO pending_cards (card_msg_id, kind, payload, created_at) VALUES (?, ?, ?, ?)`)
      .run(cardMsgId, kind, JSON.stringify(payload), now());
  },
  get(cardMsgId: string): { kind: string; payload: Record<string, unknown> } | null {
    const r = db.prepare(`SELECT kind, payload FROM pending_cards WHERE card_msg_id=?`).get(cardMsgId) as any;
    return r ? { kind: r.kind, payload: JSON.parse(r.payload) } : null;
  },
  /** 按 payload 字段值反查最近一张卡（文字指令兜底需要拿到卡片消息 id） */
  findByPayloadValue(kind: string, key: string, value: string): { cardMsgId: string; payload: Record<string, unknown> } | null {
    const rows = db.prepare(`SELECT card_msg_id, payload FROM pending_cards WHERE kind=? ORDER BY created_at DESC LIMIT 50`).all(kind) as any[];
    for (const r of rows) {
      try {
        const payload = JSON.parse(r.payload);
        if (payload?.[key] === value) return { cardMsgId: r.card_msg_id, payload };
      } catch { /* 跳过坏行 */ }
    }
    return null;
  },
  delete(cardMsgId: string) {
    db.prepare(`DELETE FROM pending_cards WHERE card_msg_id=?`).run(cardMsgId);
  },
};

// ===== kv =====
export const kv = {
  get(k: string): string | null {
    const r = db.prepare(`SELECT v FROM kv WHERE k=?`).get(k) as any;
    return r?.v ?? null;
  },
  set(k: string, v: string) {
    db.prepare(`INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)`).run(k, v);
  },
  getJson<T>(k: string, fallback: T): T {
    const v = this.get(k);
    if (!v) return fallback;
    try { return JSON.parse(v) as T; } catch { return fallback; }
  },
  setJson(k: string, v: unknown) {
    this.set(k, JSON.stringify(v));
  },
};

// ===== routing_feedback（不归我管）=====
export const routingFeedback = {
  add(personId: string, opinionSummary: string) {
    db.prepare(`INSERT INTO routing_feedback (person_id, opinion_summary, verdict, created_at) VALUES (?, ?, 'rejected', ?)`)
      .run(personId, opinionSummary, now());
  },
  ofPerson(personId: string): string[] {
    return (db.prepare(`SELECT opinion_summary FROM routing_feedback WHERE person_id=? ORDER BY created_at DESC LIMIT 10`)
      .all(personId) as any[]).map((r) => r.opinion_summary);
  },
};

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

fs.mkdirSync(config.dataDir, { recursive: true });

export const db: Database.Database = new Database(path.join(config.dataDir, 'everyone.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ===== schema（PRD §7.3）=====
db.exec(`
CREATE TABLE IF NOT EXISTS persons (
  id TEXT PRIMARY KEY,
  feishu_open_id TEXT,
  name TEXT NOT NULL,
  workspace_dir TEXT NOT NULL,
  avatar_color TEXT,
  is_bot INTEGER DEFAULT 0,
  collect_enabled INTEGER DEFAULT 1,
  answer_enabled INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  bitable_record_id TEXT,
  owner_id TEXT NOT NULL REFERENCES persons(id),
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  important INTEGER NOT NULL DEFAULT 0,
  urgent INTEGER NOT NULL DEFAULT 0,
  due_at TEXT,
  status TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  src_msg_link TEXT,
  src_msg_id TEXT,
  chat_id TEXT,
  can_do INTEGER,
  can_do_reason TEXT,
  doc_token TEXT,
  doc_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  engine TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  doc_token TEXT,
  iteration INTEGER NOT NULL DEFAULT 1,
  error TEXT
);

CREATE TABLE IF NOT EXISTS messages_seen (
  msg_id TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id TEXT NOT NULL,
  content TEXT NOT NULL,
  source_run_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assists (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  person_id TEXT NOT NULL,
  src_msg_link TEXT,
  evidence_link TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  task_id TEXT,
  persona TEXT NOT NULL,
  quoted_text TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 全量消息存档（L0 兜底 + 日报取数 + LIKE 降级检索）
CREATE TABLE IF NOT EXISTS chat_messages (
  msg_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  chat_kind TEXT NOT NULL,
  sender_open_id TEXT NOT NULL,
  sender_person_id TEXT,
  sender_name TEXT,
  msg_type TEXT NOT NULL,
  text TEXT NOT NULL,
  msg_link TEXT,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_ts ON chat_messages(chat_id, ts);

-- 卡片消息 → 业务上下文（回调路由）
CREATE TABLE IF NOT EXISTS pending_cards (
  card_msg_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 帮你收的负反馈（"不归我管"修正后续判定）
CREATE TABLE IF NOT EXISTS routing_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id TEXT NOT NULL,
  opinion_summary TEXT NOT NULL,
  verdict TEXT NOT NULL, -- rejected
  created_at TEXT NOT NULL
);

-- 通用 kv（p2p 轮询会话注册等）
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- HTML 自动部署页面（新需求 3：不鉴权、24h 失效；内容在 data/pages/<id>.html）
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Agent 运行登记（七项需求 2/3：每次 OpenCode 运行都留痕；轨迹在 data/traces/<id>.log）
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,             -- chat / task / heartbeat
  person_id TEXT,                 -- chat=提问人 task=owner heartbeat=创建人
  person_name TEXT,
  task_id TEXT,
  heartbeat_id TEXT,
  label TEXT NOT NULL,
  request TEXT NOT NULL,
  workspace_dir TEXT NOT NULL,
  status TEXT NOT NULL,           -- running / succeeded / failed / timeout
  deliveries INTEGER NOT NULL DEFAULT 0,
  delivery_summary TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_person ON agent_runs(person_id, started_at);

-- 群聊注册表（七项需求 6：消息采集按群启停，默认启用）
CREATE TABLE IF NOT EXISTS chats (
  chat_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT,
  collect_enabled INTEGER NOT NULL DEFAULT 1,
  msg_count INTEGER NOT NULL DEFAULT 0,
  last_msg_at TEXT,
  first_seen_at TEXT NOT NULL
);

-- 心跳任务（七项需求 7：Agent 经 MCP 创建，用户确认后按计划触发；独立沙箱 workspaces/_heartbeat/<id>/）
CREATE TABLE IF NOT EXISTS heartbeats (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  requirement TEXT NOT NULL,
  first_at TEXT NOT NULL,
  interval_min INTEGER NOT NULL DEFAULT 0,
  total_runs INTEGER NOT NULL DEFAULT 0,  -- 0 = 无限
  runs_done INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT,
  status TEXT NOT NULL,           -- pending_confirm / active / paused / done / cancelled
  chat_id TEXT,
  workspace_dir TEXT NOT NULL,
  last_run_at TEXT,
  last_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

// ===== 轻量迁移（旧库补列）=====
try { db.exec(`ALTER TABLE tasks ADD COLUMN task_kind TEXT`); } catch { /* 列已存在 */ }
try { db.exec(`ALTER TABLE tasks ADD COLUMN creator_id TEXT`); } catch { /* 列已存在 */ }
try { db.exec(`ALTER TABLE tasks ADD COLUMN calendar_event_id TEXT`); } catch { /* 列已存在 */ }
// 群知识库（2026-08-29 需求⑥）：按群启用，每日自动维护；在线文档由系统托管，管理员可换绑
try { db.exec(`ALTER TABLE chats ADD COLUMN wiki_enabled INTEGER NOT NULL DEFAULT 0`); } catch { /* 列已存在 */ }
try { db.exec(`ALTER TABLE chats ADD COLUMN wiki_doc_token TEXT`); } catch { /* 列已存在 */ }
try { db.exec(`ALTER TABLE chats ADD COLUMN wiki_doc_url TEXT`); } catch { /* 列已存在 */ }
try { db.exec(`ALTER TABLE chats ADD COLUMN wiki_updated_at TEXT`); } catch { /* 列已存在 */ }

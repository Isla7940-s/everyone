import { randomUUID } from 'node:crypto';

/**
 * Agent 会话注册表（新需求 1/2 的核心纽带）：
 * 每次 OpenCode 运行前由服务端创建一条会话，token 注入子进程环境变量；
 * MCP 工具凭 token 找回会话——回复目标、身份、任务上下文全部由服务端持有，
 * 模型自报的 chatId/msgId 一律不信（D-N2）。
 */

export type AgentSessionMode = 'chat' | 'task' | 'heartbeat' | 'wiki';

export interface AgentDelivery {
  kind: 'text' | 'doc' | 'image' | 'page' | 'card' | 'calendar';
  url?: string;
  title?: string;
  /** 交付正文（摘要/评审用）：text=消息原文；doc=markdown 全文 */
  content?: string;
  at: string;
}

export interface AgentSession {
  id: string;
  token: string;
  mode: AgentSessionMode;
  /** 回复目标：chat 模式回源消息所在会话；task 模式私信 owner */
  chatId: string | null;
  replyToMsgId: string | null;
  /** task 模式的私信目标（live open_id / mock person id） */
  dmOpenId: string | null;
  personId: string | null;
  taskId: string | null;
  heartbeatId: string | null;
  /** 任务迭代：已有云文档时 md 附件 overwrite 同一篇（FR-C5） */
  docToken: string | null;
  docUrl: string | null;
  /** 附件相对路径的解析根（也是路径穿越校验的边界） */
  workspaceDir: string;
  /** 给活动流/日志的场景描述，如「群聊 Agent 模式」「任务：xxx」 */
  label: string;
  deliveries: AgentDelivery[];
  createdAt: number;
  expiresAt: number;
}

const sessions = new Map<string, AgentSession>(); // token → session

function prune(): void {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (s.expiresAt < now) sessions.delete(token);
  }
}

export function createAgentSession(args: {
  mode: AgentSessionMode;
  chatId?: string | null;
  replyToMsgId?: string | null;
  dmOpenId?: string | null;
  personId?: string | null;
  taskId?: string | null;
  heartbeatId?: string | null;
  docToken?: string | null;
  docUrl?: string | null;
  workspaceDir: string;
  label: string;
  ttlMs?: number;
}): AgentSession {
  prune();
  const s: AgentSession = {
    id: `as-${randomUUID().slice(0, 8)}`,
    token: randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
    mode: args.mode,
    chatId: args.chatId ?? null,
    replyToMsgId: args.replyToMsgId ?? null,
    dmOpenId: args.dmOpenId ?? null,
    personId: args.personId ?? null,
    taskId: args.taskId ?? null,
    heartbeatId: args.heartbeatId ?? null,
    docToken: args.docToken ?? null,
    docUrl: args.docUrl ?? null,
    workspaceDir: args.workspaceDir,
    label: args.label,
    deliveries: [],
    createdAt: Date.now(),
    expiresAt: Date.now() + (args.ttlMs ?? 45 * 60_000),
  };
  sessions.set(s.token, s);
  return s;
}

export function sessionByToken(token: string | null | undefined): AgentSession | null {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s || s.expiresAt < Date.now()) return null;
  return s;
}

/** 运行结束后主动作废（不等 TTL），防止子进程残留时 token 仍可用 */
export function closeAgentSession(session: AgentSession): void {
  sessions.delete(session.token);
}

export function recordDelivery(session: AgentSession, d: Omit<AgentDelivery, 'at'>): AgentDelivery {
  const full: AgentDelivery = { ...d, at: new Date().toISOString() };
  session.deliveries.push(full);
  return full;
}

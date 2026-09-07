// Everyone 领域模型 —— server 与 admin 共用（PRD §7.3 + 功能规格）

// ===== 人 =====
export interface Person {
  id: string; // slug，如 "xiaoming"
  feishuOpenId: string | null; // mock 成员可为空
  name: string;
  workspaceDir: string; // workspaces/<id>
  avatarColor?: string; // mock UI 头像色
  isBot?: boolean;
  // 个人开关（FR-J6）
  collectEnabled: boolean; // 帮你收
  answerEnabled: boolean; // 帮你答
}

// ===== 任务（台账）=====
export type TaskSource = 'commitment' | 'meeting' | 'mention' | 'manual';
export type TaskStatus =
  | 'pending_confirm' // 待确认
  | 'todo' // 待办
  | 'running' // 分身进行中
  | 'reviewing' // 待审阅（初稿已私信）
  | 'published' // 已发布
  | 'cancelled'; // 已取消

/** 任务类型（能力自评判定）：doc 文档报告 / code 代码修改 / data 数据整理 / other */
export type TaskKind = 'doc' | 'code' | 'data' | 'other';

export interface Task {
  id: string;
  bitableRecordId: string | null;
  ownerId: string;
  /** 任务发起者（说这句话/指派/粘会议记录的人）；进度确认结果会告知此人 */
  creatorId: string | null;
  title: string;
  source: TaskSource;
  important: boolean;
  urgent: boolean;
  dueAt: string | null; // ISO
  status: TaskStatus;
  confidence: number;
  srcMsgLink: string | null;
  srcMsgId: string | null;
  chatId: string | null;
  canDo: boolean | null; // 能力自评结果
  canDoReason: string | null;
  taskKind: TaskKind | null; // 能力自评判定的任务类型
  docToken: string | null; // 产出文档
  docUrl: string | null;
  /** 已同步的飞书日程 event_id（mock 模式为 mock-ev- 前缀） */
  calendarEventId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function quadrantOf(t: { important: boolean; urgent: boolean }): 1 | 2 | 3 | 4 {
  // Q1 重要+紧急 / Q2 重要不紧急 / Q3 紧急不重要 / Q4 不重要不紧急
  if (t.important && t.urgent) return 1;
  if (t.important && !t.urgent) return 2;
  if (!t.important && t.urgent) return 3;
  return 4;
}

// ===== 执行 =====
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'timeout';
export interface Run {
  id: string;
  taskId: string;
  engine: 'opencode' | 'builtin';
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  docToken: string | null;
  iteration: number;
  error: string | null;
}

// ===== Agent 运行登记（需求 2/3：每一次 OpenCode 运行都留痕，轨迹可查）=====
export type AgentRunMode = 'chat' | 'task' | 'heartbeat' | 'wiki';
export interface AgentRun {
  id: string; // 会话 id（as-xxx），trace 文件同名
  mode: AgentRunMode;
  /** 关联人：chat=提问人 / task=任务 owner / heartbeat=创建人（普通用户按此过滤自己的轨迹） */
  personId: string | null;
  personName: string | null;
  taskId: string | null;
  heartbeatId: string | null;
  label: string;
  /** 触发请求原文（chat 的消息 / task 标题 / heartbeat 需求） */
  request: string;
  workspaceDir: string; // 相对项目根，前端展示用
  status: 'running' | 'succeeded' | 'failed' | 'timeout';
  deliveries: number;
  deliverySummary: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

// ===== 群聊注册表（需求 6：消息采集按群启停）=====
export interface ChatInfo {
  chatId: string;
  kind: ChatKind;
  name: string | null;
  collectEnabled: boolean;
  msgCount: number;
  lastMsgAt: string | null;
  firstSeenAt: string;
  // 群知识库（2026-08-29 需求⑥）：管理员启用后每日自动维护，在线文档由系统托管
  wikiEnabled: boolean;
  wikiDocToken: string | null;
  wikiDocUrl: string | null;
  wikiUpdatedAt: string | null;
}

// ===== 心跳任务（需求 7）=====
export type HeartbeatStatus = 'pending_confirm' | 'active' | 'paused' | 'done' | 'cancelled';
export interface Heartbeat {
  id: string;
  creatorId: string;
  requirement: string;
  /** 首次触发时间（ISO） */
  firstAt: string;
  /** 重复间隔（分钟）；一次性任务为 0 */
  intervalMin: number;
  /** 总触发次数；0 = 无限 */
  totalRuns: number;
  runsDone: number;
  nextRunAt: string | null;
  status: HeartbeatStatus;
  /** 创建时所在会话（上下文查询默认范围） */
  chatId: string | null;
  workspaceDir: string;
  lastRunAt: string | null;
  lastSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

// ===== 帮你收 / 帮你答 =====
export type AssistType = 'collect' | 'answer';
export type AssistStatus =
  | 'notified' // 已私信本人
  | 'acked' // 知道了
  | 'converted' // 已转任务
  | 'rejected' // 不归我管
  | 'answered' // 已代答（answer）
  | 'corrected' // 已更正
  | 'retracted' // 已撤回
  | 'skipped'; // 没把握没发群，仅私信建议
export interface Assist {
  id: string;
  type: AssistType;
  personId: string;
  srcMsgLink: string | null;
  evidenceLink: string | null;
  content: string;
  status: AssistStatus;
  createdAt: string;
}

// ===== 评审 =====
export interface ReviewComment {
  id: string;
  runId: string | null;
  taskId: string | null;
  persona: string;
  quotedText: string;
  content: string;
  createdAt: string;
}

// ===== 消息（适配层统一模型）=====
export type ChatKind = 'group' | 'p2p';
export interface IncomingMessage {
  msgId: string;
  chatId: string;
  chatKind: ChatKind;
  senderOpenId: string; // mock 模式下是 person.id
  senderName?: string;
  text: string; // 已渲染纯文本
  msgType: string; // text / post / interactive / ...
  mentionedBot?: boolean;
  ts: string; // ISO
  msgLink?: string; // 源消息链接
}

/** 新成员入群事件（适配层统一模型）：live 走 im.chat.member.user.added + 成员轮询兜底；mock 由模拟器注入 */
export interface MemberJoinedEvent {
  chatId: string;
  members: Array<{
    /** live: ou_ 开头 open_id；mock: person id */
    openId: string;
    name: string;
  }>;
  /** 事件来源（观测用）：event 实时 / poll 轮询兜底 / mock 注入 */
  via: 'event' | 'poll' | 'mock';
}

// 卡片按钮回调（统一模型）
export interface CardAction {
  actionId: string; // 业务动作，如 task_confirm
  value: Record<string, string>;
  operatorOpenId: string;
  msgId?: string; // 卡片消息 id
  cardToken?: string; // 用于更新卡片
  ts: string;
}

// ===== 活动流（大屏 FR-G1）=====
export type ActivityKind =
  | 'message' // 收到消息
  | 'intent' // 识别出意图
  | 'task' // 台账变化
  | 'run' // 分身执行
  | 'send' // 对外发送
  | 'review' // 评审
  | 'assist' // 帮你收/帮你答
  | 'digest' // 日报
  | 'memory' // 记忆 capture/recall
  | 'system'; // 启动/降级/错误
export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  text: string;
  detail?: string;
  ts: string;
}

// ===== 意图识别（FR-A3；agent = Agent 模式复杂请求，新需求 2a）=====
export type IntentType = 'commitment' | 'mention_assign' | 'meeting' | 'opinion' | 'question' | 'agent' | 'none';
export interface IntentResult {
  type: IntentType;
  confidence: number;
  // commitment / mention_assign
  ownerId?: string; // person id
  title?: string;
  due?: string | null; // ISO 或 null
  important?: boolean;
  urgent?: boolean;
  // meeting
  actionItems?: Array<{ ownerId: string; title: string; due: string | null; important: boolean; urgent: boolean }>;
  conclusions?: string[];
  // opinion
  targetPersonId?: string; // 责任人
  // question
  answererId?: string;
  reason?: string;
}

// ===== 跨端协同（跨端协同.md）=====

/** 工作会话总结（§五）：本地 Agent 上传，云端只存总结不存原文 */
export interface WorkSession {
  /** 16 位字母数字唯一 ID，完整原文按此 ID 留在用户本地 */
  id: string;
  personId: string;
  /** 来源工具：codex / cursor / claude-code / ... */
  sourceTool: string;
  /** 大需求名称（跨会话统一命名，时间穿透聚合键） */
  requirement: string;
  /** 子任务名称 */
  subtask: string;
  /** 25 字左右一句话总结 */
  briefSummary: string;
  /** 100 字左右详细总结 */
  detailSummary: string;
  /** 会话时间（ISO） */
  sessionAt: string;
  /** 关联任务 */
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 时间去向记录（§四/§十三）：用户确认后由 CLI 正式上传 */
export interface TimeEntry {
  id: string;
  personId: string;
  /** 本地日 YYYY-MM-DD */
  date: string;
  requirement: string;
  subtask: string;
  /** 关联工作会话 */
  sessionId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  minutes: number;
  briefSummary: string | null;
  detailSummary: string | null;
  sourceTool: string | null;
  createdAt: string;
}

/** 任务完成记录（§七）：草稿 → 用户确认 → 正式（任务同时标记完成） */
export interface TaskCompletion {
  id: string;
  taskId: string;
  personId: string;
  status: 'draft' | 'confirmed';
  /** 完成说明 */
  note: string;
  /** 遗留问题 */
  leftover: string | null;
  /** 关联工作会话 ID 列表 */
  sessionIds: string[];
  /** 产出物/附件（data 下相对路径） */
  attachments: Array<{ name: string; relPath: string; size: number }>;
  createdAt: string;
  confirmedAt: string | null;
}

/** 远程求助状态机（§九）：pending 等本地领取 → claimed/running 本地执行中 → succeeded/failed 终态 */
export type HelpStatus = 'pending' | 'claimed' | 'running' | 'succeeded' | 'failed';

/** 远程求助请求（§八~§十二） */
export interface HelpRequest {
  id: string;
  /** 目标工作会话（本地按此 ID 还原完整上下文） */
  sessionId: string;
  /** 目标用户（会话归属人，本地客户端凭其 token 领取） */
  personId: string;
  question: string;
  background: string | null;
  expectation: string | null;
  contextInfo: string | null;
  status: HelpStatus;
  replyText: string | null;
  /** 任务完成说明（本地 Codex 提交） */
  replyNote: string | null;
  error: string | null;
  /** 发起方（云端 Agent 会话）标签 */
  requesterLabel: string | null;
  requesterPersonId: string | null;
  attachments: Array<{ name: string; relPath: string; size: number }>;
  claimedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 时间穿透图（§十三）：周视图聚合，天 → 大需求 → 子任务 → 工作会话 */
export interface PierceEntry {
  id: string;
  sessionId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  minutes: number;
  briefSummary: string | null;
  detailSummary: string | null;
  sourceTool: string | null;
}
export interface PierceSubtask {
  name: string;
  minutes: number;
  entries: PierceEntry[];
}
export interface PierceRequirement {
  name: string;
  minutes: number;
  subtasks: PierceSubtask[];
}
export interface PierceDay {
  date: string; // YYYY-MM-DD
  weekday: string;
  totalMinutes: number;
  requirements: PierceRequirement[];
}
export interface PierceWeek {
  personId: string;
  weekStart: string; // 周一 YYYY-MM-DD
  weekEnd: string;
  days: PierceDay[]; // 恒 7 天
  totalMinutes: number;
}

// ===== mock 群聊（开发期替代飞书群，走同一业务代码）=====
export interface MockChatMessage {
  msgId: string;
  chatId: string;
  senderId: string; // person id 或 'everyone-bot'
  senderName: string;
  senderIsBot: boolean;
  kind: 'text' | 'image' | 'card' | 'reply';
  text?: string;
  imageUrl?: string; // /out/xxx.png 静态服务
  card?: unknown; // 卡片 JSON（mock UI 渲染）
  replyToMsgId?: string;
  /** 飞书 emoji_type 列表（需求①：机器人以表情回应替代「收到」消息） */
  reactions?: string[];
  ts: string;
}

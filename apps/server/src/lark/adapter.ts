import type { CardAction, IncomingMessage, MemberJoinedEvent } from '@everyone/shared';

/**
 * 聊天平台适配层：业务代码只面向这个接口。
 * - LarkAdapter（live.ts）：真实飞书，lark-cli 子进程
 * - MockAdapter（mock.ts）：内置模拟群聊（开发/演示/smoke 用），走同一套业务代码路径
 */
export interface ChatAdapter {
  readonly kind: 'lark' | 'mock';
  /** demo 群 chat id */
  readonly demoChatId: string;

  start(): Promise<void>;
  stop(): Promise<void>;

  onMessage(handler: (msg: IncomingMessage) => void): void;
  onCardAction(handler: (action: CardAction) => void): void;
  /** 新成员入群（快速指引触发源）：live 事件 + 成员轮询兜底 / mock 注入 */
  onMemberJoined(handler: (evt: MemberJoinedEvent) => void): void;

  sendText(to: { chatId?: string; openId?: string }, text: string, idem?: string): Promise<{ msgId: string }>;
  sendImage(to: { chatId?: string; openId?: string }, pngPath: string, idem?: string): Promise<{ msgId: string }>;
  sendCard(to: { chatId?: string; openId?: string }, card: unknown, idem?: string): Promise<{ msgId: string }>;
  replyText(msgId: string, text: string, idem?: string): Promise<{ msgId: string }>;
  replyImage(msgId: string, pngPath: string, idem?: string): Promise<{ msgId: string }>;
  /** 给消息附加原生表情回应（需求①：@Agent 后以 Get 表情替代「收到」消息）；emojiType 用飞书 emoji_type 枚举 */
  addReaction(msgId: string, emojiType: string): Promise<void>;
  recall(msgId: string): Promise<void>;
  /** 卡片点击后原地更新卡片（确认→已确认态） */
  updateCard(action: CardAction, card: unknown): Promise<void>;
  messageLink(chatId: string, msgId: string): string;
}

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CardAction, IncomingMessage, MemberJoinedEvent, MockChatMessage } from '@everyone/shared';
import { bus } from '../bus.js';
import { config } from '../config.js';
import type { ChatAdapter } from './adapter.js';
import { archiveBotMessage, cardSummaryText, currentSpeaker } from './speaker.js';

export const MOCK_CHAT_ID = 'mock-demo-chat';
const BOT_ID = 'everyone-bot';

/**
 * 模拟群聊适配器：开发期替代飞书群（用户要求的 mock 前端后端侧）。
 * - 与真实模式走完全相同的业务代码路径（onMessage → pipeline → sendXxx）
 * - 消息通过 bus 推 SSE 给 admin 的「模拟群聊」页面
 * - injectUserMessage / injectCardClick 由 admin-api 暴露给 mock UI
 */
export class MockAdapter implements ChatAdapter {
  readonly kind = 'mock' as const;
  readonly demoChatId = MOCK_CHAT_ID;
  private msgHandlers: Array<(m: IncomingMessage) => void> = [];
  private cardHandlers: Array<(a: CardAction) => void> = [];
  private joinHandlers: Array<(e: MemberJoinedEvent) => void> = [];
  /** 全部消息（mock UI 初始加载） */
  readonly history: MockChatMessage[] = [];
  /** 卡片消息 id → 卡片 JSON（点击后原地更新） */
  private cards = new Map<string, unknown>();
  /** 消息 id → 表情回应列表（需求①：smoke 断言 + sim UI 展示） */
  readonly reactions = new Map<string, string[]>();

  async start(): Promise<void> {
    bus.activity('system', '模拟群聊已就绪', `chat=${MOCK_CHAT_ID}（mock 模式，未连飞书）`);
  }
  async stop(): Promise<void> { /* 无外部进程 */ }

  onMessage(handler: (msg: IncomingMessage) => void): void { this.msgHandlers.push(handler); }
  onCardAction(handler: (action: CardAction) => void): void { this.cardHandlers.push(handler); }
  onMemberJoined(handler: (e: MemberJoinedEvent) => void): void { this.joinHandlers.push(handler); }

  /** mock UI 侧：把新人拉进群（触发快速指引） */
  injectMemberJoin(args: { personId: string; personName: string }): void {
    this.push({
      msgId: `ms-${randomUUID().slice(0, 8)}`, chatId: MOCK_CHAT_ID,
      senderId: 'system', senderName: '系统', senderIsBot: true,
      kind: 'text', text: `👥 ${args.personName} 加入了群聊`, ts: new Date().toISOString(),
    });
    const evt: MemberJoinedEvent = {
      chatId: MOCK_CHAT_ID,
      members: [{ openId: args.personId, name: args.personName }],
      via: 'mock',
    };
    for (const h of this.joinHandlers) h(evt);
  }

  private push(m: MockChatMessage) {
    this.history.push(m);
    if (this.history.length > 2000) this.history.shift();
    bus.mockMessage(m);
    // outbound 存档（需求③）：机器人的发言按当前署名进 chat_messages，与 live 模式同一行为
    if (m.senderId === BOT_ID) {
      const text = m.kind === 'card' ? cardSummaryText(m.card) : m.kind === 'image' ? '[图片]' : (m.text ?? '');
      archiveBotMessage({
        msgId: m.msgId,
        chatId: m.chatId,
        chatKind: m.chatId.startsWith('mock-p2p') ? 'p2p' : 'group',
        text,
        msgType: m.kind === 'card' ? 'interactive' : m.kind === 'image' ? 'image' : 'text',
      });
    }
  }

  /** mock UI 侧：某个虚构成员发消息 */
  injectUserMessage(args: { personId: string; personName: string; text: string; chatKind?: 'group' | 'p2p' }): IncomingMessage {
    const msgId = `mm-${randomUUID().slice(0, 8)}`;
    const chatId = args.chatKind === 'p2p' ? `mock-p2p-${args.personId}` : MOCK_CHAT_ID;
    this.push({
      msgId, chatId,
      senderId: args.personId, senderName: args.personName, senderIsBot: false,
      kind: 'text', text: args.text, ts: new Date().toISOString(),
    });
    const incoming: IncomingMessage = {
      msgId, chatId,
      chatKind: args.chatKind ?? 'group',
      senderOpenId: args.personId, // mock 模式：open_id 即 person.id
      senderName: args.personName,
      text: args.text,
      msgType: 'text',
      mentionedBot: /@everyone/i.test(args.text),
      ts: new Date().toISOString(),
      msgLink: this.messageLink(chatId, msgId),
    };
    for (const h of this.msgHandlers) h(incoming);
    return incoming;
  }

  /** mock UI 侧：点击卡片按钮 */
  injectCardClick(args: { msgId: string; operatorId: string; value: Record<string, string> }): void {
    const action: CardAction = {
      actionId: args.value.action ?? '',
      value: args.value,
      operatorOpenId: args.operatorId,
      msgId: args.msgId,
      cardToken: `mock-token-${args.msgId}`,
      ts: new Date().toISOString(),
    };
    for (const h of this.cardHandlers) h(action);
  }

  private resolveTo(to: { chatId?: string; openId?: string }): string {
    if (to.chatId) return to.chatId;
    return `mock-p2p-${to.openId}`; // 私信 → 该成员的私聊窗口
  }

  async sendText(to: { chatId?: string; openId?: string }, text: string): Promise<{ msgId: string }> {
    const msgId = `mb-${randomUUID().slice(0, 8)}`;
    this.push({
      msgId, chatId: this.resolveTo(to),
      senderId: BOT_ID, senderName: currentSpeaker(), senderIsBot: true,
      kind: 'text', text, ts: new Date().toISOString(),
    });
    return { msgId };
  }

  async sendImage(to: { chatId?: string; openId?: string }, pngPath: string): Promise<{ msgId: string }> {
    const rel = path.isAbsolute(pngPath) ? path.relative(config.root, pngPath) : pngPath;
    const msgId = `mb-${randomUUID().slice(0, 8)}`;
    this.push({
      msgId, chatId: this.resolveTo(to),
      senderId: BOT_ID, senderName: currentSpeaker(), senderIsBot: true,
      kind: 'image', imageUrl: `/${rel.replaceAll('\\', '/')}`, ts: new Date().toISOString(),
    });
    return { msgId };
  }

  async sendCard(to: { chatId?: string; openId?: string }, card: unknown): Promise<{ msgId: string }> {
    const msgId = `mb-${randomUUID().slice(0, 8)}`;
    this.cards.set(msgId, card);
    this.push({
      msgId, chatId: this.resolveTo(to),
      senderId: BOT_ID, senderName: currentSpeaker(), senderIsBot: true,
      kind: 'card', card, ts: new Date().toISOString(),
    });
    return { msgId };
  }

  async replyText(msgId: string, text: string): Promise<{ msgId: string }> {
    const orig = this.history.find((m) => m.msgId === msgId);
    const newId = `mb-${randomUUID().slice(0, 8)}`;
    this.push({
      msgId: newId, chatId: orig?.chatId ?? MOCK_CHAT_ID,
      senderId: BOT_ID, senderName: currentSpeaker(), senderIsBot: true,
      kind: 'reply', text, replyToMsgId: msgId, ts: new Date().toISOString(),
    });
    return { msgId: newId };
  }

  async replyImage(msgId: string, pngPath: string): Promise<{ msgId: string }> {
    const orig = this.history.find((m) => m.msgId === msgId);
    const rel = path.isAbsolute(pngPath) ? path.relative(config.root, pngPath) : pngPath;
    const newId = `mb-${randomUUID().slice(0, 8)}`;
    this.push({
      msgId: newId, chatId: orig?.chatId ?? MOCK_CHAT_ID,
      senderId: BOT_ID, senderName: currentSpeaker(), senderIsBot: true,
      kind: 'image', imageUrl: `/${rel.replaceAll('\\', '/')}`, replyToMsgId: msgId, ts: new Date().toISOString(),
    });
    return { msgId: newId };
  }

  async addReaction(msgId: string, emojiType: string): Promise<void> {
    const list = this.reactions.get(msgId) ?? [];
    list.push(emojiType);
    this.reactions.set(msgId, list);
    const m = this.history.find((x) => x.msgId === msgId);
    if (m) m.reactions = [...list];
    bus.emit('mock:reaction', { msgId, reactions: [...list] });
  }

  async recall(msgId: string): Promise<void> {
    const idx = this.history.findIndex((m) => m.msgId === msgId);
    if (idx >= 0) {
      this.history.splice(idx, 1);
      bus.emit('mock:recall', msgId);
    }
  }

  async updateCard(action: CardAction, card: unknown): Promise<void> {
    if (!action.msgId) return;
    const msg = this.history.find((m) => m.msgId === action.msgId);
    if (msg) {
      msg.card = card;
      this.cards.set(action.msgId, card);
      bus.emit('mock:card-update', { msgId: action.msgId, card });
    }
  }

  messageLink(chatId: string, msgId: string): string {
    return `#/chat?chat=${chatId}&msg=${msgId}`; // mock UI 内锚点
  }
}

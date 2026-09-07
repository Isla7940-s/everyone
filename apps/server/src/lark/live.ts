import type { CardAction, IncomingMessage, MemberJoinedEvent } from '@everyone/shared';
import { bus } from '../bus.js';
import { config } from '../config.js';
import { chatLog, kv, seen } from '../store/repo.js';
import type { ChatAdapter } from './adapter.js';
import { EventConsumer } from './consumer.js';
import { eventBusRunning, stopEventBus } from './health.js';
import * as im from './im.js';
import { archiveBotMessage, cardSummaryText } from './speaker.js';

const POLL_INTERVAL_MS = 5000;
const HEALTH_INTERVAL_MS = 45_000;
const MEMBER_POLL_INTERVAL_MS = 120_000;

/**
 * 真实飞书适配器：
 * - 读：event consume 常驻子进程（实时）+ user 身份轮询（§7.6 降级，双通道并行，msg_id 幂等去重）
 * - 写：lark-cli +shortcut
 */
export class LarkAdapter implements ChatAdapter {
  readonly kind = 'lark' as const;
  readonly demoChatId: string;
  private msgConsumer: EventConsumer | null = null;
  private cardConsumer: EventConsumer | null = null;
  private joinConsumer: EventConsumer | null = null;
  private msgHandlers: Array<(m: IncomingMessage) => void> = [];
  private cardHandlers: Array<(a: CardAction) => void> = [];
  private joinHandlers: Array<(e: MemberJoinedEvent) => void> = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private memberPollTimer: NodeJS.Timeout | null = null;
  private memberPolling = false;
  private healthTimer: NodeJS.Timeout | null = null;
  private unhealthyCount = 0;
  private healing = false;
  /** 机器人在群里的显示名（判断 @Everyone 用） */
  botNames = ['everyone', 'Everyone'];

  constructor(demoChatId: string) {
    this.demoChatId = demoChatId;
  }

  async start(): Promise<void> {
    this.msgConsumer = new EventConsumer(
      'im.message.receive_v1',
      (evt) => this.handleMessageEvent(evt),
      () => bus.activity('system', '消息订阅重启完成，轮询通道持续兜底'),
    );
    this.cardConsumer = new EventConsumer('card.action.trigger', (evt) => this.handleCardEvent(evt));
    // 新成员入群事件（快速指引触发源；控制台未订阅该事件时由成员轮询兜底）
    this.joinConsumer = new EventConsumer('im.chat.member.user.added_v1', (evt) => this.handleMemberJoinEvent(evt));
    // 并行启动；card.action.trigger 未在控制台订阅时会持续退避重启，不阻塞
    this.msgConsumer.start().catch(() => {});
    this.cardConsumer.start().catch(() => {});
    this.joinConsumer.start().catch(() => {});

    // 轮询通道（双通道并行：事件通了秒级，未通 ≤5s；seen 表幂等去重）
    this.pollTimer = setInterval(() => this.pollAll(), POLL_INTERVAL_MS);
    bus.activity('system', '轮询通道已启动', `${POLL_INTERVAL_MS / 1000}s 间隔 · 群 + 私聊`);

    // 成员轮询兜底（入群事件未订阅/丢失时 ≤2 分钟发现新成员；onboard 层 kv 幂等）
    this.memberPollTimer = setInterval(() => { this.pollMembers().catch(() => {}); }, MEMBER_POLL_INTERVAL_MS);
    setTimeout(() => { this.pollMembers(true).catch(() => {}); }, 8_000);

    // 事件总线看门狗：僵尸总线自愈（卡片回调无轮询兜底，必须保证实时通道活着）
    this.healthTimer = setInterval(() => { this.healthCheck().catch(() => {}); }, HEALTH_INTERVAL_MS);
    setTimeout(() => {
      this.healthCheck(true).catch(() => {});
    }, 12_000);
  }

  /** 总线健康检查；连续 2 次不健康（或启动自检失败）→ 清僵尸 + 重建订阅 */
  private async healthCheck(startupProbe = false): Promise<void> {
    if (this.healing) return;
    const running = await eventBusRunning();
    if (running) {
      if (this.unhealthyCount > 0 || startupProbe) {
        bus.activity('system', startupProbe ? '启动自检：事件总线健康' : '事件总线恢复健康', '卡片回调实时通道正常');
      }
      this.unhealthyCount = 0;
      return;
    }
    this.unhealthyCount += 1;
    bus.activity('system', `事件总线不健康（第 ${this.unhealthyCount} 次探测）`, '实时通道断开：消息有轮询兜底，卡片回调正在丢失');
    if (this.unhealthyCount < 2 && !startupProbe) return;

    this.healing = true;
    try {
      bus.activity('system', '事件通道自愈开始', '清理僵尸总线 → 重建两路订阅');
      await stopEventBus();
      await Promise.all([this.msgConsumer?.stop(), this.cardConsumer?.stop(), this.joinConsumer?.stop()]);
      await this.msgConsumer?.start();
      await this.cardConsumer?.start();
      await this.joinConsumer?.start();
      this.unhealthyCount = 0;
      const ok = await eventBusRunning();
      bus.activity('system', ok ? '事件通道自愈完成' : '自愈后总线仍未就绪，等待下轮', ok ? '卡片回调已恢复' : '');
    } catch (e) {
      bus.activity('system', '事件通道自愈失败', String(e).slice(0, 200));
    } finally {
      this.healing = false;
    }
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.memberPollTimer) clearInterval(this.memberPollTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    await Promise.all([this.msgConsumer?.stop(), this.cardConsumer?.stop(), this.joinConsumer?.stop()]);
  }

  /** p2p 会话注册（bot 首次私信某人时记录，供轮询） */
  private registerP2p(chatId: string) {
    const list = kv.getJson<string[]>('p2p_chats', []);
    if (!list.includes(chatId)) {
      list.push(chatId);
      kv.setJson('p2p_chats', list);
    }
  }

  private async pollAll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const chats: Array<{ id: string; kind: 'group' | 'p2p' }> = [];
      if (this.demoChatId) chats.push({ id: this.demoChatId, kind: 'group' });
      for (const id of kv.getJson<string[]>('p2p_chats', [])) chats.push({ id, kind: 'p2p' });
      for (const c of chats) {
        await this.pollChat(c.id, c.kind).catch(() => {});
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollChat(chatId: string, kind: 'group' | 'p2p'): Promise<void> {
    const msgs = await im.listChatMessages(chatId);
    // desc 序 → 逆转为时间序处理
    for (const m of msgs.reverse()) {
      if (!m?.message_id || m.deleted) continue;
      if (m.msg_type !== 'text' && m.msg_type !== 'post' && m.msg_type !== 'image') continue;
      if (m.sender?.sender_type !== 'user') continue; // bot/system 消息不进管道
      // 幂等预检（pipeline 里 seen.firstTime 才是真正的消费点；这里避免重复构造）
      if (!seen.peek(m.message_id)) {
        const text = String(m.content ?? '');
        const msg: IncomingMessage = {
          msgId: m.message_id,
          chatId,
          chatKind: kind,
          senderOpenId: m.sender?.id ?? '',
          senderName: m.sender?.sender_i18n_names?.zh_cn ?? m.sender?.name ?? undefined,
          text,
          msgType: m.msg_type,
          mentionedBot: this.botNames.some((n) => text.toLowerCase().includes(`@${n.toLowerCase()}`)),
          ts: m.create_time ? new Date(m.create_time.replace(' ', 'T') + '+08:00').toISOString() : new Date().toISOString(),
          msgLink: m.message_app_link ?? im.messageLink(chatId, m.message_id),
        };
        for (const h of this.msgHandlers) h(msg);
      }
    }
  }

  private handleMessageEvent(evt: any) {
    if (!evt?.message_id) return;
    if (evt.sender_type === 'bot') return; // 忽略机器人自身消息，防循环
    const text: string = typeof evt.content === 'string' ? evt.content : JSON.stringify(evt.content ?? '');
    const mentions: Array<{ id: string; name: string }> = evt.mentions ?? [];
    const botIds = kv.getJson<string[]>('bot_open_ids', []);
    const mentionedBot = mentions.some(
      (m) => botIds.includes(m.id) || this.botNames.some((n) => (m.name ?? '').toLowerCase().includes(n.toLowerCase())),
    );
    const msg: IncomingMessage = {
      msgId: evt.message_id,
      chatId: evt.chat_id,
      chatKind: evt.chat_type === 'group' ? 'group' : 'p2p',
      senderOpenId: evt.sender_id ?? '',
      text,
      msgType: evt.message_type ?? 'text',
      mentionedBot,
      ts: evt.create_time ? new Date(Number(evt.create_time)).toISOString() : new Date().toISOString(),
      msgLink: im.messageLink(evt.chat_id, evt.message_id),
    };
    for (const h of this.msgHandlers) h(msg);
  }

  /** 入群事件（lark-cli 拍平字段宽容解析：users / event.users，member_id / open_id） */
  private handleMemberJoinEvent(evt: any) {
    const chatId: string = evt?.chat_id ?? evt?.event?.chat_id ?? this.demoChatId;
    const rawUsers: any[] = evt?.users ?? evt?.event?.users ?? [];
    const members = rawUsers
      .map((u) => ({
        openId: u?.user_id?.open_id ?? u?.open_id ?? u?.member_id ?? '',
        name: u?.name ?? '',
      }))
      .filter((m) => m.openId.startsWith('ou_'));
    if (!members.length) return;
    this.rememberKnownMembers(chatId, members.map((m) => m.openId));
    const e: MemberJoinedEvent = { chatId, members, via: 'event' };
    for (const h of this.joinHandlers) h(e);
  }

  /**
   * 成员轮询兜底：对比群成员列表与已知集合，新增成员触发入群事件。
   * 首轮（kv 无记录）只建立基线不触发——启动时把存量成员当新人会全员刷屏。
   */
  private async pollMembers(startup = false): Promise<void> {
    if (this.memberPolling || !this.demoChatId) return;
    this.memberPolling = true;
    try {
      const { users, botOpenIds } = await im.chatMembers(this.demoChatId);
      if (botOpenIds.length) kv.setJson('bot_open_ids', botOpenIds);
      const key = `known_members:${this.demoChatId}`;
      const known = kv.getJson<string[]>(key, []);
      const current = users.map((u) => u.member_id).filter((id) => id?.startsWith('ou_'));
      if (!known.length) {
        kv.setJson(key, current);
        if (startup) bus.activity('system', '成员基线已建立', `${current.length} 人（入群检测双通道：事件 + ${MEMBER_POLL_INTERVAL_MS / 1000}s 轮询）`);
        return;
      }
      const fresh = users.filter((u) => u.member_id?.startsWith('ou_') && !known.includes(u.member_id));
      if (fresh.length) {
        kv.setJson(key, [...new Set([...known, ...current])]);
        const e: MemberJoinedEvent = {
          chatId: this.demoChatId,
          members: fresh.map((u) => ({ openId: u.member_id, name: u.name })),
          via: 'poll',
        };
        for (const h of this.joinHandlers) h(e);
      } else if (current.length && current.length !== known.length) {
        kv.setJson(key, current); // 有人退群：收缩基线，避免退了再进不触发
      }
    } finally {
      this.memberPolling = false;
    }
  }

  /** 事件通道先到时把成员记入基线，避免轮询通道重复触发 */
  private rememberKnownMembers(chatId: string, openIds: string[]) {
    const key = `known_members:${chatId}`;
    const known = kv.getJson<string[]>(key, []);
    const merged = [...new Set([...known, ...openIds])];
    if (merged.length !== known.length) kv.setJson(key, merged);
  }

  private handleCardEvent(evt: any) {
    let value: Record<string, string> = {};
    try { value = JSON.parse(evt.action_value ?? '{}'); } catch { /* 非 JSON value */ }
    const action: CardAction = {
      actionId: value.action ?? evt.action_name ?? '',
      value,
      operatorOpenId: evt.operator_id ?? '',
      msgId: evt.message_id,
      cardToken: evt.token,
      ts: evt.timestamp ? new Date(Number(evt.timestamp)).toISOString() : new Date().toISOString(),
    };
    for (const h of this.cardHandlers) h(action);
  }

  onMessage(handler: (msg: IncomingMessage) => void): void { this.msgHandlers.push(handler); }
  onCardAction(handler: (action: CardAction) => void): void { this.cardHandlers.push(handler); }
  onMemberJoined(handler: (e: MemberJoinedEvent) => void): void { this.joinHandlers.push(handler); }

  async sendText(to: { chatId?: string; openId?: string }, text: string, idem?: string) {
    const r = await im.sendText(to, text, idem);
    if (to.openId && (r as any).chat_id) this.registerP2p((r as any).chat_id);
    this.markOwnMessage(r.message_id);
    this.archiveSent(r, to, text);
    return { msgId: r.message_id };
  }
  async sendImage(to: { chatId?: string; openId?: string }, pngPath: string, idem?: string) {
    const r = await im.sendImage(to, pngPath, idem);
    if (to.openId && (r as any).chat_id) this.registerP2p((r as any).chat_id);
    this.markOwnMessage(r.message_id);
    this.archiveSent(r, to, '[图片]', 'image');
    return { msgId: r.message_id };
  }
  async sendCard(to: { chatId?: string; openId?: string }, card: unknown, idem?: string) {
    const r = await im.sendCard(to, card, idem);
    if (to.openId && (r as any).chat_id) this.registerP2p((r as any).chat_id);
    this.markOwnMessage(r.message_id);
    this.archiveSent(r, to, cardSummaryText(card), 'interactive');
    return { msgId: r.message_id };
  }

  /** 机器人自己发的消息进 seen，防止轮询/事件把它当输入 */
  private markOwnMessage(msgId: string) {
    if (msgId) seen.firstTime(msgId);
  }

  /** outbound 存档（需求③）：直发消息，目标会话已知 */
  private archiveSent(r: im.SentMessage, to: { chatId?: string; openId?: string }, text: string, msgType?: string) {
    const chatId = to.chatId ?? (r as any).chat_id ?? '';
    if (!chatId) return;
    archiveBotMessage({ msgId: r.message_id, chatId, chatKind: to.openId ? 'p2p' : null, text, msgType });
  }

  /** outbound 存档（需求③）：回复消息，从被回复消息的存档反查会话 */
  private archiveReply(r: im.SentMessage, replyToMsgId: string, text: string, msgType?: string) {
    const orig = chatLog.byMsgId(replyToMsgId);
    const chatId = orig?.chatId ?? (r as any).chat_id ?? '';
    if (!chatId) return;
    archiveBotMessage({
      msgId: r.message_id, chatId,
      chatKind: (orig?.chatKind as 'group' | 'p2p' | undefined) ?? null,
      text, msgType,
    });
  }
  async replyText(msgId: string, text: string, idem?: string) {
    const r = await im.replyText(msgId, text, idem);
    this.markOwnMessage(r.message_id);
    this.archiveReply(r, msgId, text);
    return { msgId: r.message_id };
  }
  async replyImage(msgId: string, pngPath: string, idem?: string) {
    const r = await im.replyImage(msgId, pngPath, idem);
    this.markOwnMessage(r.message_id);
    this.archiveReply(r, msgId, '[图片]', 'image');
    return { msgId: r.message_id };
  }
  async addReaction(msgId: string, emojiType: string): Promise<void> {
    await im.addReaction(msgId, emojiType);
  }
  async recall(msgId: string): Promise<void> {
    await im.recallMessage(msgId);
  }
  async updateCard(action: CardAction, card: unknown): Promise<void> {
    if (!action.cardToken && !action.msgId) return;
    await im.updateCard(action.cardToken, card, action.operatorOpenId, action.msgId);
  }
  messageLink(chatId: string, msgId: string): string {
    return im.messageLink(chatId, msgId);
  }
}

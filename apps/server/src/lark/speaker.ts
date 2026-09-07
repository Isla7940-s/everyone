import { AsyncLocalStorage } from 'node:async_hooks';
import { chatLog, chats } from '../store/repo.js';

/**
 * 机器人发言署名与存档（需求③）：
 * Everyone 只有一个机器人账号，但业务上分「超级代理本体」与「某人的分身」两种身份。
 * 发送链路用 AsyncLocalStorage 携带当前身份标签；outbound 消息按标签写进 chat_messages，
 * 后续所有喂给 Agent/快速模式的群聊上下文（chatLog.recent）自然包含机器人自己的发言且身份可辨。
 */

const als = new AsyncLocalStorage<string>();

export const SUPER_AGENT_LABEL = 'Everyone（超级代理）';

export const avatarSpeaker = (personName: string): string => `Everyone（${personName}的分身）`;

/** 在 fn 执行期间（含其中的全部 await 链）以指定身份署名发言 */
export function withSpeaker<T>(label: string, fn: () => T): T {
  return als.run(label, fn);
}

export function currentSpeaker(): string {
  return als.getStore() ?? SUPER_AGENT_LABEL;
}

/** 卡片 JSON → 存档摘要文本（标题 + 正文要点，供上下文引用，不存原始 JSON） */
export function cardSummaryText(card: unknown): string {
  try {
    const c = card as Record<string, any>;
    const parts: string[] = [];
    const headerTitle = c?.header?.title?.content;
    if (headerTitle) parts.push(String(headerTitle));
    for (const el of (Array.isArray(c?.elements) ? c.elements : []).slice(0, 6)) {
      const t = el?.text?.content ?? (Array.isArray(el?.elements) ? el.elements.map((x: any) => x?.content ?? '').join(' ') : '');
      if (t) parts.push(String(t).replace(/\s+/g, ' '));
    }
    const body = parts.join(' | ').slice(0, 400);
    return body ? `[卡片] ${body}` : '[卡片]';
  } catch {
    return '[卡片]';
  }
}

/**
 * outbound 存档入口（live/mock 适配器发送成功后调用）。
 * chatKind 未知时按 chats 注册表推断，仍未知按 group 兜底。
 */
export function archiveBotMessage(args: {
  msgId: string;
  chatId: string;
  chatKind?: 'group' | 'p2p' | null;
  text: string;
  msgType?: string;
}): void {
  if (!args.msgId || !args.chatId || !args.text.trim()) return;
  try {
    const info = chats.byId(args.chatId);
    if (info && !info.collectEnabled) return; // 采集开关对机器人发言同样生效（禁的是「收集保存」）
    const kind = args.chatKind
      ?? info?.kind
      ?? (args.chatId.includes('p2p') ? 'p2p' : 'group');
    chatLog.saveBot({
      msgId: args.msgId,
      chatId: args.chatId,
      chatKind: kind,
      senderName: currentSpeaker(),
      text: args.text.slice(0, 2000),
      msgType: args.msgType,
    });
  } catch { /* 存档失败不阻断发送主链路 */ }
}

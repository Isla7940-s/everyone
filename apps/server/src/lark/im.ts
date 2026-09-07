import path from 'node:path';
import { config } from '../config.js';
import { larkExec } from './exec.js';

export interface SentMessage {
  message_id: string;
  [k: string]: unknown;
}

function target(to: { chatId?: string; openId?: string }): string[] {
  if (to.chatId) return ['--chat-id', to.chatId];
  if (to.openId) return ['--user-id', to.openId];
  throw new Error('sendText: 需要 chatId 或 openId');
}

/** 发文本（群或私信） */
export async function sendText(to: { chatId?: string; openId?: string }, text: string, idem?: string): Promise<SentMessage> {
  const data = await larkExec<any>(['im', '+messages-send', '--as', 'bot', ...target(to), '--text', text], { idempotencyKey: idem });
  return normalizeSent(data);
}

/** 发图片：pngPath 必须在项目根之下（cwd 相对路径约束） */
export async function sendImage(to: { chatId?: string; openId?: string }, pngPath: string, idem?: string): Promise<SentMessage> {
  const rel = path.isAbsolute(pngPath) ? path.relative(config.root, pngPath) : pngPath;
  if (rel.startsWith('..')) throw new Error(`图片必须位于项目根之下: ${pngPath}`);
  const data = await larkExec<any>(['im', '+messages-send', '--as', 'bot', ...target(to), '--image', rel], { idempotencyKey: idem });
  return normalizeSent(data);
}

/** 发交互卡片（spawn 直接传参，无 shell 转义问题） */
export async function sendCard(to: { chatId?: string; openId?: string }, card: unknown, idem?: string): Promise<SentMessage> {
  const data = await larkExec<any>(
    ['im', '+messages-send', '--as', 'bot', ...target(to), '--msg-type', 'interactive', '--content', JSON.stringify(card)],
    { idempotencyKey: idem },
  );
  return normalizeSent(data);
}

/** 回复某条消息 */
export async function replyText(messageId: string, text: string, idem?: string): Promise<SentMessage> {
  const data = await larkExec<any>(['im', '+messages-reply', '--as', 'bot', '--message-id', messageId, '--text', text], { idempotencyKey: idem });
  return normalizeSent(data);
}

/** 回复图片 */
export async function replyImage(messageId: string, pngPath: string, idem?: string): Promise<SentMessage> {
  const rel = path.isAbsolute(pngPath) ? path.relative(config.root, pngPath) : pngPath;
  if (rel.startsWith('..')) throw new Error(`图片必须位于项目根之下: ${pngPath}`);
  const data = await larkExec<any>(['im', '+messages-reply', '--as', 'bot', '--message-id', messageId, '--image', rel], { idempotencyKey: idem });
  return normalizeSent(data);
}

/** 撤回（帮你答撤回用） */
export async function recallMessage(messageId: string): Promise<void> {
  await larkExec<any>(['im', '+messages-delete', '--as', 'bot', '--message-id', messageId, '--yes']);
}

/** 给消息附加表情回应（需求①）：emojiType 见飞书 emoji_type 枚举（如 Get / OneSecond / DONE / THUMBSUP） */
export async function addReaction(messageId: string, emojiType: string): Promise<void> {
  await larkExec<any>([
    'im', 'reactions', 'create', '--as', 'bot',
    '--params', JSON.stringify({ message_id: messageId }),
    '--data', JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
  ]);
}

/**
 * 更新已发出的卡片。
 * 首选 im.messages.patch（对**所有成员**生效，14 天内可改）——
 * 延时更新 API + open_ids 只改点击者一个人的视图，群里其他人会永远看到活按钮（实测坑）。
 * patch 失败（超 14 天等）时回落延时更新 token 通道。
 */
export async function updateCard(token: string | undefined, card: unknown, operatorOpenId?: string, messageId?: string): Promise<void> {
  if (messageId) {
    try {
      await larkExec<any>([
        'api', 'PATCH', `/open-apis/im/v1/messages/${messageId}`, '--as', 'bot',
        '--data', JSON.stringify({ content: JSON.stringify(card) }),
      ]);
      return;
    } catch { /* 回落延时更新 */ }
  }
  if (!token) throw new Error('updateCard: 既无 messageId 可 patch，也无延时更新 token');
  const cardObj = { ...(card as Record<string, unknown>) };
  if (operatorOpenId) cardObj.open_ids = [operatorOpenId];
  await larkExec<any>(
    ['api', 'POST', '/open-apis/interactive/v1/card/update', '--as', 'bot', '--data', JSON.stringify({ token, card: cardObj })],
  );
}

/** 群成员列表（open_id → name 映射）；bot 无权限时降级 user 身份 */
export async function chatMembers(chatId: string): Promise<{ users: Array<{ member_id: string; name: string }>; botOpenIds: string[] }> {
  let data: any;
  try {
    data = await larkExec<any>(['im', '+chat-members-list', '--as', 'bot', '--chat-id', chatId, '--page-all']);
  } catch {
    data = await larkExec<any>(['im', '+chat-members-list', '--as', 'user', '--chat-id', chatId, '--page-all']);
  }
  const users = (data?.users ?? data?.items ?? data?.members ?? []).map((m: any) => ({
    member_id: m.member_id ?? m.open_id ?? m.id,
    name: m.name ?? m.member_name ?? '',
  }));
  const botOpenIds = (data?.bots ?? []).map((b: any) => b.member_id).filter(Boolean);
  return { users, botOpenIds };
}

/** 轮询群历史（降级路径 §7.6，用 user 身份） */
export async function listChatMessages(chatId: string, opts?: { pageAll?: boolean }): Promise<any[]> {
  const args = ['im', '+chat-messages-list', '--as', 'user', '--chat-id', chatId, '--order', 'desc'];
  if (opts?.pageAll) args.push('--page-all');
  const data = await larkExec<any>(args);
  return data?.items ?? data?.messages ?? [];
}

/** 下载消息里的图片/文件（用户发图理解链路）；bot 无权限时降级 user 身份 */
export async function downloadMessageResource(messageId: string, fileKey: string, outRelPath: string, type: 'image' | 'file' = 'image'): Promise<string | null> {
  const args = ['im', '+messages-resources-download', '--message-id', messageId, '--file-key', fileKey, '--type', type, '--output', outRelPath];
  try {
    const data = await larkExec<any>([...args, '--as', 'bot']);
    return data?.saved_path ?? outRelPath;
  } catch {
    try {
      const data = await larkExec<any>([...args, '--as', 'user']);
      return data?.saved_path ?? outRelPath;
    } catch {
      return null;
    }
  }
}

/** 建群（demo 群初始化用） */
export async function chatCreate(name: string, memberOpenIds: string[]): Promise<{ chat_id: string }> {
  const args = ['im', '+chat-create', '--as', 'bot', '--name', name, '--set-bot-manager'];
  if (memberOpenIds.length) args.push('--users', memberOpenIds.join(','));
  const data = await larkExec<any>(args);
  return { chat_id: data?.chat_id ?? data?.chat?.chat_id ?? '' };
}

export async function chatList(): Promise<Array<{ chat_id: string; name: string }>> {
  const data = await larkExec<any>(['im', '+chat-list', '--as', 'bot', '--page-all']);
  return (data?.chats ?? data?.items ?? []) as any[];
}

function normalizeSent(data: any): SentMessage {
  return { ...data, message_id: data?.message_id ?? data?.data?.message_id ?? '' };
}

/** 消息链接（飞书客户端可点击跳转） */
export function messageLink(chatId: string, msgId: string): string {
  return `https://applink.feishu.cn/client/message/link/open?target=sidebar-detail&open_chat_id=${chatId}&open_message_id=${msgId}`;
}

import type { CardAction } from '@everyone/shared';
import { bus } from '../bus.js';
import { adapter } from '../context.js';

/**
 * 卡片交互「永不静默」契约（卡片「点不了」根治的另一半）：
 * 任何一次卡片点击，点击者必须得到可见结果——原地更新、回复消息，至少二选一。
 * 幂等键用 msgId+actionId（+操作者），重复点击不刷屏。
 */

/** 给点击者可见反馈：回复在卡片消息串下 */
export async function cardFeedback(action: CardAction, text: string): Promise<void> {
  if (!action.msgId) return;
  const idem = `cardfb-${action.msgId}-${action.actionId}-${action.operatorOpenId.slice(-6)}`;
  await adapter().replyText(action.msgId, text, idem).catch((e) => {
    bus.activity('system', '卡片反馈发送失败', String(e).slice(0, 150));
  });
}

/** 原地更新卡片；失败时降级为回复文字，保证点击者能看到结果 */
export async function updateCardOrNotify(action: CardAction, card: unknown, fallbackText: string): Promise<void> {
  try {
    await adapter().updateCard(action, card);
  } catch (e) {
    bus.activity('system', '卡片原地更新失败，降级为回复', String(e).slice(0, 150));
    await cardFeedback(action, fallbackText);
  }
}

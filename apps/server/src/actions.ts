import type { CardAction } from '@everyone/shared';
import { bus } from './bus.js';
import { cardFeedback } from './lark/feedback.js';
import { handleTaskCardAction } from './ledger/tasks.js';
import { handleNudgeCardAction } from './ledger/nudge.js';
import { handleDraftCardAction } from './executor/runner.js';
import { handleCollectCardAction } from './presence/collect.js';
import { handleAnswerCardAction } from './presence/answer.js';
import { handleHeartbeatCardAction } from './agent/heartbeat.js';

const TEXT_FALLBACK_HINT = '也可以直接回复文字指令：确认 / 修改 / 忽略 / 发布 / 放弃 / 知道了 / 转任务 / 不归我管 / 撤回 / 已完成 / 顺利 / 有风险';

/**
 * 卡片动作总路由。
 * 永不静默契约：无论命中与否、成功与否，点击者必须得到可见反馈——
 * 「点了没反应」这个体验在任何分支下都不允许出现。
 */
export async function onCardAction(action: CardAction): Promise<void> {
  bus.activity('message', `卡片动作：${action.actionId}`, `by ${action.operatorOpenId.slice(0, 12)}`);
  if (!action.actionId || action.actionId === 'noop') return; // 纯跳转按钮无业务语义
  let handled = false;
  try {
    if (action.actionId.startsWith('task_')) {
      handled = await handleTaskCardAction(action);
    } else if (action.actionId.startsWith('nudge_')) {
      handled = await handleNudgeCardAction(action);
    } else if (action.actionId === 'run_retry') {
      handled = await handleTaskCardAction(action);
      if (!handled) handled = await handleDraftCardAction(action);
    } else if (action.actionId.startsWith('draft_')) {
      handled = await handleDraftCardAction(action);
    } else if (action.actionId.startsWith('collect_')) {
      handled = await handleCollectCardAction(action);
    } else if (action.actionId.startsWith('answer_')) {
      handled = await handleAnswerCardAction(action);
    } else if (action.actionId.startsWith('hb_')) {
      handled = await handleHeartbeatCardAction(action);
    }
  } catch (e) {
    bus.activity('system', `卡片动作处理失败：${action.actionId}`, String(e).slice(0, 200));
    await cardFeedback(action, `⚠️ 处理这次点击时出了错，已记录待排查。\n${TEXT_FALLBACK_HINT}`);
    return;
  }
  if (!handled) {
    bus.activity('system', `卡片动作未命中处理器：${action.actionId}`, '已回复点击者卡片失效提示');
    await cardFeedback(action, `⚠️ 这张卡片已失效（对应的任务可能已处理过或数据已重置）。\n${TEXT_FALLBACK_HINT}`);
  }
}

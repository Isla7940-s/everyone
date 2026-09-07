import type { CardAction, IncomingMessage, Person } from '@everyone/shared';
import { bus } from '../bus.js';
import { config } from '../config.js';
import { adapter } from '../context.js';
import * as cards from '../ledger/cards.js';
import { proposeTask } from '../ledger/tasks.js';
import { chatJson } from '../llm/client.js';
import * as memory from '../memory/index.js';
import { prompt } from '../prompts.js';
import { assists, chatLog, pendingCards, persons, routingFeedback, tasks } from '../store/repo.js';

/** 帮你收（S8/FR-J1/J2）：意见 → 责任人 → 记入记忆 + 私信卡 */
export async function handleOpinion(msg: IncomingMessage, sender: Person | null, senderName: string, clsConfidence: number): Promise<void> {
  const profiles = persons.all().map((p) => {
    const mem = memory.readPersonMemory(p.id);
    const domainLine = mem.split('\n').find((l) => l.includes('负责域')) ?? '';
    return `${p.id} | ${p.name} | ${domainLine.replace(/^-\s*/, '') || '（未填负责域）'}`;
  }).join('\n');
  const taskLines = tasks.all({ statuses: ['todo', 'running', 'reviewing'] })
    .map((t) => `${persons.byId(t.ownerId)?.name}：${t.title}`).join('\n') || '（无）';

  const route = await chatJson<{ target_person_id: string; confidence: number; summary: string }>(
    '你是意见路由器，只输出 JSON。',
    prompt('route_opinion', {
      sender: senderName,
      text: msg.text,
      profiles,
      tasks: taskLines,
      feedback: persons.all().map((p) => {
        const fb = routingFeedback.ofPerson(p.id);
        return fb.length ? `${p.name}：${fb.join('；')}` : '';
      }).filter(Boolean).join('\n') || '（无）',
    }),
    { fast: true, temperature: 0 },
  );

  const target = persons.byId(route.target_person_id);
  const confidence = Math.min(clsConfidence, route.confidence ?? 0);
  if (!target || confidence < 0.6) {
    // 低置信度只进后台待认领（FR-J1）
    assists.create({
      type: 'collect', personId: target?.id ?? 'unknown',
      content: `${route.summary ?? msg.text.slice(0, 50)}（待认领）`,
      srcMsgLink: msg.msgLink ?? null, status: 'skipped',
    });
    bus.changed('assist');
    bus.activity('assist', `意见责任人不明确，进后台待认领`, msg.text.slice(0, 60));
    return;
  }
  if (!target.collectEnabled) {
    bus.activity('assist', `帮你收已被 ${target.name} 关闭，跳过`);
    return;
  }

  // 写入责任人记忆（L1 类型=意见）
  memory.capture({
    personId: target.id, chatId: msg.chatId,
    content: `【意见】${senderName}：${msg.text}`,
    sourceLink: msg.msgLink ?? null, kind: 'feedback',
  }).catch(() => {});
  memory.appendPersonMemory(target.id, [`收到意见：${route.summary}（来自${senderName}）`], '群内意见');

  // 私信责任人（FR-J2）；虚拟成员在 live 无飞书账号 → 不发私信，落后台（工作台可见）
  const { dmTargetOf } = await import('../lark/dm.js');
  const to = dmTargetOf(target);
  if (!to) {
    assists.create({
      type: 'collect', personId: target.id, content: `${msg.text}（虚拟成员无法私信，已入后台）`,
      srcMsgLink: msg.msgLink ?? null, status: 'notified',
    });
    bus.changed('assist');
    bus.activity('assist', `意见已路由给 ${target.name}（虚拟成员，仅记入记忆与后台）`, route.summary);
    return;
  }
  const assist = assists.create({
    type: 'collect', personId: target.id, content: msg.text,
    srcMsgLink: msg.msgLink ?? null, status: 'notified',
  });
  bus.changed('assist');
  const card = cards.collectCard(assist.id, msg.text.slice(0, 200), senderName, msg.msgLink ?? null);
  const sent = await adapter().sendCard(to, card, `collect-${assist.id}`);
  pendingCards.save(sent.msgId, 'collect', { assistId: assist.id, srcMsgId: msg.msgId, chatId: msg.chatId });
  bus.activity('assist', `意见已路由给 ${target.name} 并私信告知`, route.summary);
}

/** 帮你收卡片动作：知道了 / 转为任务 / 不归我管 */
export async function handleCollectCardAction(action: CardAction): Promise<boolean> {
  const assistId = action.value.assist_id;
  if (!assistId) return false;
  const assist = assists.byId(assistId);
  if (!assist) return false;
  const person = persons.byId(assist.personId);
  const operator = persons.byOpenId(action.operatorOpenId) ?? persons.byId(action.operatorOpenId);
  if (operator?.id !== assist.personId) {
    const { cardFeedback } = await import('../lark/feedback.js');
    await cardFeedback(action, `这张卡片只有 ${person?.name ?? '本人'} 能操作`);
    return true;
  }

  switch (action.actionId) {
    case 'collect_ack': {
      assists.setStatus(assistId, 'acked');
      bus.changed('assist');
      const { updateCardOrNotify } = await import('../lark/feedback.js');
      await updateCardOrNotify(action, cards.collectDoneCard(assist.content.slice(0, 120), '已知晓'), '好的，已标记为知晓');
      bus.activity('assist', `${person?.name} 已知晓意见`);
      return true;
    }
    case 'collect_to_task': {
      assists.setStatus(assistId, 'converted');
      bus.changed('assist');
      const { updateCardOrNotify } = await import('../lark/feedback.js');
      await updateCardOrNotify(action, cards.collectDoneCard(assist.content.slice(0, 120), '已转为任务'), '已转为任务，稍后发确认卡');
      // 复用 S1 确认入账（FR-J2）：直接以 pending_confirm 提出，本人再点确认
      const ctx = pendingCards.get(action.msgId ?? '')?.payload as { srcMsgId?: string; chatId?: string } | undefined;
      const fakeMsg: IncomingMessage = {
        msgId: (ctx?.srcMsgId as string) ?? `assist-${assistId}`,
        chatId: (ctx?.chatId as string) ?? adapter().demoChatId,
        chatKind: 'group',
        senderOpenId: assist.personId,
        senderName: person?.name,
        text: assist.content,
        msgType: 'text',
        ts: new Date().toISOString(),
        msgLink: assist.srcMsgLink ?? undefined,
      };
      await proposeTask({
        ownerId: assist.personId,
        title: assist.content.length > 24 ? `处理意见：${assist.content.slice(0, 20)}…` : `处理意见：${assist.content}`,
        source: 'manual',
        important: true, urgent: false, dueAt: null,
        confidence: 1,
        srcMsg: fakeMsg, srcText: assist.content,
      });
      bus.activity('assist', `${person?.name} 将意见转为任务`);
      return true;
    }
    case 'collect_reject': {
      assists.setStatus(assistId, 'rejected');
      bus.changed('assist');
      routingFeedback.add(assist.personId, assist.content.slice(0, 60));
      const { updateCardOrNotify } = await import('../lark/feedback.js');
      await updateCardOrNotify(action, cards.collectDoneCard(assist.content.slice(0, 120), '不归我管（已记住）'), '明白，这类意见以后不再派给你');
      bus.activity('assist', `${person?.name} 标记不归我管，已记入修正依据`);
      return true;
    }
  }
  return false;
}

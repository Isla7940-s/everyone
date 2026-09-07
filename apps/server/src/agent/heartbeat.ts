import fs from 'node:fs';
import path from 'node:path';
import type { CardAction, Heartbeat, Person } from '@everyone/shared';
import { bus } from '../bus.js';
import { recentSummariesBlock } from '../collab/service.js';
import { config } from '../config.js';
import { adapter } from '../context.js';
import { spawnOpenCode } from '../executor/opencode.js';
import { dmTargetOf } from '../lark/dm.js';
import { agentRuns, heartbeats, pendingCards, persons } from '../store/repo.js';
import { fmtStamp, nowStamp } from '../time.js';
import { closeAgentSession, createAgentSession } from './session.js';
import { plantAgentSkills, withAgentSlot } from './run.js';

/**
 * 心跳任务（七项需求 7）：
 * Agent 经 MCP 标准传参创建 → 确认卡私信创建人 → 本人确认才启动 →
 * 调度器到点在该任务的独立沙箱里唤醒 OpenCode（任务需求 + 当前时间），
 * Agent 可用全部 MCP 工具（含历史消息检索），产出私信创建人。
 */

/** 心跳独立沙箱：workspaces/_heartbeat/<id>/（跨触发持久——Agent 可以留笔记积累状态） */
export function heartbeatSandbox(hbId: string): string {
  const dir = path.join(config.workspacesDir, '_heartbeat', hbId);
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  plantAgentSkills(dir);
  return dir;
}

const fmtPlan = (hb: Heartbeat): string => {
  const times = hb.totalRuns === 0 ? '无限次' : `共 ${hb.totalRuns} 次`;
  const interval = hb.intervalMin > 0
    ? hb.intervalMin % 1440 === 0
      ? `每 ${hb.intervalMin / 1440} 天`
      : hb.intervalMin % 60 === 0
        ? `每 ${hb.intervalMin / 60} 小时`
        : `每 ${hb.intervalMin} 分钟`
    : '一次性';
  return `首次 ${fmtStamp(hb.firstAt)} · ${interval} · ${times}`;
};

/** MCP 工具入口：建任务 + 推确认卡（用户确认前不启动） */
export async function createHeartbeatWithConfirm(args: {
  creator: Person;
  requirement: string;
  firstAtMs: number;
  intervalMin: number;
  totalRuns: number;
  chatId?: string | null;
}): Promise<Heartbeat> {
  const firstAt = new Date(args.firstAtMs).toISOString();
  const { randomUUID } = await import('node:crypto');
  const hbId = `hb-${randomUUID().slice(0, 8)}`;
  const hb = heartbeats.create({
    id: hbId,
    creatorId: args.creator.id,
    requirement: args.requirement,
    firstAt,
    intervalMin: args.intervalMin,
    totalRuns: args.totalRuns,
    chatId: args.chatId ?? null,
    workspaceDir: `${config.workspacesRel}/_heartbeat/${hbId}`,
  });
  heartbeatSandbox(hb.id);
  bus.changed('task');
  bus.activity('task', `心跳任务待确认：${args.requirement.slice(0, 50)}`, `${args.creator.name} · ${fmtPlan(hb)}`);

  const to = dmTargetOf(args.creator);
  if (to) {
    const card = {
      config: { wide_screen_mode: true },
      header: { template: 'purple', title: { tag: 'plain_text', content: '💓 心跳任务待你确认' } },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: `**任务需求**\n${args.requirement.slice(0, 400)}` } },
        { tag: 'div', text: { tag: 'lark_md', content: `**触发计划**：${fmtPlan(hb)}` } },
        { tag: 'note', elements: [{ tag: 'plain_text', content: '确认后才会开始执行；之后可在管理后台「心跳任务」页改时间/频率/需求或暂停' }] },
        {
          tag: 'action',
          actions: [
            { tag: 'button', text: { tag: 'plain_text', content: '✅ 启动' }, type: 'primary', value: { action: 'hb_confirm', heartbeat_id: hb.id } },
            { tag: 'button', text: { tag: 'plain_text', content: '取消任务' }, type: 'danger', value: { action: 'hb_cancel', heartbeat_id: hb.id } },
          ],
        },
      ],
    };
    const sent = await adapter().sendCard(to, card, `hbconfirm-${hb.id}`).catch(() => null);
    if (sent) pendingCards.save(sent.msgId, 'heartbeat', { heartbeatId: hb.id });
  } else {
    bus.activity('system', `${args.creator.name} 是虚拟成员，心跳确认卡无法私信`, '可在后台「心跳任务」页手动确认');
  }
  return heartbeats.byId(hb.id)!;
}

/** 确认启动（卡片按钮 / 后台按钮共用）。firstAt 已过时立即补跑一次 */
export function activateHeartbeat(id: string): Heartbeat | null {
  const hb = heartbeats.byId(id);
  if (!hb || hb.status !== 'pending_confirm') return hb;
  const next = new Date(Math.max(new Date(hb.firstAt).getTime(), Date.now())).toISOString();
  heartbeats.update(id, { status: 'active', nextRunAt: next });
  bus.changed('task');
  bus.activity('task', `心跳任务已启动：${hb.requirement.slice(0, 50)}`, `下次触发 ${fmtStamp(next)}`);
  return heartbeats.byId(id);
}

/** 卡片回调：hb_confirm / hb_cancel（只有创建人能点） */
export async function handleHeartbeatCardAction(action: CardAction): Promise<boolean> {
  const id = action.value.heartbeat_id;
  if (!id) return false;
  const hb = heartbeats.byId(id);
  if (!hb) return false;
  const operator = persons.byOpenId(action.operatorOpenId) ?? persons.byId(action.operatorOpenId);
  const creator = persons.byId(hb.creatorId);
  if (operator?.id !== hb.creatorId) {
    const { cardFeedback } = await import('../lark/feedback.js');
    await cardFeedback(action, `这张确认卡只有 ${creator?.name ?? '创建人'} 本人能操作`);
    return true;
  }
  const { cardFeedback } = await import('../lark/feedback.js');
  if (action.actionId === 'hb_confirm') {
    if (hb.status !== 'pending_confirm') {
      await cardFeedback(action, `这个心跳任务当前状态是 ${hb.status}，确认卡已失效`);
      return true;
    }
    const updated = activateHeartbeat(id)!;
    await cardFeedback(action, `✅ 心跳任务已启动，${fmtPlan(updated)}。下次触发：${fmtStamp(updated.nextRunAt)}`);
    return true;
  }
  if (action.actionId === 'hb_cancel') {
    heartbeats.update(id, { status: 'cancelled', nextRunAt: null });
    bus.changed('task');
    await cardFeedback(action, '已取消这个心跳任务');
    bus.activity('task', `心跳任务已取消：${hb.requirement.slice(0, 50)}`, `by ${creator?.name}`);
    return true;
  }
  return false;
}

// ===== 调度与执行 =====

const inflight = new Set<string>();

export function startHeartbeatScheduler(): void {
  setInterval(() => {
    sweepHeartbeats().catch((e) => bus.activity('system', '心跳调度异常', String(e).slice(0, 150)));
  }, 20_000).unref();
}

/** 扫描到点任务并触发（导出供 smoke 直接调用） */
export async function sweepHeartbeats(): Promise<number> {
  const due = heartbeats.due(new Date().toISOString()).filter((hb) => !inflight.has(hb.id));
  for (const hb of due) {
    inflight.add(hb.id);
    runHeartbeat(hb)
      .catch((e) => bus.activity('system', `心跳执行异常：${hb.id}`, String(e).slice(0, 200)))
      .finally(() => inflight.delete(hb.id));
  }
  return due.length;
}

/** 网格推进：从 firstAt 起按 interval 找下一个未来时刻（错过的周期不补跑，防止停机后连环轰炸） */
function nextOnGrid(firstAtMs: number, intervalMin: number, afterMs: number): number {
  const step = intervalMin * 60_000;
  if (step <= 0) return NaN;
  const k = Math.max(1, Math.ceil((afterMs - firstAtMs) / step + 0.000001));
  return firstAtMs + k * step;
}

async function runHeartbeat(hb: Heartbeat): Promise<void> {
  const creator = persons.byId(hb.creatorId);
  const dir = heartbeatSandbox(hb.id);
  const runNo = hb.runsDone + 1;

  await withAgentSlot(async () => {
    const session = createAgentSession({
      mode: 'heartbeat',
      personId: hb.creatorId,
      heartbeatId: hb.id,
      chatId: hb.chatId,
      dmOpenId: dmTargetOf(creator)?.openId ?? null,
      workspaceDir: dir,
      label: `心跳 · ${hb.requirement.slice(0, 30)}`,
      ttlMs: (config.agentChatTimeoutSec + 600) * 1000,
    });
    agentRuns.start({
      id: session.id, mode: 'heartbeat',
      personId: hb.creatorId, personName: creator?.name ?? hb.creatorId,
      heartbeatId: hb.id,
      label: `心跳第 ${runNo} 次 · ${hb.requirement.slice(0, 40)}`,
      request: hb.requirement,
      workspaceDir: `${config.workspacesRel}/_heartbeat/${hb.id}`,
    });
    bus.changed('run');
    bus.activity('run', `心跳任务触发（第 ${runNo} 次）`, hb.requirement.slice(0, 60));

    const notesAbs = path.join(dir, 'notes');
    const briefAbs = path.join(dir, 'brief.md');
    fs.writeFileSync(briefAbs, [
      `# 心跳任务（第 ${runNo} 次触发）`,
      '',
      `当前时间：${nowStamp()}。这是一个定时唤醒的例行任务，收件人是 ${creator?.name ?? '创建人'}（任务创建人）。`,
      '',
      '## 任务需求（创建人的原始要求）',
      '',
      '"""',
      hb.requirement,
      '"""',
      '',
      '## 上次执行情况',
      '',
      hb.lastRunAt ? `- 上次触发：${fmtStamp(hb.lastRunAt)}\n- 上次结果摘要：${hb.lastSummary ?? '（无）'}` : '- 这是首次触发',
      '',
      // 跨端协同 §八：心跳 Agent 启动时同样自动获得最近 5 条工作总结
      recentSummariesBlock(5),
      '',
      '## 可用工具（feishu MCP）',
      '',
      '- `feishu_search_messages` / `feishu_recent_messages`：检索团队历史消息（结果带时间戳，注意区分新旧信息）',
      '- `feishu_get_wiki`：把群知识库（系统每日维护的群况/决策/口径文档）拉进工作区参考',
      '- `feishu_list_members` / `feishu_check_busy` / `feishu_create_calendar_event`',
      '- `feishu_reply`：把本次产出私信给创建人（text，或 .md/.html/图片附件）；`feishu_send_card`：结构化卡片',
      '',
      '## 要求',
      '',
      `- 围绕任务需求产出**本次时点**的内容（现在是 ${nowStamp()}，基于最新信息，不要把旧消息当成新情况）`,
      `- 过程文件写到 ${notesAbs}/（跨触发保留，可以读自己上次留下的笔记）`,
      '- 最终必须调用 feishu_reply 交付——不调用它创建人什么都收不到；即使没有新信息，也要简短告知「本次无更新」',
      '- 交付一次即可，别刷屏；交付完成后直接结束',
    ].join('\n'));

    const startedDeliveries = session.deliveries.length;
    try {
      const result = await spawnOpenCode({
        cwd: dir,
        prompt: [
          `直接读文件 ${briefAbs}（不用先浏览目录），按其要求完成这次心跳任务并通过 feishu MCP 工具交付。`,
          `过程文件放 ${notesAbs}/ 里。交付出口只有 feishu_reply / feishu_send_card。`,
        ].join('\n'),
        timeoutSec: config.agentChatTimeoutSec,
        extraEnv: {
          EVERYONE_MCP_URL: `http://127.0.0.1:${config.serverPort}/mcp`,
          EVERYONE_AGENT_TOKEN: session.token,
        },
        traceId: session.id,
      });
      // 零交付抢救：模型把结果当聊天输出 → 代发给创建人
      if (session.deliveries.length === startedDeliveries && result.finalText) {
        const to = dmTargetOf(creator);
        if (to) await adapter().sendText(to, result.finalText.slice(0, 3800), `hbsalvage-${session.id}`).catch(() => {});
        bus.activity('run', '心跳产出未走 MCP，已抢救代发', result.finalText.slice(0, 80));
      }
      const summary = session.deliveries.map((d) => d.title || d.content?.slice(0, 60) || d.kind).join('；')
        || result.finalText.slice(0, 100) || '（无产出）';
      agentRuns.finish(session.id, 'succeeded', { deliveries: session.deliveries.length, deliverySummary: summary });
      finishSchedule(hb, summary);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      const salvage = ((e as { finalText?: string })?.finalText ?? '').trim();
      agentRuns.finish(session.id, msg.includes('超时') ? 'timeout' : 'failed', {
        deliveries: session.deliveries.length + (salvage ? 1 : 0), error: msg,
      });
      finishSchedule(hb, salvage ? `（中断抢救）${salvage.slice(0, 100)}` : `执行失败：${msg.slice(0, 100)}`);
      const to = dmTargetOf(creator);
      if (to && session.deliveries.length === startedDeliveries) {
        const text = salvage
          ? `💓（这次做到一半被中断，先给你已有的部分）\n${salvage.slice(0, 3600)}`
          : `💓 心跳任务这次没跑成（${msg.slice(0, 100)}），下个周期会再试。`;
        await adapter().sendText(to, text, `hbfail-${session.id}`).catch(() => {});
      }
      bus.activity('system', `心跳任务执行失败：${hb.id}`, msg.slice(0, 200));
    } finally {
      closeAgentSession(session);
      bus.changed('run');
    }
  });
}

/** 触发后推进计划：次数用尽 → done；否则按网格排下一次 */
function finishSchedule(hb: Heartbeat, summary: string): void {
  const runsDone = hb.runsDone + 1;
  const exhausted = hb.totalRuns > 0 && runsDone >= hb.totalRuns;
  const nextMs = exhausted || hb.intervalMin <= 0
    ? null
    : nextOnGrid(new Date(hb.firstAt).getTime(), hb.intervalMin, Date.now());
  heartbeats.update(hb.id, {
    runsDone,
    lastRunAt: new Date().toISOString(),
    lastSummary: summary.slice(0, 300),
    nextRunAt: nextMs && Number.isFinite(nextMs) ? new Date(nextMs).toISOString() : null,
    status: exhausted || (hb.intervalMin <= 0 && hb.totalRuns !== 0) ? 'done' : 'active',
  });
  bus.changed('task');
}

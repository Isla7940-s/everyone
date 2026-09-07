import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, Person } from '@everyone/shared';
import { bus } from '../bus.js';
import { config } from '../config.js';
import { adapter } from '../context.js';
import { recentSummariesBlock } from '../collab/service.js';
import { spawnOpenCode } from '../executor/opencode.js';
import { plantAgentSkills } from '../executor/workspace.js';
import * as memory from '../memory/index.js';
import { prompt } from '../prompts.js';
import { agentRuns, chatLog, persons } from '../store/repo.js';
import { fmtStamp, timeVars } from '../time.js';
import { closeAgentSession, createAgentSession } from './session.js';

export { plantAgentSkills };

/**
 * Agent 对话模式（新需求 2）：
 * 没命中任何人的「帮我干」，但请求需要动手（做页面/整数据/写工具/长文汇总）→
 * 在按天隔离的共享沙箱里跑 OpenCode，通过 feishu MCP 直接把结果回进会话。
 */

const CONCURRENCY = 2;
let active = 0;
const waiters: Array<() => void> = [];

/** Agent 执行并发闸（对话模式与心跳任务共用，防止同时起一堆 OpenCode） */
export async function withAgentSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= CONCURRENCY) await new Promise<void>((r) => waiters.push(r));
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
    waiters.shift()?.();
  }
}

export const agentSlotBusy = () => active >= CONCURRENCY;

/** 按天隔离的 Agent 沙箱（新需求 2f）：workspaces/_agent/<YYYY-MM-DD>/ */
export function ensureAgentSandbox(): { dir: string; dateKey: string } {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const dateKey = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const dir = path.join(config.workspacesDir, '_agent', dateKey);
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  plantAgentSkills(dir);
  return { dir, dateKey };
}

/** Agent 对话模式主入口：表情回应 ack → 沙箱任务书 → OpenCode+MCP → 零交付抢救 → 兜底 */
export async function runChatAgent(msg: IncomingMessage, sender: Person | null, senderName: string): Promise<void> {
  const queued = active >= CONCURRENCY;
  // ack 不再发「收到…」消息（发起人 2026-08-29 需求①）：给原消息附加飞书原生表情回应——
  // 正常接单回 Get，前面排着活回 OneSecond；做完的交付本身就是答复
  await adapter().addReaction(msg.msgId, queued ? 'OneSecond' : 'Get').catch((e) => {
    bus.activity('system', '表情回应失败（不影响执行）', String(e).slice(0, 120));
  });

  await withAgentSlot(async () => {
    const { dir, dateKey } = ensureAgentSandbox();
    const session = createAgentSession({
      mode: 'chat',
      chatId: msg.chatId,
      replyToMsgId: msg.msgId,
      personId: sender?.id ?? null,
      workspaceDir: dir,
      label: `Agent 模式 · ${senderName}`,
      ttlMs: (config.agentChatTimeoutSec + 600) * 1000,
    });
    const sessionRel = `sessions/${session.id}`;
    const notesRel = `${sessionRel}/notes`;
    const notesAbs = path.join(dir, notesRel);
    fs.mkdirSync(notesAbs, { recursive: true });

    // 任务书。上下文与记忆全部带时间戳（需求 1：避免过时信息被当成新情况）
    const recent = chatLog.recent(msg.chatId, 15)
      .map((r) => `- [${fmtStamp(r.ts)}] ${r.senderName ?? '成员'}：${(r.text ?? '').slice(0, 160)}`)
      .join('\n') || '（暂无）';
    const hits = sender ? await memory.recall(sender.id, msg.text, 4).catch(() => []) : [];
    const members = persons.all()
      .map((p) => `- id=${p.id} 姓名=${p.name}（${p.feishuOpenId ? '真实飞书账号' : '虚拟成员'}）`)
      .join('\n');
    const brief = prompt('agent_chat_brief', {
      ...timeVars(),
      sender_name: senderName,
      where: msg.chatKind === 'p2p' ? '私聊' : '群里',
      request: msg.text,
      context: recent,
      recall: hits.map(memory.recallLine).join('\n') || '（无）',
      // 跨端协同 §八：云端 Agent 启动时自动获得最近 5 条工作总结
      work_summaries: recentSummariesBlock(5),
      members,
      notes_dir: notesAbs, // 绝对路径：OpenCode 文件工具按项目根解析相对路径，不能给相对沙箱的路径
      skills_dir: dir,
      time_budget: String(Math.max(1, Math.round(config.agentChatTimeoutSec / 60))),
    });
    const briefRel = `${sessionRel}/brief.md`;
    const briefAbs = path.join(dir, briefRel);
    fs.writeFileSync(briefAbs, brief);

    // 运行登记（需求 2/3：前端「Agent 运行中」与轨迹页的数据源）
    agentRuns.start({
      id: session.id, mode: 'chat',
      personId: sender?.id ?? null, personName: senderName,
      label: `Agent 模式 · ${senderName}`,
      request: msg.text,
      workspaceDir: `${config.workspacesRel}/_agent/${dateKey}/${sessionRel}`,
    });
    bus.changed('run');
    bus.activity('run', `Agent 模式开工（${senderName}）`, `沙箱 ${config.workspacesRel}/_agent/${dateKey}/${sessionRel}`);

    const startedDeliveries = session.deliveries.length;
    try {
      const result = await spawnOpenCode({
        cwd: dir,
        prompt: [
          `直接读文件 ${briefAbs}（不用先浏览目录），按其要求完成请求并通过 feishu MCP 工具交付。`,
          `过程文件放 ${notesAbs}/ 里。交付出口只有 feishu_reply / feishu_send_card——不调用它们用户收不到任何东西。`,
        ].join('\n'),
        timeoutSec: config.agentChatTimeoutSec,
        extraEnv: {
          EVERYONE_MCP_URL: `http://127.0.0.1:${config.serverPort}/mcp`,
          EVERYONE_AGENT_TOKEN: session.token,
        },
        traceId: session.id,
      });
      if (session.deliveries.length === startedDeliveries) {
        // 零交付抢救（需求 4 卡点二实锤）：模型把结论当聊天输出、忘了走 MCP —— 把最终文本代发给用户
        if (result.finalText.trim()) {
          await adapter().replyText(msg.msgId, result.finalText.trim().slice(0, 3800), `agentsalvage-${msg.msgId}`).catch(() => {});
          agentRuns.finish(session.id, 'succeeded', {
            deliveries: 1, deliverySummary: `（抢救代发）${result.finalText.slice(0, 100)}`,
          });
          bus.activity('run', 'Agent 产出未走 MCP，已抢救代发', result.finalText.slice(0, 80));
        } else {
          // 真·零产出——用户不能被晾着
          await adapter().replyText(
            msg.msgId,
            '刚才折腾了一圈没能把结果交出来（执行完成但没产出内容）。你可以再说一次，我重新做。',
            `agentmiss-${msg.msgId}`,
          ).catch(() => {});
          agentRuns.finish(session.id, 'failed', { deliveries: 0, error: '执行完成但零交付、零文本' });
          bus.activity('system', 'Agent 模式执行完成但零交付', `${senderName} · ${msg.text.slice(0, 60)}`);
        }
      } else {
        const summary = session.deliveries.map((d) => d.title || d.kind).join('、');
        agentRuns.finish(session.id, 'succeeded', { deliveries: session.deliveries.length, deliverySummary: summary });
        bus.activity('run', `Agent 模式完成（${session.deliveries.length} 次交付）`, summary);
      }
    } catch (e) {
      const msgText = String((e as Error)?.message ?? e);
      const salvage = ((e as { finalText?: string })?.finalText ?? '').trim();
      if (session.deliveries.length === startedDeliveries) {
        if (salvage) {
          // 非零退出（超时/被杀）但已有可用结论/进展 → 照样交出去，标明是中断前的进展
          const prefix = msgText.includes('超时') ? '（做到一半超时了，先把已确认的部分给你）\n' : '';
          await adapter().replyText(msg.msgId, (prefix + salvage).slice(0, 3800), `agentsalvage-${msg.msgId}`).catch(() => {});
          bus.activity('run', 'Agent 执行中断，已抢救部分结论代发', salvage.slice(0, 80));
        } else {
          await adapter().replyText(
            msg.msgId,
            `这个没做成：${msgText.slice(0, 120)}。稍后可以再试一次。`,
            `agentfail-${msg.msgId}`,
          ).catch(() => {});
        }
      }
      agentRuns.finish(session.id, msgText.includes('超时') ? 'timeout' : 'failed', {
        deliveries: session.deliveries.length + (salvage ? 1 : 0), error: msgText,
      });
      bus.activity('system', 'Agent 模式执行失败', msgText.slice(0, 200));
    } finally {
      closeAgentSession(session);
      bus.changed('run');
    }
  });
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkSession } from '@everyone/shared';
import { z } from 'zod';
import { doCollabNotice } from '../agent/tools.js';
import type { AgentSession } from '../agent/session.js';
import { bus } from '../bus.js';
import { config } from '../config.js';
import { persons, tasks } from '../store/repo.js';
import { waitForHelp } from './service.js';
import { SESSION_ID_RE, helpRequests, workSessions, type HelpRow } from './store.js';

/**
 * 跨端协同 MCP（跨端协同.md §八/§九）：云端沙箱 Agent 只装 MCP、不装 CLI，
 * 通过这里查询工作总结、发起阻塞式远程求助。
 * OpenCode 侧 MCP 服务名为 feishu，工具展现为 feishu_collab_*。
 */

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

class CollabToolError extends Error {}

async function run(session: AgentSession, tool: string, fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: await fn() }] };
  } catch (e) {
    const msg = e instanceof CollabToolError ? e.message : `工具执行失败：${String((e as Error)?.message ?? e).slice(0, 400)}`;
    bus.activity('system', `MCP 工具报错回传 Agent（${tool}）`, `${session.label} · ${msg.slice(0, 150)}`);
    return { isError: true, content: [{ type: 'text', text: `❌ ${msg}` }] };
  }
}

function fmtSession(s: WorkSession, detail = false): string {
  const who = persons.byId(s.personId)?.name ?? s.personId;
  const at = s.sessionAt.slice(0, 16).replace('T', ' ');
  const head = `[${s.id}] ${at} ${who} · ${s.requirement} / ${s.subtask}（${s.sourceTool}）`;
  const lines = [head, `  短总结：${s.briefSummary}`];
  if (detail) lines.push(`  详细总结：${s.detailSummary}`);
  if (s.taskId) {
    const t = tasks.byId(s.taskId);
    lines.push(t
      ? `  关联任务：${t.id}「${t.title}」（状态 ${t.status}${t.dueAt ? `，截止 ${t.dueAt.slice(0, 10)}` : ''}）`
      : `  关联任务：${s.taskId}`);
  }
  return lines.join('\n');
}

function requireSession(sessionId: string): WorkSession {
  const id = (sessionId ?? '').trim();
  if (!SESSION_ID_RE.test(id)) {
    throw new CollabToolError('session_id 必须是 16 位字母数字的工作会话 ID（从工作总结列表里取）');
  }
  const s = workSessions.byId(id);
  if (!s) throw new CollabToolError(`工作会话 ${id.toUpperCase()} 不存在。先用 collab_list_work_summaries / collab_search_work_summaries 找到正确的会话 ID`);
  return s;
}

/** 求助终态 → MCP 返回文本（附件路径指向发起方沙箱内 help/<id>/） */
function helpResultText(h: HelpRow, workspaceDir: string): string {
  if (h.status === 'failed') {
    throw new CollabToolError([
      `远程求助 ${h.id} 执行失败：${h.error ?? '本地未提供原因'}。`,
      `可把问题拆小后用 collab_request_remote_help 重新发起，或基于已有总结自行推进。`,
    ].join('\n'));
  }
  const who = persons.byId(h.personId)?.name ?? h.personId;
  const lines = [
    `远程求助已完成（${h.id}，由 ${who} 的本地 Agent 处理）。`,
    '',
    '=== 本地 Agent 的回复 ===',
    h.replyText ?? '（空）',
  ];
  if (h.replyNote) lines.push('', `完成说明：${h.replyNote}`);
  if (h.attachments.length) {
    lines.push('', '附件（已同步进你的工作目录，直接用文件工具读取）：');
    for (const a of h.attachments) {
      lines.push(`- ${workspaceDir}/help/${h.id}/${a.name}（${(a.size / 1024).toFixed(1)}KB）`);
    }
  }
  return lines.join('\n');
}

/** 等待中的统一提示：告诉 Agent 用哪个工具接着等 */
function timeoutError(helpId: string, waitedSec: number): never {
  throw new CollabToolError([
    `等待了 ${waitedSec}s，远程求助 ${helpId} 还没返回（本地可能仍在执行）。`,
    `这是超时错误而不是失败——用 collab_wait_help_result（help_id="${helpId}"）继续等待同一个求助，`,
    `或用 collab_get_help_result 非阻塞查看当前状态。不要重复发起新求助。`,
  ].join('\n'));
}

/** 只读总结查询（全模式可用，wiki 维护模式也允许） */
export function registerCollabReadTools(server: McpServer, session: AgentSession): void {
  server.registerTool(
    'collab_list_work_summaries',
    {
      title: '查询团队本地工作总结（近期列表）',
      description: [
        '列出团队成员在 Codex / Cursor / Claude Code 等本地 AI 工具里的工作会话总结（新→旧）。',
        '每条含：16 位会话 ID、时间、成员、大需求/子任务、来源工具、25 字短总结。',
        '完整聊天原文保留在成员本地，云端只有总结——要更多细节用 collab_get_work_session_detail，仍不够就发远程求助。',
      ].join('\n'),
      inputSchema: {
        limit: z.number().optional().describe('条数，默认 10，最大 50'),
        days: z.number().optional().describe('只看最近 N 天（可选）'),
        person: z.string().optional().describe('按成员过滤（person id 或姓名，可选）'),
      },
    },
    async (args) => run(session, 'collab_list_work_summaries', async () => {
      const a = args as { limit?: number; days?: number; person?: string };
      let personId: string | null = null;
      if (a.person?.trim()) {
        const p = persons.byId(a.person.trim()) ?? persons.byName(a.person.trim());
        if (!p) throw new CollabToolError(`成员「${a.person}」不存在（用 list_members 查名册）`);
        personId = p.id;
      }
      const rows = workSessions.recent({ personId, limit: Math.min(a.limit ?? 10, 50), days: a.days });
      if (!rows.length) return '没有符合条件的工作总结。';
      return [`共 ${rows.length} 条（新→旧）：`, ...rows.map((s) => fmtSession(s))].join('\n');
    }),
  );

  server.registerTool(
    'collab_search_work_summaries',
    {
      title: '按关键词搜索工作总结',
      description: '在全部工作会话总结里按关键词检索（空格分隔多个关键词 = AND；命中总结/大需求/子任务任一字段）。',
      inputSchema: {
        query: z.string().describe('关键词，如 "支付 回调"'),
        limit: z.number().optional().describe('条数，默认 10，最大 30'),
      },
    },
    async (args) => run(session, 'collab_search_work_summaries', async () => {
      const a = args as { query: string; limit?: number };
      const keywords = (a.query ?? '').trim().split(/\s+/).filter(Boolean);
      if (!keywords.length) throw new CollabToolError('query 不能为空');
      const rows = workSessions.search(keywords, { limit: Math.min(a.limit ?? 10, 30) });
      if (!rows.length) return `没有命中「${keywords.join(' + ')}」的总结。减关键词或换说法再试。`;
      return [`命中 ${rows.length} 条：`, ...rows.map((s) => fmtSession(s))].join('\n');
    }),
  );

  server.registerTool(
    'collab_get_work_session_detail',
    {
      title: '获取工作会话的详细总结',
      description: '按 16 位会话 ID 获取 100 字详细总结与关联任务信息。会话原文在成员本地，云端拿不到原文——需要原文级上下文时发远程求助。',
      inputSchema: { session_id: z.string().describe('16 位工作会话 ID') },
    },
    async (args) => run(session, 'collab_get_work_session_detail', async () => {
      const s = requireSession((args as { session_id: string }).session_id);
      const related = workSessions.related(s, 5);
      const lines = [fmtSession(s, true)];
      if (related.length) {
        lines.push('', `同需求相关会话（${related.length} 条，可用 collab_get_related_work_sessions 展开）：`);
        for (const r of related.slice(0, 3)) lines.push(`- [${r.id}] ${r.subtask}：${r.briefSummary}`);
      }
      return lines.join('\n');
    }),
  );

  server.registerTool(
    'collab_list_tasks',
    {
      title: '查询成员任务和排期',
      description: '列出某成员（或全员）的任务台账与排期：状态、截止时间、关联工作会话。判断某件事有没有人接、进展如何时用。',
      inputSchema: {
        person: z.string().optional().describe('成员 person id 或姓名（不传 = 全员）'),
        include_done: z.boolean().optional().describe('是否包含已完成/已取消，默认否'),
      },
    },
    async (args) => run(session, 'collab_list_tasks', async () => {
      const a = args as { person?: string; include_done?: boolean };
      let ownerId: string | undefined;
      if (a.person?.trim()) {
        const p = persons.byId(a.person.trim()) ?? persons.byName(a.person.trim());
        if (!p) throw new CollabToolError(`成员「${a.person}」不存在（用 list_members 查名册）`);
        ownerId = p.id;
      }
      const list = tasks.all(ownerId ? { ownerId } : undefined)
        .filter((t) => a.include_done || !['published', 'cancelled'].includes(t.status))
        .sort((x, y) => ((x.dueAt ?? '9999') < (y.dueAt ?? '9999') ? -1 : 1))
        .slice(0, 40);
      if (!list.length) return '没有符合条件的任务。';
      const lines = list.map((t) => {
        const owner = persons.byId(t.ownerId)?.name ?? t.ownerId;
        const linked = workSessions.ofTask(t.id);
        return `- [${t.id}] ${t.title}（${owner} · ${t.status}${t.dueAt ? ` · 截止 ${t.dueAt.slice(0, 10)}` : ' · 无截止'}）`
          + (linked.length ? `\n    关联会话：${linked.map((s) => s.id).join('、')}` : '');
      });
      return [`共 ${list.length} 项（按截止时间）：`, ...lines].join('\n');
    }),
  );

  server.registerTool(
    'collab_get_related_work_sessions',
    {
      title: '获取相关工作会话',
      description: '列出与指定会话同属一个大需求的其他会话（同子任务优先）。用于把一件事的全部工作脉络串起来。',
      inputSchema: {
        session_id: z.string().describe('16 位工作会话 ID'),
        limit: z.number().optional().describe('条数，默认 10，最大 30'),
      },
    },
    async (args) => run(session, 'collab_get_related_work_sessions', async () => {
      const a = args as { session_id: string; limit?: number };
      const s = requireSession(a.session_id);
      const rows = workSessions.related(s, Math.min(a.limit ?? 10, 30));
      if (!rows.length) return `会话 ${s.id} 所属需求「${s.requirement}」暂无其他相关会话。`;
      return [`需求「${s.requirement}」的相关会话（${rows.length} 条）：`, ...rows.map((r) => fmtSession(r))].join('\n');
    }),
  );
}

/** 远程求助（§九 阻塞机制）：wiki 维护模式不注册（无用户可通知） */
export function registerCollabHelpTools(server: McpServer, session: AgentSession): void {
  server.registerTool(
    'collab_request_remote_help',
    {
      title: '发起远程求助（阻塞等待本地 Agent 完成）',
      description: [
        '当某件工作曾由某个本地 AI 会话完成、而你缺少完整上下文时，向该会话归属人的本地 Agent 发起求助。',
        '调用会**一直阻塞**：云端创建求助 → 用户本地客户端还原原始会话、建沙箱、启动本地 Codex → 完成后本工具直接返回回复与附件。',
        '超时报错 ≠ 失败：按提示用 collab_wait_help_result 继续等待，不要重复发起。',
        '发起时系统会自动在飞书里告知用户「正在使用远程求助」。',
      ].join('\n'),
      inputSchema: {
        session_id: z.string().describe('目标工作会话 ID（16 位，从工作总结里取）'),
        question: z.string().describe('求助问题：想从这段本地会话里得到什么'),
        background: z.string().optional().describe('当前任务背景（你在做什么、为什么需要）'),
        expectation: z.string().optional().describe('希望对方本地 Agent 完成的内容（回答问题/补文件/改代码…）'),
        context_info: z.string().optional().describe('当前云端沙箱中的必要信息（相关文件内容、已知结论等，帮对方少走弯路）'),
        timeout_sec: z.number().optional().describe(`本次等待秒数，默认 ${config.collabHelpTimeoutSec}，最大 3600`),
      },
    },
    async (args) => run(session, 'collab_request_remote_help', async () => {
      const a = args as {
        session_id: string; question: string; background?: string;
        expectation?: string; context_info?: string; timeout_sec?: number;
      };
      const target = requireSession(a.session_id);
      const question = (a.question ?? '').trim();
      if (!question) throw new CollabToolError('question 不能为空：写清楚你想从这段本地会话里得到什么');
      const owner = persons.byId(target.personId);
      const help = helpRequests.create({
        sessionId: target.id,
        personId: target.personId,
        question: question.slice(0, 2000),
        background: a.background?.trim().slice(0, 2000) || null,
        expectation: a.expectation?.trim().slice(0, 2000) || null,
        contextInfo: a.context_info?.trim().slice(0, 4000) || null,
        requesterLabel: session.label,
        requesterPersonId: session.personId,
        requesterWorkspaceDir: session.workspaceDir,
      });
      bus.activity('run', `云端 Agent 发起远程求助`, `${session.label} → ${owner?.name ?? target.personId} · [${target.id}] ${question.slice(0, 60)}`);
      bus.changed('run');
      // §八：告知用户我们使用了求助能力（飞书里回复用户；通知失败不阻断求助）
      await doCollabNotice(session, [
        `🤝 为了拿到完整上下文，我发起了一次远程求助：请 ${owner?.name ?? '成员'} 本地的 AI Agent 协助处理`,
        `「${target.requirement} / ${target.subtask}」的历史会话（${target.id.slice(0, 6)}…）。`,
        `问题：${question.slice(0, 120)}。本地处理完成后我会继续。`,
      ].join(''));

      const timeoutSec = Math.min(Math.max(a.timeout_sec ?? config.collabHelpTimeoutSec, 30), 3600);
      const result = await waitForHelp(help.id, timeoutSec * 1000);
      if (result === 'timeout') timeoutError(help.id, timeoutSec);
      return helpResultText(result, session.workspaceDir);
    }),
  );

  server.registerTool(
    'collab_wait_help_result',
    {
      title: '继续等待已有的远程求助',
      description: [
        '不是普通查询——用于重新阻塞等待一个已经存在的求助请求（request_remote_help 超时/报错后接着等）。',
        '求助仍在执行时本工具持续阻塞；已完成则立即返回结果；已失败则报错并说明原因。',
      ].join('\n'),
      inputSchema: {
        help_id: z.string().describe('求助 ID（hr- 开头，来自 request_remote_help 的报错提示）'),
        timeout_sec: z.number().optional().describe(`本次等待秒数，默认 ${config.collabHelpTimeoutSec}，最大 3600`),
      },
    },
    async (args) => run(session, 'collab_wait_help_result', async () => {
      const a = args as { help_id: string; timeout_sec?: number };
      const h = helpRequests.byId((a.help_id ?? '').trim());
      if (!h) throw new CollabToolError(`求助 ${a.help_id} 不存在（ID 是 hr- 开头，来自发起时的提示）`);
      const timeoutSec = Math.min(Math.max(a.timeout_sec ?? config.collabHelpTimeoutSec, 30), 3600);
      const result = await waitForHelp(h.id, timeoutSec * 1000);
      if (result === 'timeout') timeoutError(h.id, timeoutSec);
      return helpResultText(result, session.workspaceDir);
    }),
  );

  server.registerTool(
    'collab_get_help_result',
    {
      title: '查看远程求助当前状态/结果（非阻塞）',
      description: '立即返回求助的当前状态；已完成时返回完整结果与失败信息。想继续挂起等待用 collab_wait_help_result。',
      inputSchema: { help_id: z.string().describe('求助 ID（hr- 开头）') },
    },
    async (args) => run(session, 'collab_get_help_result', async () => {
      const h = helpRequests.byId(((args as { help_id: string }).help_id ?? '').trim());
      if (!h) throw new CollabToolError('求助不存在（ID 是 hr- 开头）');
      if (h.status === 'succeeded') return helpResultText(h, session.workspaceDir);
      if (h.status === 'failed') {
        return `远程求助 ${h.id} 已失败：${h.error ?? '本地未提供原因'}。可重新发起（拆小问题），或基于已有总结自行推进。`;
      }
      const stage = h.status === 'pending' ? '等待用户本地客户端领取' : h.status === 'claimed' ? '本地客户端已领取，正在准备沙箱' : '本地 Codex 执行中';
      return `求助 ${h.id} 进行中（${stage}，创建于 ${h.createdAt.slice(0, 16).replace('T', ' ')}）。用 collab_wait_help_result 阻塞等待完成。`;
    }),
  );
}

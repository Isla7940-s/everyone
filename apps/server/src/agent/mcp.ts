import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Hono } from 'hono';
import { z } from 'zod';
import { bus } from '../bus.js';
import { registerCollabHelpTools, registerCollabReadTools } from '../collab/mcp-tools.js';
import { sessionByToken, type AgentSession } from './session.js';
import {
  AgentToolError, doCheckBusy, doCreateCalendarEvent, doCreateHeartbeat, doGetWiki, doListMembers,
  doRecentMessages, doReply, doSearchMessages, doSendCard, doUpdateWiki,
} from './tools.js';

/**
 * 内嵌 MCP 服务（新需求 1，D-N1）：
 * OpenCode 以 remote MCP 连到主服务 `/mcp`，`Authorization: Bearer <会话token>` 定位会话。
 * 无状态模式：每个请求独立 McpServer 实例，工具闭包携带该会话上下文。
 */

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

async function run(session: AgentSession, tool: string, fn: () => Promise<string>): Promise<ToolResult> {
  try {
    const text = await fn();
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    const msg = e instanceof AgentToolError ? e.message : `工具执行失败：${String((e as Error)?.message ?? e).slice(0, 400)}`;
    bus.activity('system', `MCP 工具报错回传 Agent（${tool}）`, `${session.label} · ${msg.slice(0, 150)}`);
    return { isError: true, content: [{ type: 'text', text: `❌ ${msg}` }] };
  }
}

function buildServer(session: AgentSession): McpServer {
  const server = new McpServer({ name: 'everyone-feishu', version: '1.0.0' });

  // wiki 维护模式（需求⑥）：禁用一切「回复用户」能力，唯一交付出口是 update_wiki
  if (session.mode === 'wiki') {
    server.registerTool(
      'update_wiki',
      {
        title: '发布群知识库（覆盖在线文档）',
        description: [
          '把你工作目录里写好的 wiki.md 全文覆盖发布到本群的在线知识库文档。',
          '文档由系统自动创建与托管，你不需要也无法知道链接。',
          '这是本次维护任务**唯一的交付出口**——不调用它，你做的维护不会生效。发布一次即可。',
        ].join('\n'),
        inputSchema: {},
      },
      async () => run(session, 'update_wiki', () => doUpdateWiki(session)),
    );
    registerSharedReadTools(server, session);
    registerCollabReadTools(server, session); // 总结查询只读，wiki 维护也可用
    return server;
  }

  const replyTarget = session.mode === 'task'
    ? '任务负责人的飞书私信（交付成果就发这里，负责人确认后系统才会发布进群）'
    : session.mode === 'heartbeat'
      ? '心跳任务创建人的飞书私信（例行播报就发这里）'
      : '当前会话（提问的群聊/私聊，用户就在这里等你）';

  server.registerTool(
    'reply',
    {
      title: '回复消息（文本 / 富媒体）',
      description: [
        `把回复发到：${replyTarget}。回复目标由系统会话决定，你不需要也无法指定。`,
        '两种用法：',
        '1. 纯文本：只传 text（≤3800 字；长内容不要塞正文，见下）',
        '2. 富媒体：text（可为空字符串）+ attachment_path（你工作目录内的文件路径，绝对/相对均可），仅支持三类：',
        '   - .md → 自动转成飞书云文档，链接随消息发出（长报告/成稿一律走这个）',
        '   - .png/.jpg/.jpeg/.gif/.webp → 直接发图片',
        '   - .html → 自动部署为网页（24h 有效），以链接卡片发出（数据可视化/小工具走这个；动手写之前必须先读工作目录根的 html-style.md，页面风格要跟 Everyone 产品一致）',
        '   其他类型会报错并说明原因，按提示转换后重新提交。',
        '每次调用发一条消息；不要把同一内容重复发送。',
      ].join('\n'),
      inputSchema: {
        text: z.string().describe('消息正文。带附件时可作为附件的说明（可传空字符串）'),
        attachment_path: z.string().optional().describe('附件路径（必须在你的工作目录内；建议直接用任务书里给的绝对路径）'),
        attachment_title: z.string().optional().describe('附件标题（云文档标题 / 页面卡片标题）；不传则从内容里提取'),
      },
    },
    async (args) => run(session, 'reply', () => doReply(session, args as never)),
  );

  server.registerTool(
    'send_card',
    {
      title: '回复飞书卡片',
      description: [
        `发一张飞书交互卡片到：${replyTarget}。`,
        '卡片有哪些可选、JSON 怎么写：先读工作目录根下的 feishu-cards.md（有 4 个可直接改的模板：信息卡/链接跳转卡/列表卡/进度卡）。',
        '注意：带按钮跳转链接的卡片也可以用 reply 的 .html 附件自动生成，不必手写。',
      ].join('\n'),
      inputSchema: {
        card: z.record(z.unknown()).describe('飞书卡片 JSON 对象（含 elements 数组；header 可选）'),
      },
    },
    async (args) => run(session, 'send_card', () => doSendCard(session, (args as { card: unknown }).card)),
  );

  server.registerTool(
    'create_calendar_event',
    {
      title: '创建飞书日程',
      description: '以 Everyone 名义创建飞书日程，可邀请团队成员参加（虚拟成员会被自动跳过并提示）。时间用 "YYYY-MM-DD HH:mm"（本地时区）。',
      inputSchema: {
        title: z.string().describe('日程标题'),
        start: z.string().describe('开始时间，如 "2026-08-29 14:00"'),
        end: z.string().describe('结束时间，必须晚于开始时间'),
        description: z.string().optional().describe('日程描述（可选）'),
        attendee_person_ids: z.array(z.string()).optional().describe('参与人 person id 列表（用 list_members 查）'),
      },
    },
    async (args) => run(session, 'create_calendar_event', () => doCreateCalendarEvent(session, args as never)),
  );

  server.registerTool(
    'check_busy',
    {
      title: '查询成员当前忙闲',
      description: '查某个成员现在是否在会议中/忙碌（基于飞书日历忙闲；拿不到会议标题）。替某人说话前、约时间前先查一下。',
      inputSchema: {
        person_id: z.string().describe('成员 person id 或姓名'),
      },
    },
    async (args) => run(session, 'check_busy', () => doCheckBusy(session, (args as { person_id: string }).person_id)),
  );

  server.registerTool(
    'get_wiki',
    {
      title: '获取群知识库',
      description: [
        '把本群的知识库（Markdown，系统每日自动维护：群定位/关键决策/进行中事项/常用口径/FAQ）放进你的工作区，返回文件路径。',
        '回答与群历史、口径、分工相关的问题，或做与群相关的工作前，建议先取一份按需查阅——比翻散落的聊天记录更准。',
      ].join('\n'),
      inputSchema: {},
    },
    async () => run(session, 'get_wiki', () => doGetWiki(session)),
  );

  server.registerTool(
    'create_heartbeat_task',
    {
      title: '创建心跳任务（定时唤醒的例行任务）',
      description: [
        '用户想要「每天/每周/定时推送、提醒、汇总」类的例行服务时用这个工具。',
        '创建后系统会给用户发确认卡，用户本人确认后才开始执行——你只需要创建并告知用户等确认。',
        '每次触发时会有一个 Agent 在独立沙箱按 requirement 干活（它能检索历史消息、发消息、建日程），产出私信给创建人。',
        'requirement 要写成给未来执行者的完整指令：做什么、查哪些信息、产出什么形式。',
      ].join('\n'),
      inputSchema: {
        requirement: z.string().describe('任务需求（给未来执行 Agent 的完整指令，会原样保存）'),
        first_trigger_at: z.string().describe('首次触发时间 "YYYY-MM-DD HH:mm"（本地时区，必须是未来）'),
        interval_minutes: z.number().optional().describe('重复间隔（分钟，≥5）；每天=1440，每周=10080。一次性任务不传'),
        total_runs: z.number().describe('总触发次数；0 = 无限次'),
      },
    },
    async (args) => run(session, 'create_heartbeat_task', () => doCreateHeartbeat(session, args as never)),
  );

  registerSharedReadTools(server, session);
  // 跨端协同（跨端协同.md §八/§九）：工作总结查询 + 阻塞式远程求助
  registerCollabReadTools(server, session);
  registerCollabHelpTools(server, session);
  return server;
}

/** 全模式共用的只读工具：成员名册 + 历史消息检索（wiki 维护模式也可用） */
function registerSharedReadTools(server: McpServer, session: AgentSession): void {
  server.registerTool(
    'list_members',
    {
      title: '团队成员名册',
      description: '列出团队全部成员（person id、姓名、是否真实飞书账号）。建日程、查忙闲之前先用它拿 id。',
      inputSchema: {},
    },
    async () => run(session, 'list_members', () => doListMembers()),
  );

  server.registerTool(
    'search_messages',
    {
      title: '检索飞书历史消息',
      description: [
        '在系统存档的全部飞书群/私聊历史消息里按关键词检索（需求：在海量历史上下文中找信息）。',
        '结果每条都带 [时间] 与发言人——注意分辨新旧，别把几周前的消息当成现在的情况。',
        '技巧：关键词用空格分隔是 AND 关系；没命中就减关键词/换说法/加大 days。',
      ].join('\n'),
      inputSchema: {
        query: z.string().describe('关键词，空格分隔多个（AND）。例："压测 结论"'),
        chat_id: z.string().optional().describe('限定某个会话 id（不传 = 全部会话）'),
        sender: z.string().optional().describe('限定发言人姓名（模糊匹配）'),
        days: z.number().optional().describe('时间窗口（天），默认 90，最大 365'),
        limit: z.number().optional().describe('返回条数，默认 20，最大 50'),
      },
    },
    async (args) => run(session, 'search_messages', () => doSearchMessages(session, args as never)),
  );

  server.registerTool(
    'recent_messages',
    {
      title: '翻看最近消息',
      description: '按时间顺序拉某个会话最近 N 条消息（默认当前会话）。适合看最新动态/接上下文，每条带时间戳。',
      inputSchema: {
        chat_id: z.string().optional().describe('会话 id；不传用当前会话'),
        limit: z.number().optional().describe('条数，默认 30，最大 100'),
      },
    },
    async (args) => run(session, 'recent_messages', () => doRecentMessages(session, args as never)),
  );
}

export function mountAgentMcp(app: Hono): void {
  app.all('/mcp', async (c) => {
    const auth = c.req.header('authorization') ?? '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    const session = sessionByToken(token);
    if (!session) {
      return c.json(
        { jsonrpc: '2.0', error: { code: -32001, message: 'Agent 会话 token 无效或已过期（会话随一次执行创建与销毁）' }, id: null },
        401,
      );
    }
    const server = buildServer(session);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true }); // 无状态：不生成 mcp-session-id
    await server.connect(transport);
    const res = await transport.handleRequest(c.req.raw);
    // JSON 响应模式下 body 已缓冲完毕；延迟收尾只为兜住实现细节变化
    setTimeout(() => { transport.close().catch(() => {}); server.close().catch(() => {}); }, 30_000);
    return res;
  });
}

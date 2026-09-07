import fs from 'node:fs';
import path from 'node:path';
import { bus } from '../bus.js';
import { config } from '../config.js';
import { adapter } from '../context.js';
import { createTaskDoc, overwriteTaskDoc } from '../executor/docstore.js';
import { createAgentCalendarEvent } from '../lark/calendar.js';
import { fmtBusyUntil, getBusyStatus } from '../lark/freebusy.js';
import { deployHtml } from '../pages/index.js';
import { chatLog, chats, heartbeats, persons } from '../store/repo.js';
import { fmtStamp, nowStamp, parseLocal } from '../time.js';
import { recordDelivery, type AgentSession } from './session.js';

/**
 * MCP 工具的服务端实现（新需求 1/2）。
 * 约定：任何失败都抛 AgentToolError，由 MCP 层原样带回给 Agent（isError），让它自己修正后重交。
 */
export class AgentToolError extends Error {}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_MD = 300 * 1024;
const MAX_HTML = 2 * 1024 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;

// ===== 回复目标路由（D-N2：目标由会话决定，不信模型自报）=====

function targetLabel(session: AgentSession): string {
  if (session.mode === 'task') return `${persons.byId(session.personId ?? '')?.name ?? '负责人'}的私信`;
  if (session.mode === 'heartbeat') return `${persons.byId(session.personId ?? '')?.name ?? '创建人'}的私信（心跳推送）`;
  if (session.mode === 'wiki') return '群知识库在线文档';
  return session.chatId?.includes('p2p') ? '私聊' : '群聊';
}

/** task 模式且 owner 是虚拟成员（无飞书账号）：消息不发但交付照记（产出在工作台全量可见） */
function virtualDrop(session: AgentSession, what: string): string {
  bus.activity('run', `${persons.byId(session.personId ?? '')?.name ?? '负责人'} 是虚拟成员，${what}落后台`, '工作台可查看');
  return '';
}

/** task 与 heartbeat 都私信本人；chat 回源消息所在会话 */
const dmMode = (session: AgentSession) => session.mode === 'task' || session.mode === 'heartbeat';

/** 发送署名（需求③）：task 模式是「某人的分身」在干活，其余模式是超级代理本体 */
async function speakAs<T>(session: AgentSession, fn: () => Promise<T>): Promise<T> {
  const { withSpeaker, avatarSpeaker, SUPER_AGENT_LABEL } = await import('../lark/speaker.js');
  const label = session.mode === 'task'
    ? avatarSpeaker(persons.byId(session.personId ?? '')?.name ?? '成员')
    : SUPER_AGENT_LABEL;
  return withSpeaker(label, fn);
}

async function sendTextTo(session: AgentSession, text: string, idem: string): Promise<string> {
  return speakAs(session, async () => {
    if (dmMode(session)) {
      if (!session.dmOpenId) return virtualDrop(session, '私信');
      return (await adapter().sendText({ openId: session.dmOpenId }, text, idem)).msgId;
    }
    if (session.replyToMsgId) return (await adapter().replyText(session.replyToMsgId, text, idem)).msgId;
    if (session.chatId) return (await adapter().sendText({ chatId: session.chatId }, text, idem)).msgId;
    throw new AgentToolError('会话没有可用的回复目标');
  });
}

async function sendImageTo(session: AgentSession, pngPath: string, idem: string): Promise<string> {
  return speakAs(session, async () => {
    if (dmMode(session)) {
      if (!session.dmOpenId) return virtualDrop(session, '图片');
      return (await adapter().sendImage({ openId: session.dmOpenId }, pngPath, idem)).msgId;
    }
    if (session.replyToMsgId) return (await adapter().replyImage(session.replyToMsgId, pngPath, idem)).msgId;
    if (session.chatId) return (await adapter().sendImage({ chatId: session.chatId }, pngPath, idem)).msgId;
    throw new AgentToolError('会话没有可用的回复目标');
  });
}

async function sendCardTo(session: AgentSession, card: unknown, idem: string): Promise<string> {
  return speakAs(session, async () => {
    if (dmMode(session)) {
      if (!session.dmOpenId) return virtualDrop(session, '卡片');
      return (await adapter().sendCard({ openId: session.dmOpenId }, card, idem)).msgId;
    }
    if (session.chatId) return (await adapter().sendCard({ chatId: session.chatId }, card, idem)).msgId;
    throw new AgentToolError('会话没有可用的回复目标');
  });
}

/**
 * 跨端协同（跨端协同.md §八）：发起远程求助时告知用户「我们使用了求助能力」。
 * 纯通知：不记 delivery（不影响零交付抢救判定），失败不阻断求助流程。
 */
export async function doCollabNotice(session: AgentSession, text: string): Promise<void> {
  try {
    await sendTextTo(session, text, `collab-notice-${session.id}-${Date.now()}`);
    bus.activity('send', `远程求助告知 → ${targetLabel(session)}`, text.slice(0, 80));
  } catch (e) {
    bus.activity('system', '远程求助告知发送失败（不影响求助本身）', String((e as Error)?.message ?? e).slice(0, 120));
  }
}

// ===== 附件解析 =====

function resolveAttachment(session: AgentSession, relOrAbs: string): { abs: string; ext: string; size: number } {
  const root = path.resolve(session.workspaceDir);
  const abs = path.resolve(root, relOrAbs);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new AgentToolError(`附件路径必须在你的工作目录内（${relOrAbs} 越界了）。用相对路径重新提交，例如 notes/report.md`);
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new AgentToolError(`附件文件不存在：${relOrAbs}。先把文件写到工作目录里，再用相对路径提交`);
  }
  if (st.isDirectory()) throw new AgentToolError(`附件不能是目录：${relOrAbs}`);
  return { abs, ext: path.extname(abs).toLowerCase(), size: st.size };
}

function docTitleOf(md: string, fallback: string): string {
  const m = /^#\s+(.+)$/m.exec(md);
  return (m?.[1]?.trim() ?? fallback).slice(0, 80);
}

/** 部署页链接卡片（HTML 附件的固定出口；卡片 skill 里也教了 Agent 自己写同款） */
export function pageLinkCard(title: string, url: string, note?: string): unknown {
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: title } },
    elements: [
      ...(note ? [{ tag: 'div', text: { tag: 'lark_md', content: note } }] : []),
      {
        tag: 'action',
        actions: [{ tag: 'button', text: { tag: 'plain_text', content: '打开页面' }, type: 'primary', url }],
      },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '链接 24 小时内有效，过期可让分身重新生成' }] },
    ],
  };
}

// ===== 工具实现 =====

export interface ReplyArgs {
  text: string;
  attachment_path?: string;
  attachment_title?: string;
}

export async function doReply(session: AgentSession, args: ReplyArgs): Promise<string> {
  const text = (args.text ?? '').trim();
  const attachment = (args.attachment_path ?? '').trim();
  if (!text && !attachment) throw new AgentToolError('text 与 attachment_path 至少要有一个');
  const idem = `agent-${session.id}-${session.deliveries.length}`;

  // 纯文本
  if (!attachment) {
    if (text.length > 3800) {
      throw new AgentToolError('文本超过 3800 字：长内容请写成 .md 文件用 attachment_path 提交（会转成飞书云文档），消息正文只放一两句摘要');
    }
    await sendTextTo(session, text, idem);
    recordDelivery(session, { kind: 'text', content: text });
    bus.activity('send', `Agent 回复文本 → ${targetLabel(session)}`, text.slice(0, 80));
    return `已回复到${targetLabel(session)}`;
  }

  const { abs, ext, size } = resolveAttachment(session, attachment);

  // Markdown → 飞书云文档（现有转档通道；任务迭代时 overwrite 同一篇）
  if (ext === '.md' || ext === '.markdown') {
    if (size > MAX_MD) throw new AgentToolError(`Markdown 附件过大（${Math.round(size / 1024)}KB > 300KB），请精简后重交`);
    const md = fs.readFileSync(abs, 'utf-8');
    if (!md.trim()) throw new AgentToolError('Markdown 附件是空文件');
    const title = (args.attachment_title ?? docTitleOf(md, session.label)).slice(0, 80);
    let url = session.docUrl;
    const docId = session.taskId ?? `agent-${session.id}`;
    if (session.docToken && url) {
      await overwriteTaskDoc(docId, session.docToken, md);
    } else {
      const doc = await createTaskDoc(docId, title, md);
      session.docToken = doc.token;
      session.docUrl = doc.url;
      url = doc.url;
    }
    const fullUrl = url!.startsWith('http') ? url! : `${config.publicBaseUrl}${url}`;
    await sendTextTo(session, text ? `${text}\n📄 ${title}：${fullUrl}` : `📄 ${title}：${fullUrl}`, idem);
    recordDelivery(session, { kind: 'doc', url: url!, title, content: md });
    bus.activity('send', `Agent 交付云文档 → ${targetLabel(session)}`, `${title} · ${url}`);
    return `Markdown 已转成飞书云文档并发出：${url}`;
  }

  // 图片
  if (IMAGE_EXTS.has(ext)) {
    if (size > MAX_IMAGE) throw new AgentToolError(`图片过大（${Math.round(size / 1024 / 1024)}MB > 8MB）`);
    // 拷进 out/（live 的 lark-cli --image 从项目根解析；mock 前端只静态服务 /out）
    const relOut = `out/agent/${session.id}-${session.deliveries.length}${ext}`;
    fs.mkdirSync(path.join(config.root, 'out/agent'), { recursive: true });
    fs.copyFileSync(abs, path.join(config.root, relOut));
    if (text) await sendTextTo(session, text, `${idem}-t`);
    await sendImageTo(session, relOut, idem);
    recordDelivery(session, { kind: 'image', url: `/${relOut}`, content: text });
    bus.activity('send', `Agent 回复图片 → ${targetLabel(session)}`, attachment);
    return `图片已发出${text ? '（附说明文本）' : ''}`;
  }

  // HTML → 自动部署 → 链接卡片（新需求 3）
  if (ext === '.html' || ext === '.htm') {
    if (size > MAX_HTML) throw new AgentToolError(`HTML 过大（${Math.round(size / 1024)}KB > 2MB）。部署系统只接单文件 HTML，请内联精简资源`);
    const html = fs.readFileSync(abs, 'utf-8');
    if (!html.trim()) throw new AgentToolError('HTML 附件是空文件');
    const page = deployHtml(html, { title: args.attachment_title });
    await sendCardTo(session, pageLinkCard(page.title, page.url, text || undefined), idem);
    recordDelivery(session, { kind: 'page', url: page.url, title: page.title, content: text });
    bus.activity('send', `Agent 交付部署页 → ${targetLabel(session)}`, `${page.title} · ${page.url}`);
    return `HTML 已自动部署并以卡片发出：${page.url}（24 小时有效）`;
  }

  throw new AgentToolError(
    `不支持的附件类型「${ext || '(无扩展名)'}」。只支持：.md（自动转飞书云文档）、图片（.png/.jpg/.jpeg/.gif/.webp）、.html（自动部署成 24h 链接卡片）。请把内容转成这三类之一后重新提交`,
  );
}

export async function doSendCard(session: AgentSession, cardInput: unknown): Promise<string> {
  let card = cardInput;
  if (typeof card === 'string') {
    try {
      card = JSON.parse(card);
    } catch {
      throw new AgentToolError('card 不是合法 JSON：请传卡片 JSON 对象（参考 skills/feishu-cards.md 里的模板）');
    }
  }
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    throw new AgentToolError('card 必须是卡片 JSON 对象（含 elements 数组），参考 skills/feishu-cards.md');
  }
  const c = card as Record<string, unknown>;
  if (!Array.isArray(c.elements) || c.elements.length === 0) {
    throw new AgentToolError('卡片缺少 elements 数组（至少一个元素）。参考 skills/feishu-cards.md 里的四个模板改');
  }
  const raw = JSON.stringify(card);
  if (raw.length > 28_000) throw new AgentToolError(`卡片 JSON 过大（${raw.length} 字符 > 28000），请精简内容`);
  if (!c.config) c.config = { wide_screen_mode: true };
  const idem = `agent-${session.id}-${session.deliveries.length}`;
  await sendCardTo(session, card, idem);
  const title = ((c.header as any)?.title?.content as string) ?? '';
  recordDelivery(session, { kind: 'card', title, content: raw.slice(0, 2000) });
  bus.activity('send', `Agent 回复卡片 → ${targetLabel(session)}`, title || raw.slice(0, 60));
  return `卡片已发出${title ? `（${title}）` : ''}`;
}

export interface CalendarArgs {
  title: string;
  start: string;
  end: string;
  description?: string;
  attendee_person_ids?: string[];
}

/** 「2026-08-29 14:00」按本地时区解释；ISO 带时区的按其自身解释 */
function parseTime(input: string, field: string): number {
  const s = (input ?? '').trim().replace(/\//g, '-');
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  const t = m
    ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime()
    : new Date(s).getTime();
  if (!Number.isFinite(t)) throw new AgentToolError(`${field} 无法解析：「${input}」。用 "YYYY-MM-DD HH:mm"（本地时区）或带时区的 ISO 格式`);
  return t;
}

export async function doCreateCalendarEvent(session: AgentSession, args: CalendarArgs): Promise<string> {
  const title = (args.title ?? '').trim();
  if (!title) throw new AgentToolError('title 不能为空');
  const startMs = parseTime(args.start, 'start');
  const endMs = parseTime(args.end, 'end');
  if (endMs <= startMs) throw new AgentToolError('end 必须晚于 start');
  if (endMs <= Date.now()) throw new AgentToolError('日程结束时间已经过去了，确认日期是否写错（今天是 ' + new Date().toISOString().slice(0, 10) + '）');

  const attendeeOpenIds: string[] = [];
  const skipped: string[] = [];
  for (const pid of args.attendee_person_ids ?? []) {
    const p = persons.byId(pid) ?? persons.byName(pid);
    if (!p) throw new AgentToolError(`参与人「${pid}」不存在。先用 list_members 查成员 id`);
    if (config.chatAdapter === 'lark' && !p.feishuOpenId) skipped.push(p.name);
    else attendeeOpenIds.push(config.chatAdapter === 'lark' ? p.feishuOpenId! : p.id);
  }

  const { eventId, mock } = await createAgentCalendarEvent({
    title,
    startMs,
    endMs,
    description: args.description,
    attendeeOpenIds: config.chatAdapter === 'lark' ? attendeeOpenIds : [],
  });
  recordDelivery(session, { kind: 'calendar', title, content: `${args.start} ~ ${args.end} event=${eventId}` });
  const fmt = (t: number) => {
    const d = new Date(t);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  return [
    `日程已创建：「${title}」${fmt(startMs)} ~ ${fmt(endMs)}${mock ? '（模拟环境）' : ''}`,
    attendeeOpenIds.length ? `已邀请 ${attendeeOpenIds.length} 位参与人` : '',
    skipped.length ? `注意：${skipped.join('、')} 是虚拟成员（无飞书账号），没有加进日程` : '',
  ].filter(Boolean).join('\n');
}

export async function doCheckBusy(_session: AgentSession, personIdOrName: string): Promise<string> {
  const p = persons.byId(personIdOrName) ?? persons.byName(personIdOrName);
  if (!p) throw new AgentToolError(`成员「${personIdOrName}」不存在。先用 list_members 查成员 id`);
  if (config.chatAdapter === 'lark' && !p.feishuOpenId) {
    return `${p.name} 是虚拟成员（无飞书日历），查不到忙闲`;
  }
  const busy = await getBusyStatus(p);
  if (!busy) return `${p.name} 的忙闲暂时查不到（日历通道不可用）`;
  return busy.busy && busy.until
    ? `${p.name} 现在正在开会/忙碌中，预计 ${fmtBusyUntil(busy.until)} 结束`
    : `${p.name} 当前日程空闲`;
}

export async function doListMembers(): Promise<string> {
  const lines = persons.all().map((p) => {
    const kind = p.feishuOpenId ? '真实飞书账号' : '虚拟成员（无飞书账号，私信/日程不可达）';
    return `- id=${p.id} 姓名=${p.name}（${kind}）`;
  });
  return ['团队成员名册（create_calendar_event 的 attendee_person_ids、check_busy 的 person_id 都用这里的 id）：', ...lines].join('\n');
}

// ===== 历史消息检索（需求 6：Agent 在海量历史上下文中找信息，结果全部带时间戳）=====

export interface SearchMessagesArgs {
  query: string;
  chat_id?: string;
  sender?: string;
  days?: number;
  limit?: number;
}

export async function doSearchMessages(session: AgentSession, args: SearchMessagesArgs): Promise<string> {
  const query = (args.query ?? '').trim();
  if (!query) throw new AgentToolError('query 不能为空。用空格分隔多个关键词（AND 关系），例如 "压测 结论"');
  const keywords = query.split(/\s+/).filter(Boolean).slice(0, 6);
  const days = Math.min(Math.max(args.days ?? 90, 1), 365);
  const sinceIso = new Date(Date.now() - days * 24 * 3600_000).toISOString();
  const rows = chatLog.query({
    keywords,
    chatId: args.chat_id || null,
    senderName: args.sender || null,
    sinceIso,
    limit: Math.min(Math.max(args.limit ?? 20, 1), 50),
  });
  bus.activity('run', `Agent 检索历史消息`, `${session.label} · 「${query}」命中 ${rows.length} 条`);
  if (!rows.length) {
    return `没有命中「${keywords.join(' + ')}」的消息（近 ${days} 天）。可以：减少关键词、换同义词、扩大 days，或用 recent_messages 直接翻最近的记录。`;
  }
  const chatName = (id: string) => chats.byId(id)?.name ?? (id.includes('p2p') ? '私聊' : id.slice(0, 12));
  const lines = rows.map((r) => `- [${fmtStamp(r.ts)}] ${r.senderName ?? '成员'}（${chatName(r.chatId)}）：${r.text.slice(0, 200)}`);
  return [`命中 ${rows.length} 条（新→旧，注意消息时间，别把旧消息当新情况）：`, ...lines].join('\n');
}

export interface RecentMessagesArgs {
  chat_id?: string;
  limit?: number;
}

export async function doRecentMessages(session: AgentSession, args: RecentMessagesArgs): Promise<string> {
  const chatId = args.chat_id || session.chatId;
  if (!chatId) throw new AgentToolError('这个会话没有默认聊天范围，请显式传 chat_id（可先用 search_messages 找到相关会话）');
  const limit = Math.min(Math.max(args.limit ?? 30, 1), 100);
  const rows = chatLog.recent(chatId, limit);
  if (!rows.length) return '这个会话还没有消息记录。';
  const lines = rows.map((r) => `- [${fmtStamp(r.ts)}] ${r.senderName ?? '成员'}：${(r.text ?? '').slice(0, 200)}`);
  return [`最近 ${rows.length} 条消息（旧→新）：`, ...lines].join('\n');
}

// ===== 心跳任务创建（需求 7：标准传参；创建后推确认卡，用户确认才启动）=====

export interface CreateHeartbeatArgs {
  requirement: string;
  first_trigger_at: string;
  interval_minutes?: number;
  total_runs: number;
}

export async function doCreateHeartbeat(session: AgentSession, args: CreateHeartbeatArgs): Promise<string> {
  const requirement = (args.requirement ?? '').trim();
  if (!requirement) throw new AgentToolError('requirement 不能为空：写清楚每次触发时要做什么（它会原样发给未来执行的 Agent）');
  if (requirement.length > 2000) throw new AgentToolError('requirement 过长（>2000 字），请精简');
  if (!session.personId) {
    throw new AgentToolError('当前请求人不是已注册成员，无法创建心跳任务（确认卡没有可发送的对象）');
  }
  const creator = persons.byId(session.personId);
  if (!creator) throw new AgentToolError('创建人不存在');

  const firstMs = parseLocal(args.first_trigger_at ?? '');
  if (!Number.isFinite(firstMs)) {
    throw new AgentToolError(`first_trigger_at 无法解析：「${args.first_trigger_at}」。用 "YYYY-MM-DD HH:mm"（本地时区），现在是 ${nowStamp()}`);
  }
  if (firstMs < Date.now() - 60_000) {
    throw new AgentToolError(`first_trigger_at 已经过去了（现在是 ${nowStamp()}）。传一个未来的时间`);
  }
  const totalRuns = Number.isFinite(args.total_runs) ? Math.floor(args.total_runs) : NaN;
  if (!Number.isFinite(totalRuns) || totalRuns < 0 || totalRuns > 3650) {
    throw new AgentToolError('total_runs 必须是 0~3650 的整数（0 = 无限次）');
  }
  const repeats = totalRuns === 0 || totalRuns > 1;
  const intervalMin = Math.floor(args.interval_minutes ?? 0);
  if (repeats && (!Number.isFinite(intervalMin) || intervalMin < 5)) {
    throw new AgentToolError('重复执行的心跳任务必须传 interval_minutes（≥5 分钟；每天一次 = 1440）');
  }

  const { createHeartbeatWithConfirm } = await import('./heartbeat.js');
  const hb = await createHeartbeatWithConfirm({
    creator,
    requirement,
    firstAtMs: firstMs,
    intervalMin: repeats ? intervalMin : 0,
    totalRuns,
    chatId: session.chatId,
  });
  recordDelivery(session, { kind: 'card', title: `心跳任务确认卡：${requirement.slice(0, 40)}`, content: hb.id });
  return [
    `心跳任务已创建（id=${hb.id}，状态：待确认）。确认卡已发给 ${creator.name}，本人确认后才会开始按计划执行。`,
    `计划：首次 ${nowStamp(new Date(firstMs))}，${totalRuns === 0 ? '无限次' : `共 ${totalRuns} 次`}${repeats ? `，间隔 ${intervalMin} 分钟` : ''}。`,
    '把这个安排告诉用户即可，不需要重复创建。',
  ].join('\n');
}

// ===== 群知识库（2026-08-29 需求⑥）=====

/** wiki 维护会话唯一交付出口：本地 wiki.md → 在线文档（Agent 不感知链接） */
export async function doUpdateWiki(session: AgentSession): Promise<string> {
  if (session.mode !== 'wiki') throw new AgentToolError('update_wiki 只在群知识库维护任务里可用');
  if (!session.chatId) throw new AgentToolError('这个维护会话没有绑定群');
  const { readGroupWiki, publishWiki, wikiFile } = await import('./wiki.js');
  const md = readGroupWiki(session.chatId);
  if (!md) {
    throw new AgentToolError(`还没有可发布的内容：先把知识库全文写进 ${wikiFile(session.chatId)}，再调用本工具`);
  }
  await publishWiki(session.chatId);
  recordDelivery(session, { kind: 'doc', title: '群知识库', content: md.slice(0, 2000) });
  bus.activity('send', 'Agent 发布群知识库 → 在线文档', `${md.length} 字`);
  return `知识库已发布（${md.length} 字）。在线文档由系统托管，你不需要关心链接；发布一次即可，直接结束。`;
}

/** 其它模式的 Agent 取用群知识库：Markdown 落进工作区，按需自行读取 */
export async function doGetWiki(session: AgentSession): Promise<string> {
  const { readGroupWiki } = await import('./wiki.js');
  const candidates = [session.chatId, adapter().demoChatId].filter((v): v is string => !!v);
  for (const cid of [...new Set(candidates)]) {
    const chat = chats.byId(cid);
    if (!chat?.wikiEnabled) continue;
    const md = readGroupWiki(cid);
    if (!md) continue;
    const dest = path.join(session.workspaceDir, `group-wiki-${cid.replace(/[^\w.-]/g, '_')}.md`);
    fs.writeFileSync(dest, md);
    bus.activity('run', 'Agent 取用群知识库', `${session.label} · ${md.length} 字`);
    return [
      `已把「${chat.name ?? '本群'}」的群知识库放进你的工作区：${dest}`,
      `（约 ${md.length} 字${chat.wikiUpdatedAt ? `，最后更新 ${fmtStamp(chat.wikiUpdatedAt)}` : ''}）用读文件工具按需查阅，别整篇照搬。`,
    ].join('\n');
  }
  return '这个群还没有可用的知识库（管理员未启用，或还没生成第一版）。按现有上下文继续即可。';
}

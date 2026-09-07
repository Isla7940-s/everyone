import { MemoryClient } from '@tencentdb-agent-memory/memory-sdk-ts';
import { config } from '../config.js';
import type { RecallHit } from './index.js';

/**
 * TencentDB Agent Memory Gateway 客户端（D18/FR-F1）。
 * - Gateway：Docker 容器 everyone-memory（agentmemory/hermes-memory standalone，127.0.0.1:8420）
 * - 四层：L0 conversation → L1 atomic → L2 scenario → L3 core（引擎管道自动提取）
 * - 隔离（实测校准）：容器版 Gateway 为单记忆空间（serviceId=default），
 *   改用 session_id 维度隔离：person:<personId> 与 group:<chatId>（决策日志 · 执行者补充）
 * - 出处（FR-F3 铁律）：capture 时内嵌「（出处：…）」，召回时解析还原
 */

const base = () => `http://127.0.0.1:${config.memoryGatewayPort}`;

let _client: MemoryClient | null = null;
function client(): MemoryClient {
  if (!_client) {
    _client = new MemoryClient({
      endpoint: base(),
      apiKey: process.env.TDAI_GATEWAY_API_KEY || 'local',
      serviceId: process.env.TDAI_GATEWAY_SERVICE_ID || 'default',
      timeout: 15_000,
    });
  }
  return _client;
}

const personSession = (personId: string) => `person:${personId}`;
const groupSession = (chatId: string) => `group:${chatId}`;

export async function ping(): Promise<boolean> {
  try {
    const res = await fetch(`${base()}/health`, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

const SOURCE_RE = /（出处：([^）]+)）\s*$/;

function withSource(content: string, sourceLink: string | null): string {
  return sourceLink ? `${content}（出处：${sourceLink}）` : content;
}

export async function capture(args: {
  personId: string | null;
  chatId: string;
  content: string;
  sourceLink: string | null;
  kind: string;
}): Promise<void> {
  // 原始事件时间内嵌进正文（需求 1）：引擎提取/召回后时间随内容保留，模型看得见事件新旧
  const { nowStamp } = await import('../time.js');
  const text = withSource(`[${args.kind}] [${nowStamp()}] ${args.content}`, args.sourceLink);
  const ts = new Date().toISOString();
  const jobs: Array<Promise<unknown>> = [
    client().addConversation({
      session_id: groupSession(args.chatId),
      messages: [{ role: 'user', content: text, timestamp: ts }],
    }),
  ];
  if (args.personId) {
    jobs.push(client().addConversation({
      session_id: personSession(args.personId),
      messages: [{ role: 'user', content: text, timestamp: ts }],
    }));
  }
  await Promise.all(jobs);
}

/** capture 内嵌的原始时间戳（nowStamp 格式），召回时解析还原为 RecallHit.ts */
const STAMP_RE = /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s*/;

/** 引擎元数据里的时间字段（conv message 的 timestamp 等），格式不稳定，宽容解析 */
function parseMetaTs(v: unknown): string | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  const ms = Number.isFinite(n) ? (n > 1e12 ? n : n > 1e9 ? n * 1000 : NaN) : new Date(String(v)).getTime();
  if (!Number.isFinite(ms) || ms < new Date('2020-01-01').getTime()) return undefined;
  return new Date(ms).toISOString();
}

export async function recall(personId: string, query: string, k: number): Promise<RecallHit[]> {
  const c = client();
  const [atomic, pConv, gConv] = await Promise.all([
    c.searchAtomic({ query, limit: k }).catch(() => ({ items: [] as any[] })),
    c.searchConversation({ query, limit: k, session_id: personSession(personId) }).catch(() => ({ messages: [] as any[] })),
    c.searchConversation({ query, limit: k }).catch(() => ({ messages: [] as any[] })),
  ]);

  const hits: RecallHit[] = [];
  const seenContent = new Set<string>();
  const push = (raw: string, fallbackSource: string, metaTs?: unknown) => {
    const m = raw.match(SOURCE_RE);
    let content = raw.replace(SOURCE_RE, '').replace(/^\[\w+\]\s*/, '').trim();
    // 原始事件时间（需求：召回必须真的带原始时间，不能只写在任务书标题里）：
    // 优先解析 capture 时内嵌的 [YYYY-MM-DD HH:mm]，其次引擎元数据时间戳
    let ts: string | undefined;
    const tm = content.match(STAMP_RE) ?? raw.match(STAMP_RE);
    if (tm) {
      const parsed = new Date(tm[1].replace(' ', 'T')).getTime();
      if (Number.isFinite(parsed)) ts = new Date(parsed).toISOString();
      // 时间已提取进 ts，去掉开头的内嵌戳避免展示重复（正文中段引用的时间保留）
      if (content.startsWith(tm[0].trimEnd()) || content.indexOf(tm[0]) < 12) content = content.replace(tm[0], '').trim();
    }
    if (!ts) ts = parseMetaTs(metaTs);
    const key = content.slice(0, 80);
    if (!content || seenContent.has(key)) return;
    seenContent.add(key);
    // 出处优先级：内嵌「（出处：…）」→ 文本中的链接（原消息链接常被 L1 保留在正文里）→ 调用方兜底
    let source = m?.[1] ?? '';
    if (!source) source = raw.match(/https?:\/\/[^\s）)】\]]+/)?.[0] ?? '';
    if (!source) source = fallbackSource;
    hits.push({ content: content.slice(0, 300), source, ts });
  };

  for (const it of atomic.items ?? []) {
    // background 是引擎生成的事实来源描述（如「我在和某某讨论某事」），作为出处而非正文
    const bg = String(it.background ?? '').replace(/\s+/g, ' ').slice(0, 80);
    push(String(it.content ?? ''), bg ? `记忆提取 · ${bg}` : '记忆库·事实', it.timestamp ?? it.created_at ?? it.create_time);
  }
  for (const it of pConv.messages ?? []) push(it.content, '记忆库·个人原文', it.timestamp ?? it.created_at);
  for (const it of gConv.messages ?? []) push(it.content, '记忆库·群原文', it.timestamp ?? it.created_at);
  return hits.slice(0, k);
}

/**
 * memory.md 保存时同步画像进引擎。
 * 实测（2026-08-28）：writeScenario 是「更新型」接口，目标文件不存在时 404
 * （L2 场景文件由引擎管道从对话自动生成，外部不能凭空创建）——
 * 之前对它的调用一直在静默失败。真实可用的同步通道是把画像逐行 capture 进 L0
 * （BM25 可召回，见 syncProfilesToEngine），这里改为直接复用该通道。
 */
export async function syncProfile(personId: string, content: string): Promise<void> {
  const lines = content.split('\n').filter((l) => l.trim().startsWith('-')).slice(0, 40);
  if (!lines.length) return;
  await capture({
    personId,
    chatId: 'profile',
    content: `${personId} 的画像要点（memory.md 更新）：${lines.join('；')}`,
    sourceLink: `${personId}/memory.md`,
    kind: 'doc',
  });
}

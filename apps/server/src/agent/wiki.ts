import fs from 'node:fs';
import path from 'node:path';
import type { ChatInfo } from '@everyone/shared';
import { bus } from '../bus.js';
import { config } from '../config.js';
import { createTaskDoc, overwriteTaskDoc } from '../executor/docstore.js';
import { spawnOpenCode } from '../executor/opencode.js';
import { agentRuns, chatLog, chats, kv } from '../store/repo.js';
import { fmtStamp, nowStamp, todayStr } from '../time.js';
import { closeAgentSession, createAgentSession } from './session.js';
import { withAgentSlot } from './run.js';

/**
 * 群知识库（2026-08-29 需求⑥）：
 * 管理员按群启用后，每天由一个独立沙箱的 Agent 维护该群的 wiki.md——
 * 有日报跟随日报触发，没日报到固定时间（config.wikiTime）兜底触发。
 * 维护 Agent 禁用回复用户的能力，唯一交付出口是 update_wiki（系统把本地 wiki.md
 * 覆盖到在线文档；文档由系统自动创建托管，Agent 全程不感知链接，管理员后台可换绑）。
 * 其余模式的 Agent 可用 get_wiki 把知识库以 Markdown 拉进自己的工作区按需取用。
 * 用途：新人快速了解群况 / 入群导读附件 / Agent 工作时的知识底座 / 群成员日常查阅。
 */

/** chatId → 安全目录名（live 群 id 形如 oc_xxx，mock 形如 mock-demo-chat） */
const safeDir = (chatId: string) => chatId.replace(/[^\w.-]/g, '_');

/** 群知识库沙箱：workspaces/_wiki/<chatId>/（跨天持久——wiki.md 就是知识库本体的工作副本） */
export function wikiSandbox(chatId: string): string {
  const dir = path.join(config.workspacesDir, '_wiki', safeDir(chatId));
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  return dir;
}

export function wikiFile(chatId: string): string {
  return path.join(wikiSandbox(chatId), 'wiki.md');
}

/** 读取某群知识库正文（get_wiki 与导读用）；没有或为空返回 null */
export function readGroupWiki(chatId: string): string | null {
  try {
    const s = fs.readFileSync(wikiFile(chatId), 'utf-8');
    return s.trim() ? s : null;
  } catch {
    return null;
  }
}

/** 本地 wiki.md 覆盖到在线文档；首次自动建档并登记（Agent 不感知，管理员可在后台换绑） */
export async function publishWiki(chatId: string): Promise<{ url: string }> {
  const chat = chats.byId(chatId);
  const md = readGroupWiki(chatId);
  if (!md) throw new Error('wiki.md 不存在或为空');
  const docId = `wiki-${safeDir(chatId)}`;
  if (chat?.wikiDocToken) {
    await overwriteTaskDoc(docId, chat.wikiDocToken, md);
    chats.markWikiUpdated(chatId);
    return { url: chat.wikiDocUrl ?? '' };
  }
  const title = `${chat?.name ?? '本群'} · 群知识库`;
  const doc = await createTaskDoc(docId, title, md);
  chats.setWikiDoc(chatId, doc.token, doc.url);
  chats.markWikiUpdated(chatId);
  bus.activity('run', `群知识库在线文档已创建`, doc.url);
  return { url: doc.url };
}

// ===== 维护任务执行（心跳式：独立沙箱 + 禁言 + update_wiki 唯一出口）=====

const inflight = new Set<string>();

export async function runWikiUpdate(chatId: string, trigger: string): Promise<void> {
  const chat = chats.byId(chatId);
  if (!chat || !chat.wikiEnabled || inflight.has(chatId)) return;
  inflight.add(chatId);
  // 当日尝试标记（成功失败都算尝试——失败不整天循环烧模型，管理员可手动重跑）
  kv.set(`wiki_attempt:${chatId}`, todayStr());
  try {
    await withAgentSlot(() => execWikiRun(chat, trigger));
  } finally {
    inflight.delete(chatId);
  }
}

async function execWikiRun(chat: ChatInfo, trigger: string): Promise<void> {
  const dir = wikiSandbox(chat.chatId);
  const chatLabel = chat.name ?? chat.chatId.slice(0, 14);
  const existing = readGroupWiki(chat.chatId);

  const session = createAgentSession({
    mode: 'wiki',
    chatId: chat.chatId,
    workspaceDir: dir,
    label: `群知识库 · ${chatLabel}`,
    ttlMs: (config.agentChatTimeoutSec + 600) * 1000,
  });
  agentRuns.start({
    id: session.id, mode: 'wiki',
    personId: null, personName: null,
    label: `群知识库维护 · ${chatLabel}`,
    request: `${trigger}触发：整理今日新记录，维护群知识库`,
    workspaceDir: `${config.workspacesRel}/_wiki/${safeDir(chat.chatId)}`,
  });
  bus.changed('run');
  bus.activity('run', `群知识库维护开工（${trigger}）`, chatLabel);

  // 今日新消息（时间戳齐全）；量大截断，Agent 可用 search/recent 工具自行补查
  const todayMsgs = chatLog.todayOf(chat.chatId);
  const msgLines = todayMsgs.slice(-200)
    .map((m) => `- [${fmtStamp(m.ts)}] ${m.senderName ?? '成员'}：${(m.text ?? '').slice(0, 150)}`)
    .join('\n');

  const wikiAbs = wikiFile(chat.chatId);
  const notesAbs = path.join(dir, 'notes');
  const briefAbs = path.join(dir, 'brief.md');
  fs.writeFileSync(briefAbs, [
    `# 群知识库维护任务（${trigger}触发）`,
    '',
    `当前时间：${nowStamp()}。你在维护「${chatLabel}」的群知识库——一份长期文档，读者是新入群的人、群成员和其他 Agent。`,
    '',
    '## 你的工作对象',
    '',
    `- 知识库本体：\`${wikiAbs}\`（${existing ? `已有 ${existing.length} 字，做**增量维护**` : '还不存在，做**首次建库**'}）`,
    `- 过程笔记：\`${notesAbs}/\`（跨天保留）`,
    '',
    '## 今天群里的新消息（带时间，可能被截断，需要更早的用检索工具）',
    '',
    msgLines || '（今天群里没有新消息——没有新信息也要检查一遍旧内容是否过时）',
    '',
    '## 知识库的结构要求',
    '',
    '- Markdown，第一行 `# 群知识库`，其后建议分节：群定位与基本情况 / 成员与分工 / 关键决策与结论（逐条带日期）/ 进行中的事项 / 常用口径与链接 / 新人须知（FAQ）',
    '- **增量维护而不是重写**：保留旧内容中仍然有效的部分，把今天的新决策/新结论/新事项融合进对应小节',
    '- 过时信息处理：已被新结论替代的旧口径要么删除、要么明确标注「已于 X 月 X 日更新为 …」——绝不能让过时报告污染读者',
    '- 事实必须带日期（如「8/29 定：单场预算 5 万封顶」）；不确定的传闻不进知识库',
    '',
    '## 可用工具',
    '',
    '- `feishu_search_messages` / `feishu_recent_messages`：检索历史消息补上下文（结果带时间戳）',
    '- `feishu_list_members`：成员名册',
    '- `feishu_update_wiki`：**唯一交付出口**——把你写好的 wiki.md 覆盖发布到在线文档（文档由系统托管，你不需要也无法知道链接）',
    '',
    '## 纪律',
    '',
    '- 这是后台维护任务，你**没有**回复用户的工具，也不要尝试联系任何人',
    `- 把知识库全文写进 \`${wikiAbs}\`，写完必须调用 \`feishu_update_wiki\` 发布——不调用它这次维护不生效`,
    '- 发布一次即可，随后直接结束',
  ].join('\n'));

  const startedDeliveries = session.deliveries.length;
  const publishedBefore = session.deliveries.length;
  try {
    await spawnOpenCode({
      cwd: dir,
      prompt: [
        `直接读文件 ${briefAbs}（不用先浏览目录），按其要求维护群知识库。`,
        `知识库写到 ${wikiAbs}，写完调用 feishu_update_wiki 发布——这是唯一的交付出口。`,
      ].join('\n'),
      timeoutSec: config.agentChatTimeoutSec,
      extraEnv: {
        EVERYONE_MCP_URL: `http://127.0.0.1:${config.serverPort}/mcp`,
        EVERYONE_AGENT_TOKEN: session.token,
      },
      traceId: session.id,
    });
    // 零发布抢救：Agent 写了 wiki.md 但忘调 update_wiki → 系统代为发布（内容已在，不能白干）
    if (session.deliveries.length === publishedBefore && readGroupWiki(chat.chatId)) {
      await publishWiki(chat.chatId);
      bus.activity('run', '知识库产出未走 update_wiki，已抢救代发布', chatLabel);
    }
    const md = readGroupWiki(chat.chatId);
    agentRuns.finish(session.id, 'succeeded', {
      deliveries: session.deliveries.length - startedDeliveries || (md ? 1 : 0),
      deliverySummary: md ? `知识库 ${md.length} 字` : '（无产出）',
    });
    bus.activity('run', `群知识库维护完成`, `${chatLabel} · ${md?.length ?? 0} 字`);
  } catch (e) {
    const msgText = String((e as Error)?.message ?? e);
    // 超时/失败抢救：wiki.md 有内容照样发布——半成品也比过时强
    if (readGroupWiki(chat.chatId)) {
      await publishWiki(chat.chatId).catch(() => {});
    }
    agentRuns.finish(session.id, msgText.includes('超时') ? 'timeout' : 'failed', {
      deliveries: session.deliveries.length - startedDeliveries, error: msgText,
    });
    bus.activity('system', `群知识库维护失败：${chatLabel}`, msgText.slice(0, 200));
  } finally {
    closeAgentSession(session);
    bus.changed('run');
    bus.changed('person'); // chats 数据挂在 person 变更事件上刷新前端
  }
}

// ===== 每日兜底调度（有日报跟随日报，这里只兜没跑过的）=====

export function startWikiScheduler(): void {
  setInterval(() => {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (hhmm < config.wikiTime) return;
    for (const chat of chats.all()) {
      if (!chat.wikiEnabled || chat.kind !== 'group') continue;
      if (kv.get(`wiki_attempt:${chat.chatId}`) === todayStr()) continue;
      runWikiUpdate(chat.chatId, '每日定时')
        .catch((e) => bus.activity('system', '群知识库定时维护异常', String(e).slice(0, 150)));
    }
  }, 60_000).unref();
}

import fs from 'node:fs';
import path from 'node:path';
import { bus } from '../bus.js';
import { config } from '../config.js';
import { chatLog, memoryEvents } from '../store/repo.js';
import { fmtStamp } from '../time.js';
import * as engine from './engine.js';

export interface RecallHit {
  content: string;
  /** 出处：消息链接 / 会议日期 / 文档链接（FR-F3 铁律：召回必带出处） */
  source: string;
  /** 原始事件时间（需求 1：记忆带时间，避免过时记忆污染）；引擎侧从内嵌时间戳/元数据解析 */
  ts?: string;
}

/**
 * 召回条目的统一展示行（喂提示词用）：必带原始时间——解析不出来时如实标「时间不详」，
 * 不允许静默省略（否则任务书里写着「带原始时间」实际却没有，模型无从判断新旧）。
 */
export function recallLine(h: RecallHit): string {
  const t = h.ts ? fmtStamp(h.ts) : '';
  return `- ${t ? `[${t}]` : '[时间不详]'} ${h.content}（出处：${h.source}）`;
}

let engineUp = false;

/** 启动时探测记忆引擎；失败走降级（FR-F6），主线不受影响；随后周期探活（网关走 SSH 隧道，会掉线） */
export async function initMemory(): Promise<void> {
  try {
    engineUp = await engine.ping();
  } catch {
    engineUp = false;
  }
  if (engineUp) {
    bus.activity('memory', '四层记忆引擎已连接', `TencentDB Agent Memory @${config.memoryGatewayPort}`);
  } else {
    bus.activity('system', '记忆引擎不可用，已降级', 'memory.md 直读 + SQLite 检索（FR-F6）');
  }
  setInterval(async () => {
    const nowUp = await engine.ping().catch(() => false);
    if (nowUp !== engineUp) {
      engineUp = nowUp;
      bus.activity(nowUp ? 'memory' : 'system',
        nowUp ? '记忆引擎恢复在线' : '记忆引擎掉线，自动降级',
        nowUp ? '四层召回已恢复' : 'memory.md 直读 + SQLite 检索兜底（FR-F6）');
    }
  }, 60_000).unref();
}

/** 启动时把所有成员的 memory.md 画像灌入引擎 L0（让 BM25 能召回预置画像；幂等：内容 hash 变化才写） */
export async function syncProfilesToEngine(personIds: string[]): Promise<void> {
  if (!engineUp) return;
  const { createHash } = await import('node:crypto');
  const { kv } = await import('../store/repo.js');
  for (const pid of personIds) {
    const mem = readPersonMemory(pid);
    if (!mem.trim()) continue;
    const hash = createHash('sha1').update(mem).digest('hex').slice(0, 12);
    const key = `profile_hash:${pid}`;
    if (kv.get(key) === hash) continue;
    try {
      // 画像逐行进 L0（带出处 = memory.md），便于 BM25 命中
      const lines = mem.split('\n').filter((l) => l.trim().startsWith('-')).slice(0, 40);
      if (lines.length) {
        await engine.capture({
          personId: pid,
          chatId: 'profile',
          content: `${pid} 的画像要点：${lines.join('；')}`,
          sourceLink: `${pid}/memory.md`,
          kind: 'doc',
        });
      }
      await engine.syncProfile(pid, mem);
      kv.set(key, hash);
    } catch { /* 引擎写失败不阻塞 */ }
  }
  bus.activity('memory', `画像已同步进记忆引擎`, `${personIds.length} 人`);
}

export function memoryEngineUp(): boolean {
  return engineUp;
}

/** 全量入记忆（FR-A5/F2）：群消息、会议文本、产出文档 */
export async function capture(args: {
  personId: string | null;
  chatId: string;
  content: string;
  sourceLink: string | null;
  kind: 'chat' | 'meeting' | 'doc' | 'feedback';
}): Promise<void> {
  // SQLite 全量存档由 pipeline 的 chatLog.save 完成；这里负责引擎侧 L0 capture
  if (!engineUp) return;
  try {
    await engine.capture(args);
  } catch (e) {
    bus.activity('system', '记忆 capture 失败（已忽略，SQLite 存档仍在）', String(e).slice(0, 150));
  }
}

/** 记忆召回（FR-F3）：必带出处 */
export async function recall(personId: string, query: string, k = 5): Promise<RecallHit[]> {
  if (engineUp) {
    try {
      const hits = await engine.recall(personId, query, k);
      if (hits.length) return hits;
    } catch (e) {
      bus.activity('system', '记忆 recall 失败，回退 SQLite', String(e).slice(0, 150));
    }
  }
  // 降级：SQLite LIKE 检索（分词取关键词逐个查）；命中带原始消息时间（需求 1）
  const keywords = extractKeywords(query);
  const seen = new Set<string>();
  const hits: RecallHit[] = [];
  for (const kw of keywords) {
    for (const row of chatLog.search(null, kw, 4)) {
      if (seen.has(row.msgId)) continue;
      seen.add(row.msgId);
      const when = new Date(row.ts);
      const dateStr = `${when.getMonth() + 1}/${when.getDate()}`;
      hits.push({
        content: `${row.senderName ?? '成员'}：${row.text.slice(0, 200)}`,
        source: row.msgLink ?? `${dateStr} 群消息`,
        ts: row.ts,
      });
      if (hits.length >= k) return hits;
    }
  }
  return hits;
}

export function extractKeywords(query: string): string[] {
  // 朴素中文关键词切分：连续 2~6 字的词组窗口
  const cleaned = query.replace(/[？?！!。，,\s@]+/g, ' ').trim();
  const parts = cleaned.split(' ').filter((p) => p.length >= 2);
  const out: string[] = [];
  for (const p of parts) {
    if (p.length <= 4) out.push(p);
    else {
      for (let i = 0; i + 3 <= p.length && out.length < 8; i += 2) out.push(p.slice(i, i + 3));
    }
  }
  return out.slice(0, 8);
}

// ===== memory.md（L3 画像人工可编辑视图，FR-F4）=====

export function memoryPath(personId: string): string {
  return path.join(config.workspacesDir, personId, 'memory.md');
}

export function readPersonMemory(personId: string): string {
  try {
    return fs.readFileSync(memoryPath(personId), 'utf-8');
  } catch {
    return '';
  }
}

export function writePersonMemory(personId: string, content: string): void {
  const p = memoryPath(personId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  if (engineUp) engine.syncProfile(personId, content).catch(() => {});
}

/** S7 记忆沉淀：append 带日期与来源，去重 */
export function appendPersonMemory(personId: string, items: string[], source: string, sourceRunId?: string): string[] {
  if (!items.length) return [];
  const existing = readPersonMemory(personId);
  const fresh = items.filter((i) => i.trim() && !existing.includes(i.trim()));
  if (!fresh.length) return [];
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const lines = fresh.map((i) => `- ${today}（${source}）：${i.trim()}`).join('\n');
  writePersonMemory(personId, `${existing.trimEnd()}\n${lines}\n`);
  for (const i of fresh) memoryEvents.add(personId, i, sourceRunId);
  bus.activity('memory', `沉淀 ${fresh.length} 条偏好 → ${personId}/memory.md`, fresh.join('；'));
  return fresh;
}

export interface PresetSkill {
  /** 文件名去掉 .md，装进沙箱后就是 skill 名 */
  name: string;
  /** 「# Skill: xxx」里的中文名 */
  title: string;
  /** 标题下那行引用，说明什么时候用它 */
  summary: string;
  content: string;
}

/**
 * 预制 skill 库：随产品发布的通用写作模板（templates/preset-skills/）。
 * 新人的分身一开始什么都不会写，从这里挑一个装上就有稳定成稿标准。
 */
export function listPresetSkills(): PresetSkill[] {
  const dir = path.join(config.root, 'templates', 'preset-skills');
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => {
        const content = fs.readFileSync(path.join(dir, f), 'utf-8');
        return {
          name: f.replace(/\.md$/, ''),
          title: /^#\s*Skill:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? f.replace(/\.md$/, ''),
          summary: /^>\s*(.+)$/m.exec(content)?.[1]?.trim() ?? '',
          content,
        };
      });
  } catch {
    return [];
  }
}

/** 读取个人 skills 清单（FR-C2） */
export function readPersonSkills(personId: string): Array<{ name: string; content: string; enabled: boolean }> {
  const dir = path.join(config.workspacesDir, personId, 'skills');
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({
        name: f.replace(/\.md$/, '').replace(/^_/, ''),
        content: fs.readFileSync(path.join(dir, f), 'utf-8'),
        enabled: !f.startsWith('_'), // 下划线前缀 = 停用
      }));
  } catch {
    return [];
  }
}

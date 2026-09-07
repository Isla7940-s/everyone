import fs from 'node:fs';
import path from 'node:path';
import type { PierceDay, PierceRequirement, PierceWeek, WorkSession } from '@everyone/shared';
import { bus } from '../bus.js';
import { config } from '../config.js';
import { persons } from '../store/repo.js';
import { helpAttachments, helpRequests, timeEntries, workSessions, type HelpRow } from './store.js';

/**
 * 跨端协同业务层：
 * - 远程求助的阻塞等待（§九：request_remote_help 一直阻塞到本地提交结果）
 * - 求助附件落盘 + 同步进发起方云端沙箱（§十二）
 * - 时间穿透周聚合（§十三）
 * - 云端 Agent 任务书的「最近工作总结」注入块（§八：启动自动获得最近 5 条）
 */

// ===== 阻塞等待注册表 =====

const waiters = new Map<string, Set<(h: HelpRow) => void>>();

/** 求助到达终态：唤醒所有等待中的 MCP 调用 */
export function notifyHelpFinished(help: HelpRow): void {
  const set = waiters.get(help.id);
  if (!set) return;
  waiters.delete(help.id);
  for (const resolve of set) resolve(help);
}

/**
 * 阻塞等待求助结果：立即返回终态，否则挂起直到本地提交或超时。
 * 超时不改变求助状态（本地可能仍在执行），调用方可用 wait_help_result 继续等（§九）。
 */
export async function waitForHelp(helpId: string, timeoutMs: number): Promise<HelpRow | 'timeout'> {
  const current = helpRequests.byId(helpId);
  if (!current) throw new Error(`求助请求 ${helpId} 不存在`);
  if (current.status === 'succeeded' || current.status === 'failed') return current;

  return new Promise((resolve) => {
    let done = false;
    const settle = (v: HelpRow | 'timeout') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const set = waiters.get(helpId);
      set?.delete(onFinish);
      if (set && !set.size) waiters.delete(helpId);
      resolve(v);
    };
    const onFinish = (h: HelpRow) => settle(h);
    const timer = setTimeout(() => settle('timeout'), timeoutMs);
    if (!waiters.has(helpId)) waiters.set(helpId, new Set());
    waiters.get(helpId)!.add(onFinish);
    // 竞态兜底：注册期间已终态
    const again = helpRequests.byId(helpId);
    if (again && (again.status === 'succeeded' || again.status === 'failed')) settle(again);
  });
}

// ===== 求助附件 =====

export function helpAttachmentDir(helpId: string): string {
  const dir = path.join(config.dataDir, 'collab', 'help', helpId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const SAFE_NAME_RE = /[^\w.\u4e00-\u9fa5-]+/g;

/**
 * 保存附件并同步进发起方云端沙箱（§十二：附件需要同步到发起求助的云端 Agent 沙箱中）。
 * 返回附件在云端沙箱内的绝对路径（没有沙箱时为 null）。
 */
export function saveHelpAttachment(help: HelpRow, filename: string, content: Buffer): {
  relPath: string; size: number; sandboxPath: string | null;
} {
  const safe = (path.basename(filename) || 'attachment').replace(SAFE_NAME_RE, '_').slice(0, 120);
  const dir = helpAttachmentDir(help.id);
  const abs = path.join(dir, safe);
  fs.writeFileSync(abs, content);
  const relPath = path.relative(config.dataDir, abs);
  helpAttachments.add(help.id, { filename: safe, relPath, size: content.length });

  let sandboxPath: string | null = null;
  if (help.requesterWorkspaceDir && fs.existsSync(help.requesterWorkspaceDir)) {
    const destDir = path.join(help.requesterWorkspaceDir, 'help', help.id);
    fs.mkdirSync(destDir, { recursive: true });
    sandboxPath = path.join(destDir, safe);
    fs.copyFileSync(abs, sandboxPath);
  }
  return { relPath, size: content.length, sandboxPath };
}

/** 求助终结统一入口：写库 → 唤醒阻塞的 MCP → 活动流 */
export function finishHelp(helpId: string, args: {
  status: 'succeeded' | 'failed'; replyText?: string | null; replyNote?: string | null; error?: string | null;
}): HelpRow | null {
  const updated = helpRequests.finish(helpId, args);
  if (updated) {
    notifyHelpFinished(updated);
    const who = persons.byId(updated.personId)?.name ?? updated.personId;
    bus.activity(
      'run',
      args.status === 'succeeded' ? `远程求助完成（${who} 的本地 Agent）` : `远程求助失败（${who}）`,
      (args.replyText ?? args.error ?? '').slice(0, 120),
    );
    bus.changed('run');
  }
  return updated;
}

// ===== 时间穿透（§十三）=====

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function localDateKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 任意日期 → 所在周的周一（本地时区） */
export function weekStartOf(dateStr?: string | null): string {
  const base = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date();
  const d = Number.isFinite(base.getTime()) ? base : new Date();
  const day = d.getDay(); // 0=周日
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return localDateKey(d);
}

export function shiftWeek(weekStart: string, deltaWeeks: number): string {
  const d = new Date(`${weekStart}T00:00:00`);
  d.setDate(d.getDate() + deltaWeeks * 7);
  return localDateKey(d);
}

/** 周聚合：天 → 大需求 → 子任务 → 工作记录（关联会话总结随记录带出） */
export function buildPierceWeek(personId: string, weekStartInput?: string | null): PierceWeek {
  const weekStart = weekStartOf(weekStartInput);
  const start = new Date(`${weekStart}T00:00:00`);
  const dayKeys: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    dayKeys.push(localDateKey(d));
  }
  const weekEnd = dayKeys[6];
  const rows = timeEntries.ofRange(personId, weekStart, weekEnd);

  const days: PierceDay[] = dayKeys.map((date) => {
    const dayRows = rows.filter((r) => r.date === date);
    const reqMap = new Map<string, PierceRequirement>();
    for (const r of dayRows) {
      if (!reqMap.has(r.requirement)) reqMap.set(r.requirement, { name: r.requirement, minutes: 0, subtasks: [] });
      const req = reqMap.get(r.requirement)!;
      req.minutes += r.minutes;
      let sub = req.subtasks.find((s) => s.name === r.subtask);
      if (!sub) {
        sub = { name: r.subtask, minutes: 0, entries: [] };
        req.subtasks.push(sub);
      }
      sub.minutes += r.minutes;
      // 记录本身没带总结时，从关联会话补（展开到 25 字/100 字总结，§十三）
      const session = r.sessionId ? workSessions.byId(r.sessionId) : null;
      sub.entries.push({
        id: r.id,
        sessionId: r.sessionId,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        minutes: r.minutes,
        briefSummary: r.briefSummary ?? session?.briefSummary ?? null,
        detailSummary: r.detailSummary ?? session?.detailSummary ?? null,
        sourceTool: r.sourceTool ?? session?.sourceTool ?? null,
      });
    }
    const requirements = [...reqMap.values()].sort((a, b) => b.minutes - a.minutes);
    const d = new Date(`${date}T00:00:00`);
    return {
      date,
      weekday: WEEKDAYS[d.getDay()],
      totalMinutes: dayRows.reduce((acc, r) => acc + r.minutes, 0),
      requirements,
    };
  });

  return {
    personId,
    weekStart,
    weekEnd,
    days,
    totalMinutes: days.reduce((acc, d) => acc + d.totalMinutes, 0),
  };
}

// ===== 任务书注入（§八：云端 Agent 启动自动获得最近 5 条工作总结）=====

function fmtSessionLine(s: WorkSession): string {
  const who = persons.byId(s.personId)?.name ?? s.personId;
  const at = s.sessionAt.slice(0, 16).replace('T', ' ');
  return `- [${s.id}] ${at} ${who} · ${s.requirement} / ${s.subtask}（${s.sourceTool}）：${s.briefSummary}`;
}

/** 最近 N 条工作总结块（写进任务书）；没有数据时也给出能力说明，Agent 才知道有这些 MCP 可用 */
export function recentSummariesBlock(limit = 5): string {
  const rows = workSessions.recent({ limit });
  const lines = rows.length
    ? rows.map(fmtSessionLine).join('\n')
    : '（云端还没有工作总结记录）';
  return [
    '## 团队最近的本地工作总结（跨端协同）',
    '',
    '团队成员在 Codex / Cursor / Claude Code 等本地 AI 工具里的工作会话总结（最近 5 条，完整原文在成员本地）：',
    lines,
    '',
    '需要更多时可用 MCP 工具：`feishu_collab_list_work_summaries`（近期列表）、`feishu_collab_search_work_summaries`（关键词搜索）、',
    '`feishu_collab_get_work_session_detail`（按会话 ID 取 100 字详细总结与关联任务）、`feishu_collab_get_related_work_sessions`（相关会话）。',
    '如果某件工作曾由某个本地 AI 完成而你缺少上下文，可用 `feishu_collab_request_remote_help` 发起远程求助（阻塞直到对方本地 Agent 返回结果；超时按提示用 `feishu_collab_wait_help_result` 继续等）。',
  ].join('\n');
}

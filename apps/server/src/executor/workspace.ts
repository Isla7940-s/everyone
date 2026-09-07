import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * agent skill 铺设（工作区/沙箱根）：feishu-cards.md（卡片写法）+ html-style.md（HTML 交付风格规范，需求 5）。
 * 不进 skills/（那是用户自己的技能清单）；MCP 工具描述与任务书都指路到这里。
 */
export function plantAgentSkills(dir: string): void {
  for (const name of ['feishu-cards.md', 'html-style.md']) {
    const dst = path.join(dir, name);
    if (fs.existsSync(dst)) continue;
    try {
      fs.copyFileSync(path.join(config.templatesDir, 'agent-skills', name), dst);
    } catch { /* 模板缺失不阻断 */ }
  }
}

/** 确保个人工作区结构存在（FR-C2）：memory.md + skills/ + repo/ + tasks/ */
export function ensureWorkspace(personId: string, personName: string): string {
  const dir = path.join(config.workspacesDir, personId);
  fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'repo'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
  const memPath = path.join(dir, 'memory.md');
  if (!fs.existsSync(memPath)) {
    fs.writeFileSync(memPath, `# ${personName}的记忆（L3 画像 · 人工可编辑视图）\n\n## 关于我\n\n- （在管理后台补充你的负责域与偏好）\n\n<!-- 以下为自动沉淀区，Everyone 会带日期追加 -->\n`);
  }
  plantAgentSkills(dir);
  return dir;
}

/**
 * 任务工作目录：一任务一文件夹，任务书与产物都在里面。
 * 旧结构（task-brief.md 全人共用一份 + outbox/<id>/draft.md）会被并发任务互相覆盖，
 * 且用户在沙箱里看不出哪个文件属于哪个任务。
 */
export function taskDir(personId: string, taskId: string): string {
  const dir = path.join(config.workspacesDir, personId, 'tasks', taskId);
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  return dir;
}

export const briefPath = (personId: string, taskId: string) =>
  path.join(taskDir(personId, taskId), 'brief.md');

export const draftPath = (personId: string, taskId: string) =>
  path.join(taskDir(personId, taskId), 'draft.md');

/** 任务目录内的相对路径（写进任务书、给 OpenCode 用；始终用 / 分隔） */
export const taskRel = (taskId: string, name: string) => `tasks/${taskId}/${name}`;

/** 旧结构产物位置，只用于读取兼容 */
const legacyDraftPath = (personId: string, taskId: string) =>
  path.join(config.workspacesDir, personId, 'outbox', taskId, 'draft.md');

export function readDraft(personId: string, taskId: string): string | null {
  for (const p of [draftPath(personId, taskId), legacyDraftPath(personId, taskId)]) {
    try {
      return fs.readFileSync(p, 'utf-8');
    } catch { /* 换下一个候选 */ }
  }
  return null;
}

/** 产物实际所在的相对路径（新结构优先，回落旧结构），供沙箱透视展示 */
export function draftRel(personId: string, taskId: string): { rel: string; exists: boolean } {
  if (fs.existsSync(draftPath(personId, taskId))) return { rel: taskRel(taskId, 'draft.md'), exists: true };
  if (fs.existsSync(legacyDraftPath(personId, taskId))) return { rel: `outbox/${taskId}/draft.md`, exists: true };
  return { rel: taskRel(taskId, 'draft.md'), exists: false };
}

/** 任务书实际所在的相对路径（新结构优先，回落旧的全局 task-brief.md） */
export function briefRel(personId: string, taskId: string): { rel: string; exists: boolean } {
  if (fs.existsSync(briefPath(personId, taskId))) return { rel: taskRel(taskId, 'brief.md'), exists: true };
  const legacy = path.join(config.workspacesDir, personId, 'task-brief.md');
  if (fs.existsSync(legacy)) return { rel: 'task-brief.md', exists: true };
  return { rel: taskRel(taskId, 'brief.md'), exists: false };
}

// ===== repo 变更快照（代码任务证据链）=====

/** 对某人 repo/ 做内容快照（path → sha1），用于执行前后对比 */
export function snapshotRepo(personId: string): Map<string, string> {
  const root = path.join(config.workspacesDir, personId, 'repo');
  const snap = new Map<string, string>();
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else {
        try {
          const buf = fs.readFileSync(abs);
          snap.set(r, createHash('sha1').update(buf).digest('hex'));
        } catch { /* 读失败跳过 */ }
      }
    }
  };
  walk(root, '');
  return snap;
}

/** 快照对比：返回 新增/修改/删除 的文件清单 */
export function diffRepoSnapshots(before: Map<string, string>, after: Map<string, string>): {
  added: string[]; modified: string[]; deleted: string[]; changed: boolean;
} {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [p, h] of after) {
    if (!before.has(p)) added.push(p);
    else if (before.get(p) !== h) modified.push(p);
  }
  for (const p of before.keys()) if (!after.has(p)) deleted.push(p);
  return { added, modified, deleted, changed: added.length + modified.length + deleted.length > 0 };
}

export interface WorkspaceEntry {
  path: string;
  size: number;
  /** 目录也进列表，前端才能画出空文件夹 */
  dir: boolean;
  mtime: string;
}

/** 浏览整个工作区（沙箱文件浏览器用）：目录与文件都返回，node_modules 只留目录节点 */
export function listWorkspaceFiles(personId: string): WorkspaceEntry[] {
  const root = path.join(config.workspacesDir, personId);
  const out: WorkspaceEntry[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      let st: fs.Stats;
      try { st = fs.statSync(abs); } catch { continue; }
      const isDir = e.isDirectory();
      out.push({ path: r, size: isDir ? 0 : st.size, dir: isDir, mtime: st.mtime.toISOString() });
      // 依赖目录只露一层，避免几万个文件把接口撑爆
      if (isDir && e.name !== 'node_modules' && depth < 8) walk(abs, r, depth + 1);
    }
  };
  walk(root, '', 0);
  return out;
}

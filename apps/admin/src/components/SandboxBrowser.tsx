import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '@everyone/shared';
import { get, post } from '../lib/api';
import { fileSize, fmtDate } from '../lib/format';
import { Markdown } from './Markdown';
import {
  Empty, IconChevronRight, IconFile, IconFolder, IconFolderOpen, IconLock, Tag,
} from '../ui';

export interface SandboxEntry {
  path: string;
  size: number;
  dir: boolean;
  mtime: string;
}

interface Node extends SandboxEntry {
  name: string;
  children: Node[];
}

/** 扁平清单 → 目录树。按深度排序保证父节点先建好 */
function buildTree(entries: SandboxEntry[]): Node {
  const root: Node = { name: '', path: '', dir: true, size: 0, mtime: '', children: [] };
  const byPath = new Map<string, Node>([['', root]]);
  const depth = (p: string) => p.split('/').length;
  const sorted = entries.slice().sort((a, b) => {
    if (depth(a.path) !== depth(b.path)) return depth(a.path) - depth(b.path);
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  for (const e of sorted) {
    const parts = e.path.split('/');
    const parent = byPath.get(parts.slice(0, -1).join('/'));
    if (!parent) continue;
    const node: Node = { ...e, name: parts[parts.length - 1], children: [] };
    parent.children.push(node);
    if (e.dir) byPath.set(e.path, node);
  }
  return root;
}

/** 目录在前、同类按名称；数字后缀走自然序 */
function sortChildren(nodes: Node[]): Node[] {
  return nodes.slice().sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
  });
}

function nodeAt(root: Node, path: string): Node | null {
  if (!path) return root;
  let cur: Node = root;
  for (const part of path.split('/')) {
    const next = cur.children.find((c) => c.name === part);
    if (!next) return null;
    cur = next;
  }
  return cur;
}

/** 沙箱结构的语义注释：让用户看懂哪个目录是干什么的 */
function explain(path: string, dir: boolean): string {
  if (path === 'memory.md') return '你的记忆画像（L3），分身每次执行都会读';
  if (path === 'skills') return '技能指令，启用后注入任务书';
  if (path === 'repo') return '长期代码仓，代码任务在这里改';
  if (path === 'tasks') return '一任务一目录，任务书与产物都在里面';
  if (path === 'outbox') return '旧结构产物（历史任务），新任务已改用 tasks/';
  if (/\/notes$/.test(path) || path === 'notes') return 'Agent 的过程笔记';
  if (/\/brief\.md$/.test(path) || path === 'task-brief.md' || path === 'brief.md') return '任务书：Agent 的唯一输入';
  if (/\/draft\.md$/.test(path)) return '成稿 / 变更报告，确认后发出去的就是它';
  if (path.startsWith('skills/')) return dir ? '' : '技能文件';
  // 超级代理沙箱（_agent / _heartbeat）
  if (/^\d{4}-\d{2}-\d{2}$/.test(path)) return 'Agent 对话按天沙箱';
  if (/\/sessions$/.test(path)) return '一次对话一个目录';
  if (/sessions\/as-[0-9a-f]+$/.test(path)) return 'Agent 会话工作目录';
  if (/^hb-[0-9a-f]+$/.test(path)) return '心跳任务独立沙箱（跨触发持久）';
  if (/(^|\/)(feishu-cards|html-style)\.md$/.test(path)) return 'agent skill（运行时铺设）';
  return '';
}

/**
 * 沙箱文件浏览器（访达式）：左目录树 + 右当前目录列表 + 文件预览。
 * 沙箱按任务分层（tasks/<taskId>/），这里把任务 id 旁边标上任务标题。
 */
export function SandboxBrowser({ personId, entries, tasks, rootLabel, rootPath, onUploaded, canUpload = true }: {
  personId: string;
  entries: SandboxEntry[];
  tasks: Task[];
  rootLabel: string;
  /** 沙箱在磁盘上的真实相对路径，用于说明文案 */
  rootPath: string;
  /** 上传完成后的刷新回调（父组件重拉文件清单） */
  onUploaded?: () => void;
  /** 只读浏览（管理员看超级代理沙箱）时关掉上传入口 */
  canUpload?: boolean;
}) {
  const [cwd, setCwd] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['tasks']));
  const [file, setFile] = useState<{ path: string; content: string; binary?: boolean; truncated?: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');
  const uploadRef = useRef<HTMLInputElement>(null);

  // 上传目标：当前在 repo/ 内传当前目录，否则默认 repo/ 根（repo 是分身的长期上下文仓）
  const uploadDir = cwd === 'repo' || cwd.startsWith('repo/') ? cwd : 'repo';

  const doUpload = async (files: FileList | null) => {
    if (!files?.length || uploading) return;
    setUploading(true);
    setUploadMsg('');
    try {
      let okCount = 0;
      for (const f of Array.from(files).slice(0, 10)) {
        const b64 = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
          r.onerror = () => reject(r.error);
          r.readAsDataURL(f);
        });
        const res = await post<{ ok?: boolean; error?: string }>(`/api/workspace/${personId}/upload`, {
          path: `${uploadDir}/${f.name}`,
          contentBase64: b64,
        });
        if (res?.error) {
          setUploadMsg(res.error);
        } else {
          okCount += 1;
        }
      }
      if (okCount) {
        setUploadMsg(`已上传 ${okCount} 个文件到 ${uploadDir}/ · 分身答题与干活时都能读到`);
        setExpanded((s) => new Set(s).add('repo'));
        onUploaded?.();
      }
    } catch (e) {
      setUploadMsg(`上传失败：${String(e).slice(0, 80)}`);
    } finally {
      setUploading(false);
      if (uploadRef.current) uploadRef.current.value = '';
    }
  };

  const root = useMemo(() => buildTree(entries), [entries]);
  const taskTitle = useMemo(
    () => new Map(tasks.map((t) => [t.id, t.title])),
    [tasks],
  );

  useEffect(() => {
    setCwd('');
    setFile(null);
  }, [personId]);

  const current = nodeAt(root, cwd) ?? root;
  const items = sortChildren(current.children);

  const openFile = async (path: string) => {
    setLoading(true);
    try {
      const d = await get<{ content?: string; binary?: boolean; truncated?: boolean }>(
        `/api/workspace/${personId}/file?path=${encodeURIComponent(path)}`,
      );
      setFile({ path, content: d.content ?? '', binary: d.binary, truncated: d.truncated });
    } catch {
      setFile({ path, content: '（读不到这个文件，可能已被分身删除）' });
    } finally {
      setLoading(false);
    }
  };

  const enter = (node: Node) => {
    if (node.dir) {
      setCwd(node.path);
      setFile(null);
      setExpanded((s) => new Set(s).add(node.path));
    } else {
      openFile(node.path);
    }
  };

  const crumbs = cwd ? cwd.split('/') : [];

  /** 目录树递归行。任务目录用任务标题代替一串 id */
  const TreeRow = ({ node, depth }: { node: Node; depth: number }) => {
    const open = expanded.has(node.path);
    const dirs = sortChildren(node.children).filter((c) => c.dir);
    const isCwd = cwd === node.path;
    const title = taskTitle.get(node.name);
    return (
      <>
        <button
          className={`tr-row ${isCwd ? 'on' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          title={title ? `${title}（${node.name}）` : node.path}
          onClick={() => {
            setCwd(node.path);
            setFile(null);
            setExpanded((s) => {
              const n = new Set(s);
              if (open) n.delete(node.path);
              else n.add(node.path);
              return n;
            });
          }}
        >
          <span className={`tr-caret ${open ? 'open' : ''} ${dirs.length ? '' : 'blank'}`}>
            <IconChevronRight size={12} />
          </span>
          <span className="tr-ico">
            {open ? <IconFolderOpen size={15} /> : <IconFolder size={15} />}
          </span>
          <span className="tr-name">{title ?? node.name}</span>
          <span className="tr-n">{node.children.length || ''}</span>
        </button>
        {open && dirs.map((d) => <TreeRow key={d.path} node={d} depth={depth + 1} />)}
      </>
    );
  };

  return (
    <div className="sandbox">
      <div className="sb-note">
        <IconLock size={14} />
        <div>
          分身的子进程 cwd 锁死在 <code>{rootPath}/</code>，读写都出不了这个目录。
          每个任务有自己的 <code>tasks/&lt;任务 id&gt;/</code>，任务书、成稿、过程笔记分开存，互不覆盖。
        </div>
      </div>

      <div className="sb-body">
        <div className="sb-tree">
          <button className={`tr-row root ${cwd === '' ? 'on' : ''}`} onClick={() => { setCwd(''); setFile(null); }}>
            <span className="tr-ico"><IconFolderOpen size={15} /></span>
            <span className="tr-name">{rootLabel}</span>
          </button>
          {sortChildren(root.children).filter((c) => c.dir).map((d) => (
            <TreeRow key={d.path} node={d} depth={1} />
          ))}
        </div>

        <div className="sb-main">
          <div className="sb-crumbs">
            <button className="cb" onClick={() => { setCwd(''); setFile(null); }}>{rootLabel}</button>
            {crumbs.map((part, i) => {
              const p = crumbs.slice(0, i + 1).join('/');
              const title = taskTitle.get(part);
              return (
                <span key={p} className="cbwrap">
                  <IconChevronRight size={11} />
                  <button className="cb" title={part} onClick={() => { setCwd(p); setFile(null); }}>
                    {title ?? part}
                  </button>
                </span>
              );
            })}
            {file && (
              <span className="cbwrap">
                <IconChevronRight size={11} />
                <span className="cb cur">{file.path.split('/').pop()}</span>
              </span>
            )}
            <span style={{ flex: 1 }} />
            {!file && canUpload && (
              <button
                className="btn xs"
                disabled={uploading}
                title={`上传到 ${uploadDir}/ —— 给分身喂上下文（代码、文档、数据），代答和干活都会用`}
                onClick={() => uploadRef.current?.click()}
              >
                {uploading ? '上传中…' : `⤴ 上传到 ${uploadDir}/`}
              </button>
            )}
            <input
              ref={uploadRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => doUpload(e.target.files)}
            />
          </div>
          {uploadMsg && <div className="sb-upload-msg">{uploadMsg}</div>}

          {file
            ? (
              <div className="sb-preview">
                <div className="sb-pv-head">
                  <IconFile size={14} />
                  <span className="fp">{file.path}</span>
                  {file.truncated && <Tag tone="orange">只显示前 512KB</Tag>}
                  <span style={{ flex: 1 }} />
                  <button className="btn xs" onClick={() => setFile(null)}>返回目录</button>
                </div>
                {file.binary
                  ? <Empty icon={<IconFile size={20} />} title="二进制文件">这个文件不是文本，无法预览</Empty>
                  : file.path.endsWith('.md')
                    ? <div className="sb-md"><Markdown text={file.content} /></div>
                    : <div className="pre sb-code">{file.content}</div>}
              </div>
            )
            : (
              <div className="sb-list">
                {items.length === 0 && (
                  <Empty tight icon={<IconFolder size={18} />}>这个文件夹是空的</Empty>
                )}
                {items.map((n) => {
                  const note = explain(n.path, n.dir);
                  const title = n.dir ? taskTitle.get(n.name) : undefined;
                  return (
                    <button className="sb-item" key={n.path} onClick={() => enter(n)} title={n.path}>
                      <span className={`si-ico ${n.dir ? 'dir' : ''}`}>
                        {n.dir ? <IconFolder size={16} /> : <IconFile size={15} />}
                      </span>
                      <span className="si-name">
                        {title ?? n.name}
                        {title && <span className="si-task">{n.name}</span>}
                        {note && <span className="si-note">{note}</span>}
                      </span>
                      <span className="si-meta">
                        {n.dir ? `${n.children.length} 项` : fileSize(n.size)}
                      </span>
                      <span className="si-time">{n.mtime ? fmtDate(n.mtime) : ''}</span>
                      <span className="si-go">{n.dir ? <IconChevronRight size={13} /> : null}</span>
                    </button>
                  );
                })}
                {loading && <div className="sb-loading">读取中…</div>}
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

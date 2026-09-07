import { useCallback, useEffect, useState } from 'react';
import type { Person, Run, Task } from '@everyone/shared';
import { get, patch } from '../lib/api';
import {
  docLink, fmtDate, fmtDay, fmtTime, KIND_LABEL, QUADS, quadrantOf, RUN_STATUS, SOURCE_LABEL,
  statusOf, toDateTimeInput,
} from '../lib/format';
import {
  Avatar, TimeField, Empty, IconBot, IconClose, IconFile, IconQuadrant, IconTask, Tag,
} from '../ui';

interface Detail {
  task: Task;
  owner: Person | null;
  runs: Run[];
  sandboxFiles: Array<{ name: string; path: string; exists: boolean }>;
  sandbox?: { dir: string; note: string };
}

/** 任务详情抽屉：概览 / 象限与截止调整 / 执行历史 / 沙箱透视 */
export function TaskDrawer({ taskId, onClose, onChanged }: {
  taskId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [preview, setPreview] = useState<{ name: string; content: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await get<Detail>(`/api/task/${taskId}/detail`));
    } catch { /* 保持上一次内容 */ }
  }, [taskId]);

  useEffect(() => {
    load();
    setPreview(null);
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const apply = async (body: Record<string, unknown>) => {
    setSaving(true);
    try {
      await patch(`/api/task/${taskId}`, body);
      await load();
      onChanged();
    } finally {
      setSaving(false);
    }
  };

  const openFile = async (f: { name: string; path: string }) => {
    if (!detail) return;
    const d = await get<{ content?: string }>(
      `/api/workspace/${detail.task.ownerId}/file?path=${encodeURIComponent(f.path)}`,
    );
    setPreview({ name: f.name, content: d.content ?? '（读取失败）' });
  };

  if (!detail) return null;
  const t = detail.task;
  const st = statusOf(t.status);
  const activeQuad = quadrantOf(t);
  const doc = docLink(t);

  return (
    <>
      <div className="mask" onClick={onClose} />
      <div className="drawer" role="dialog" aria-label="任务详情">
        <div className="drawer-head">
          <IconTask size={19} color="var(--ink-3)" />
          <span className="dt">{t.title}</span>
          <Tag tone={st.tone} dot>{st.label}</Tag>
          {t.taskKind && <Tag tone="purple">{KIND_LABEL[t.taskKind] ?? t.taskKind}任务</Tag>}
          <button className="icon-btn" onClick={onClose} aria-label="关闭"><IconClose size={17} /></button>
        </div>

        <div className="drawer-body">
          {/* 概览 */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 14,
            padding: '14px 16px', marginBottom: 22,
            background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 'var(--r-md)',
          }}>
            <Meta label="负责人">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <Avatar person={detail.owner} size={20} />
                {detail.owner?.name ?? t.ownerId}
              </span>
            </Meta>
            <Meta label="来源">{SOURCE_LABEL[t.source] ?? t.source}</Meta>
            <Meta label="识别置信度">{(t.confidence * 100).toFixed(0)}%</Meta>
            <Meta label="创建时间">{fmtDate(t.createdAt)}</Meta>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, alignItems: 'start' }}>
            {/* 左：调整 */}
            <div>
              <div className="drawer-sec"><IconQuadrant size={13} />象限</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 22 }}>
                {QUADS.map((q) => {
                  const on = activeQuad === q.key;
                  return (
                    <button
                      key={q.key}
                      className="quad-pick"
                      disabled={saving}
                      style={on
                        ? { borderColor: q.color, background: q.bg, color: q.color, fontWeight: 600 }
                        : undefined}
                      onClick={() => apply({ important: q.important, urgent: q.urgent })}
                    >
                      {q.title}
                    </button>
                  );
                })}
              </div>

              <div className="drawer-sec">截止时间</div>
              <div style={{ marginBottom: 22 }}>
                <TimeField
                  className="field"
                  kind="datetime-local"
                  commitOn="blur"
                  empty="+ 设置截止时间"
                  value={toDateTimeInput(t.dueAt)}
                  display={t.dueAt ? `${fmtDay(t.dueAt)} ${fmtTime(t.dueAt)}` : ''}
                  disabled={saving}
                  onCommit={(v) => {
                    const iso = new Date(v).toISOString();
                    if (iso !== t.dueAt) apply({ dueAt: iso });
                  }}
                />
              </div>

              <div className="drawer-sec"><IconBot size={13} />执行历史 · {detail.runs.length} 次</div>
              <div style={{ maxHeight: 190, overflowY: 'auto', marginBottom: 22 }}>
                {detail.runs.length === 0 && <Empty tight>分身还没开工</Empty>}
                {detail.runs.map((r) => {
                  const rs = RUN_STATUS[r.status] ?? { label: r.status, tone: 'gray' as const };
                  const secs = r.finishedAt
                    ? Math.round((new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000)
                    : null;
                  return (
                    <div className="run-row" key={r.id}>
                      <Tag tone={rs.tone}>第 {r.iteration} 稿 · {rs.label}</Tag>
                      <span style={{ color: 'var(--ink-4)' }}>
                        {r.engine === 'opencode' ? 'OpenCode' : '内置引擎'} · {fmtDate(r.startedAt)}
                        {secs !== null && ` · ${secs}s`}
                      </span>
                    </div>
                  );
                })}
              </div>

              {t.status !== 'cancelled' ? (
                <button className="btn danger sm" disabled={saving} onClick={() => apply({ status: 'cancelled' })}>
                  取消任务
                </button>
              ) : (
                <button className="btn sm" disabled={saving} onClick={() => apply({ status: 'todo' })}>
                  重新打开
                </button>
              )}
            </div>

            {/* 右：沙箱 */}
            <div>
              <div className="drawer-sec"><IconFile size={13} />沙箱透视</div>
              {detail.sandbox && (
                <div style={{
                  padding: '10px 12px', marginBottom: 12,
                  background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)',
                  fontSize: 11.5, lineHeight: 1.65, color: 'var(--ink-4)',
                }}>
                  <code style={{ color: 'var(--ink-2)' }}>{detail.sandbox.dir}</code>
                  <div style={{ marginTop: 3 }}>{detail.sandbox.note}</div>
                </div>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 12 }}>
                {detail.sandboxFiles.map((f) => (
                  <button
                    key={f.path}
                    className={`btn xs ${preview?.name === f.name ? 'primary' : ''}`}
                    disabled={!f.exists}
                    onClick={() => openFile(f)}
                  >
                    {f.name}{!f.exists && '（未生成）'}
                  </button>
                ))}
                {doc && (
                  <a href={doc.href} target={doc.external ? '_blank' : undefined} rel="noreferrer">
                    <button className="btn xs blue">产出文档</button>
                  </a>
                )}
              </div>
              {preview
                ? (
                  <>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-3)', marginBottom: 6 }}>
                      {preview.name}
                    </div>
                    <div className="pre" style={{ maxHeight: 420 }}>{preview.content}</div>
                  </>
                )
                : <Empty tight icon={<IconFile size={18} />}>点上方文件名远程查看沙箱内容</Empty>}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11.5, color: 'var(--ink-4)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 500 }}>{children}</div>
    </div>
  );
}

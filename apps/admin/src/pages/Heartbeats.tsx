import { useState } from 'react';
import type { Heartbeat, Person } from '@everyone/shared';
import type { AppState } from '../lib/api';
import { del, patch, post, useToast } from '../lib/api';
import { fmtDate } from '../lib/format';
import { Empty, IconPulse, Modal, Tag, Toast } from '../ui';

/**
 * 心跳任务管理（需求 7）：查看/编辑触发时间、频率、需求；确认/暂停/恢复/删除。
 * 成员只看自己创建的；管理员看全部。
 */

const STATUS_META: Record<Heartbeat['status'], { label: string; tone: 'blue' | 'green' | 'orange' | 'gray' | 'red' }> = {
  pending_confirm: { label: '待确认', tone: 'orange' },
  active: { label: '运行中', tone: 'green' },
  paused: { label: '已暂停', tone: 'gray' },
  done: { label: '已完成', tone: 'blue' },
  cancelled: { label: '已取消', tone: 'red' },
};

function fmtInterval(min: number): string {
  if (min <= 0) return '一次性';
  if (min % 10080 === 0) return `每 ${min / 10080} 周`;
  if (min % 1440 === 0) return `每 ${min / 1440} 天`;
  if (min % 60 === 0) return `每 ${min / 60} 小时`;
  return `每 ${min} 分钟`;
}

/** ISO → datetime-local 控件值（本地时区） */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface EditState {
  id: string;
  requirement: string;
  nextRunAt: string; // datetime-local
  intervalMin: number;
  totalRuns: number;
}

export function Heartbeats({ state, me, isAdmin, refresh }: {
  state: AppState;
  me: Person | null;
  isAdmin: boolean;
  refresh: () => void;
}) {
  const { toast, show } = useToast();
  const [edit, setEdit] = useState<EditState | null>(null);
  const list = isAdmin ? state.heartbeats : state.heartbeats.filter((h) => h.creatorId === me?.id);
  const personName = (id: string) => state.persons.find((p) => p.id === id)?.name ?? id;

  const confirm = async (h: Heartbeat) => {
    await post(`/api/heartbeat/${h.id}/confirm`);
    show('已确认启动，按计划触发');
    refresh();
  };
  const setStatus = async (h: Heartbeat, status: 'active' | 'paused') => {
    await patch(`/api/heartbeat/${h.id}`, { status });
    show(status === 'paused' ? '已暂停' : '已恢复');
    refresh();
  };
  const remove = async (h: Heartbeat) => {
    if (!window.confirm(`删除心跳任务「${h.requirement.slice(0, 30)}…」？`)) return;
    await del(`/api/heartbeat/${h.id}`);
    show('已删除');
    refresh();
  };
  const saveEdit = async () => {
    if (!edit) return;
    const body: Record<string, unknown> = {
      requirement: edit.requirement,
      intervalMin: edit.intervalMin,
      totalRuns: edit.totalRuns,
    };
    if (edit.nextRunAt) body.nextRunAt = new Date(edit.nextRunAt).toISOString();
    const r = await patch<{ ok?: boolean; error?: string }>(`/api/heartbeat/${edit.id}`, body);
    if (r?.error) {
      show(r.error);
      return;
    }
    setEdit(null);
    show('心跳任务已更新');
    refresh();
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>心跳任务</h1>
          <div className="desc">
            定时唤醒的例行 Agent 任务（每个任务有独立沙箱）· 跟 Everyone 说「每天早上 9 点推送……」即可创建，确认后生效
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-body">
          {list.length === 0
            ? (
              <Empty icon={<IconPulse size={20} />} title="还没有心跳任务">
                在群里或私聊对 Everyone 说：「每天早上 9 点推送我今天要完成的任务和快到期的需求」
              </Empty>
            )
            : (
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>任务需求</th>
                      {isAdmin && <th style={{ width: 88 }}>创建人</th>}
                      <th style={{ width: 110 }}>频率</th>
                      <th style={{ width: 96 }}>次数</th>
                      <th style={{ width: 130 }}>下次触发</th>
                      <th style={{ width: 92 }}>状态</th>
                      <th style={{ width: 218 }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((h) => {
                      const st = STATUS_META[h.status];
                      return (
                        <tr key={h.id}>
                          <td>
                            <div style={{ fontWeight: 500 }}>{h.requirement.slice(0, 60)}{h.requirement.length > 60 ? '…' : ''}</div>
                            {h.lastRunAt && (
                              <div style={{ color: 'var(--ink-4)', fontSize: 12, marginTop: 2 }}>
                                上次 {fmtDate(h.lastRunAt)}：{(h.lastSummary ?? '').slice(0, 50)}
                              </div>
                            )}
                          </td>
                          {isAdmin && <td>{personName(h.creatorId)}</td>}
                          <td className="num">{fmtInterval(h.intervalMin)}</td>
                          <td className="num">{h.runsDone}/{h.totalRuns === 0 ? '∞' : h.totalRuns}</td>
                          <td className="num">{h.nextRunAt ? fmtDate(h.nextRunAt) : '—'}</td>
                          <td><Tag tone={st.tone} dot={h.status === 'active'}>{st.label}</Tag></td>
                          <td>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              {h.status === 'pending_confirm' && (
                                <button className="btn xs primary" onClick={() => confirm(h)}>确认启动</button>
                              )}
                              {h.status === 'active' && (
                                <button className="btn xs" onClick={() => setStatus(h, 'paused')}>暂停</button>
                              )}
                              {h.status === 'paused' && (
                                <button className="btn xs" onClick={() => setStatus(h, 'active')}>恢复</button>
                              )}
                              {['pending_confirm', 'active', 'paused'].includes(h.status) && (
                                <button
                                  className="btn xs"
                                  onClick={() => setEdit({
                                    id: h.id,
                                    requirement: h.requirement,
                                    nextRunAt: toLocalInput(h.nextRunAt ?? h.firstAt),
                                    intervalMin: h.intervalMin,
                                    totalRuns: h.totalRuns,
                                  })}
                                >
                                  编辑
                                </button>
                              )}
                              {h.status !== 'cancelled' && (
                                <button className="btn xs danger" onClick={() => remove(h)}>删除</button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      </div>

      {edit && (
        <Modal
          title="编辑心跳任务"
          onClose={() => setEdit(null)}
          footer={
            <>
              <button className="btn" onClick={() => setEdit(null)}>取消</button>
              <button className="btn primary" onClick={saveEdit} disabled={!edit.requirement.trim()}>保存</button>
            </>
          }
        >
          <div className="sec-title">任务需求（触发时原样发给执行 Agent）</div>
          <textarea
            className="field mono" rows={5} value={edit.requirement} spellCheck={false}
            onChange={(e) => setEdit({ ...edit, requirement: e.target.value })}
          />
          <div className="grid c3" style={{ marginTop: 12, gap: 10 }}>
            <div>
              <div className="sec-title">下次触发</div>
              <input
                className="field" type="datetime-local" value={edit.nextRunAt}
                onChange={(e) => setEdit({ ...edit, nextRunAt: e.target.value })}
              />
            </div>
            <div>
              <div className="sec-title">间隔（分钟）</div>
              <input
                className="field" type="number" min={0} value={edit.intervalMin}
                title="0 = 一次性；每天 = 1440，每周 = 10080"
                onChange={(e) => setEdit({ ...edit, intervalMin: Number(e.target.value) })}
              />
            </div>
            <div>
              <div className="sec-title">总次数（0 = 无限）</div>
              <input
                className="field" type="number" min={0} value={edit.totalRuns}
                onChange={(e) => setEdit({ ...edit, totalRuns: Number(e.target.value) })}
              />
            </div>
          </div>
          <div className="ab-note" style={{ marginTop: 10 }}>
            改「下次触发」会把后续排期的起点一并挪过去；间隔 ≥5 分钟（每天 = 1440）。
          </div>
        </Modal>
      )}

      <Toast text={toast} />
    </div>
  );
}

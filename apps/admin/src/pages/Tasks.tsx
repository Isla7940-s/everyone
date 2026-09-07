import { useMemo, useState } from 'react';
import type { Person } from '@everyone/shared';
import type { AppState } from '../lib/api';
import { patch } from '../lib/api';
import {
  docLink, fmtDue, KIND_LABEL, quadSpecOf, SOURCE_SHORT, STATUS, statusOf,
} from '../lib/format';
import { TaskDrawer } from '../components/TaskDrawer';
import { Avatar, Empty, IconLink, IconTask, SearchInput, Tag } from '../ui';

/**
 * 任务台账。管理员看全员、可批量管理；成员只看自己的，也没有批量操作。
 */
export function Tasks({ state, me, refresh, isAdmin }: {
  state: AppState;
  me: Person | null;
  refresh: () => void;
  isAdmin: boolean;
}) {
  const { tasks, persons } = state;
  const [owner, setOwner] = useState('all');
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');
  const [drawer, setDrawer] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const person = (id: string) => persons.find((p) => p.id === id);

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    const visible = isAdmin ? tasks : tasks.filter((t) => t.ownerId === me?.id);
    return visible.filter((t) =>
      (!isAdmin || owner === 'all' || t.ownerId === owner)
      && (status === 'all' || t.status === status)
      && (!kw || t.title.toLowerCase().includes(kw)),
    );
  }, [tasks, owner, status, q, me?.id, isAdmin]);

  const selectable = filtered.filter((t) => t.status !== 'cancelled' && t.status !== 'published');
  const allChecked = selectable.length > 0 && selectable.every((t) => selected.has(t.id));

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const bulkCancel = async () => {
    if (!selected.size || !window.confirm(`批量取消 ${selected.size} 条任务？（可在详情里逐条重新打开）`)) return;
    setBusy(true);
    try {
      for (const id of selected) await patch(`/api/task/${id}`, { status: 'cancelled' }).catch(() => {});
      setSelected(new Set());
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{isAdmin ? '任务台账' : '我的任务'}</h1>
          <div className="desc">
            {isAdmin
              ? 'SQLite 为事实源，实时镜像到飞书多维表格 · 点任务行可调整象限、截止与沙箱透视'
              : '你名下的全部任务 · 点任务行可调整象限、截止，并透视分身在沙箱里的产物'}
          </div>
        </div>
        <div className="actions">
          {state.bitable?.url && isAdmin && (
            <a href={state.bitable.url} target="_blank" rel="noreferrer">
              <button className="btn"><IconLink size={14} />打开多维表格</button>
            </a>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-body">
          <div className="filters">
            {isAdmin && (
              <select className="field" style={{ width: 140 }} value={owner} onChange={(e) => setOwner(e.target.value)}>
                <option value="all">全部负责人</option>
                {persons.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
            <select className="field" style={{ width: 148 }} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="all">全部状态</option>
              {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <SearchInput value={q} onChange={setQ} placeholder="搜索任务标题" width={220} />
            {isAdmin && selected.size > 0
              ? (
                <button className="btn danger sm" style={{ marginLeft: 'auto' }} disabled={busy} onClick={bulkCancel}>
                  {busy ? '取消中…' : `批量取消 ${selected.size} 条`}
                </button>
              )
              : <span className="count">{filtered.length} 条</span>}
          </div>

          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  {isAdmin && (
                    <th style={{ width: 36 }}>
                      <input
                        className="check" type="checkbox" checked={allChecked}
                        title="全选（不含已发布 / 已取消）"
                        onChange={() => setSelected(allChecked ? new Set() : new Set(selectable.map((t) => t.id)))}
                      />
                    </th>
                  )}
                  <th>任务</th>
                  {isAdmin && <th className="col-sec" style={{ width: 108 }}>负责人</th>}
                  <th className="col-sec" style={{ width: 78 }}>来源</th>
                  <th className="col-sec" style={{ width: 66 }}>类型</th>
                  <th style={{ width: 112 }}>状态</th>
                  <th className="col-sec2" style={{ width: 128 }}>象限</th>
                  <th style={{ width: 104 }}>截止</th>
                  <th className="col-sec2" style={{ width: 62 }}>产出</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => {
                  const st = statusOf(t.status);
                  const due = fmtDue(t.dueAt);
                  const quad = quadSpecOf(t);
                  const owner = person(t.ownerId);
                  const doc = docLink(t);
                  return (
                    <tr key={t.id} className="rowlink" onClick={() => setDrawer(t.id)}>
                      {isAdmin && (
                        <td onClick={(e) => e.stopPropagation()}>
                          <input
                            className="check" type="checkbox"
                            disabled={t.status === 'cancelled' || t.status === 'published'}
                            checked={selected.has(t.id)}
                            onChange={() => toggle(t.id)}
                          />
                        </td>
                      )}
                      <td style={{ fontWeight: 500, maxWidth: 340 }}>{t.title}</td>
                      {isAdmin && (
                        <td className="col-sec">
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                            <Avatar person={owner} size={20} />
                            {owner?.name ?? t.ownerId}
                          </span>
                        </td>
                      )}
                      <td className="num col-sec">{SOURCE_SHORT[t.source] ?? t.source}</td>
                      <td className="num col-sec">{t.taskKind ? KIND_LABEL[t.taskKind] ?? t.taskKind : '—'}</td>
                      <td><Tag tone={st.tone} dot>{st.label}</Tag></td>
                      <td className="col-sec2">
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: quad.color }}>
                          <span style={{ width: 3, height: 14, borderRadius: 2, background: quad.color }} />
                          {quad.title}
                        </span>
                      </td>
                      <td><Tag tone={due.tone}>{due.text}</Tag></td>
                      <td className="col-sec2" onClick={(e) => e.stopPropagation()}>
                        {doc
                          ? <a href={doc.href} target={doc.external ? '_blank' : undefined} rel="noreferrer">查看</a>
                          : <span style={{ color: 'var(--ink-5)' }}>—</span>}
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={isAdmin ? 9 : 7}>
                      <Empty icon={<IconTask size={20} />} title="没有匹配的任务">
                        {isAdmin
                          ? '换个筛选条件看看'
                          : q || status !== 'all' ? '换个筛选条件看看' : '到群里许个承诺，分身就会把它记下来'}
                      </Empty>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {drawer && <TaskDrawer taskId={drawer} onClose={() => setDrawer(null)} onChanged={refresh} />}
    </div>
  );
}

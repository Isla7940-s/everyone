import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Person, PierceWeek } from '@everyone/shared';
import type { AppState } from '../lib/api';
import { get } from '../lib/api';
import { Avatar, Empty, IconChevronRight, IconClock, Tag } from '../ui';

/**
 * 时间穿透图（跨端协同.md §十三）：
 * 按周查看，每天一根柱状图，柱内按大需求分层；点击某层逐级下钻：
 * 大需求 → 子任务 → 工作会话（25 字短总结 / 100 字详细总结）。
 * 管理员可切换查看团队任一成员；成员只看自己。
 */

const PALETTE = ['#3370FF', '#34C724', '#FF8800', '#7B67EE', '#F54A45', '#14C0FF', '#F8B425', '#00B896', '#E85CCD', '#8A96A3'];

/** 需求名 → 稳定配色（跨周一致） */
function colorOf(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const fmtMin = (m: number) => (m >= 60 ? `${(m / 60).toFixed(m % 60 ? 1 : 0)}h` : `${m}m`);
const fmtRange = (s: string | null, e: string | null) => {
  const t = (iso: string) => iso.slice(11, 16);
  if (s && e) return `${t(s)}–${t(e)}`;
  if (s) return `${t(s)} 起`;
  return '';
};

function shiftWeek(weekStart: string, delta: number): string {
  const d = new Date(`${weekStart}T00:00:00`);
  d.setDate(d.getDate() + delta * 7);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface Overview {
  weekStart: string;
  members: Array<{ personId: string; name: string; avatarColor?: string; totalMinutes: number; dayMinutes: number[] }>;
}

export function TimePierce({ state, me, isAdmin }: { state: AppState; me: Person | null; isAdmin: boolean }) {
  const [personId, setPersonId] = useState<string>(me?.id ?? state.persons[0]?.id ?? '');
  const [week, setWeek] = useState<string | null>(null); // null = 本周
  const [data, setData] = useState<PierceWeek | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [sel, setSel] = useState<{ date: string; req: string } | null>(null);

  const load = useCallback(async () => {
    if (!personId) return;
    const qs = new URLSearchParams({ personId });
    if (week) qs.set('week', week);
    const w = await get<PierceWeek>(`/api/collab/admin/pierce?${qs}`);
    setData(w);
    setSel(null);
    if (isAdmin) {
      setOverview(await get<Overview>(`/api/collab/admin/overview${week ? `?week=${week}` : ''}`));
    }
  }, [personId, week, isAdmin]);

  useEffect(() => { load().catch(() => setData(null)); }, [load]);

  const person = state.persons.find((p) => p.id === personId) ?? null;
  const maxDay = useMemo(
    () => Math.max(...(data?.days.map((d) => d.totalMinutes) ?? [0]), 6 * 60),
    [data],
  );
  const legend = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of data?.days ?? []) {
      for (const r of d.requirements) map.set(r.name, (map.get(r.name) ?? 0) + r.minutes);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);

  const selDay = sel ? data?.days.find((d) => d.date === sel.date) : null;
  const selReq = sel && selDay ? selDay.requirements.find((r) => r.name === sel.req) : null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>时间穿透</h1>
          <div className="desc">
            本地 AI 工作时间的周视图 · 每根柱子按大需求分层，点击色块下钻到子任务与工作会话
            {isAdmin ? '（管理员可查看全部成员）' : ''}
          </div>
        </div>
        <div className="actions" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn" onClick={() => setWeek(shiftWeek(data?.weekStart ?? new Date().toISOString().slice(0, 10), -1))}>← 上一周</button>
          <button className="btn" onClick={() => setWeek(null)}>本周</button>
          <button className="btn" onClick={() => setWeek(shiftWeek(data?.weekStart ?? new Date().toISOString().slice(0, 10), 1))}>下一周 →</button>
        </div>
      </div>

      {isAdmin && overview && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-body" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {overview.members.map((m) => (
              <button
                key={m.personId}
                className={`pierce-member ${m.personId === personId ? 'on' : ''}`}
                onClick={() => setPersonId(m.personId)}
              >
                <Avatar person={state.persons.find((p) => p.id === m.personId)} size={24} />
                <span>{m.name}</span>
                <span className="pm-total">{m.totalMinutes ? fmtMin(m.totalMinutes) : '—'}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-body">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
            <b>{person?.name ?? personId}</b>
            <span style={{ color: 'var(--ink-4)', fontSize: 13 }}>
              {data ? `${data.weekStart} ~ ${data.weekEnd} · 合计 ${fmtMin(data.totalMinutes)}` : '加载中…'}
            </span>
          </div>

          {data && data.totalMinutes === 0 && (
            <Empty icon={<IconClock size={20} />} title="这一周还没有时间记录">
              本地 Agent 上传工作总结后，用 <code>everyone time draft</code> 生成时间去向草稿，本人确认后正式上传即可在这里看到。
            </Empty>
          )}

          {data && data.totalMinutes > 0 && (
            <>
              <div className="pierce-chart">
                {data.days.map((d) => (
                  <div className="pierce-day" key={d.date}>
                    <div className="pd-total">{d.totalMinutes ? fmtMin(d.totalMinutes) : ''}</div>
                    <div className="pd-bar">
                      {d.requirements.map((r) => (
                        <div
                          key={r.name}
                          className={`pd-seg ${sel?.date === d.date && sel.req === r.name ? 'on' : ''}`}
                          style={{
                            height: Math.max(Math.round((r.minutes / maxDay) * 220), 6),
                            background: colorOf(r.name),
                          }}
                          title={`${r.name} · ${fmtMin(r.minutes)}（点击查看明细）`}
                          onClick={() => setSel(sel?.date === d.date && sel.req === r.name ? null : { date: d.date, req: r.name })}
                        />
                      ))}
                    </div>
                    <div className="pd-label">
                      <b>{d.weekday}</b>
                      <span>{d.date.slice(5)}</span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="pierce-legend">
                {legend.map(([name, minutes]) => (
                  <span key={name} className="pl-item" onClick={() => {
                    const day = data.days.find((d) => d.requirements.some((r) => r.name === name));
                    if (day) setSel({ date: day.date, req: name });
                  }}>
                    <span className="pl-dot" style={{ background: colorOf(name) }} />
                    {name} · {fmtMin(minutes)}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {selReq && selDay && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="card-body">
            <div className="pierce-crumb">
              <span>{selDay.date}（{selDay.weekday}）</span>
              <IconChevronRight size={13} />
              <span className="pl-dot" style={{ background: colorOf(selReq.name), marginRight: 4 }} />
              <b>{selReq.name}</b>
              <span style={{ color: 'var(--ink-4)' }}>· {fmtMin(selReq.minutes)}</span>
              <span className="spacer" />
              <button className="btn xs" onClick={() => setSel(null)}>收起</button>
            </div>
            {selReq.subtasks.map((st) => (
              <div key={st.name} className="pierce-sub">
                <div className="ps-head">
                  <IconChevronRight size={12} />
                  <b>{st.name}</b>
                  <span style={{ color: 'var(--ink-4)', fontSize: 12 }}>{fmtMin(st.minutes)} · {st.entries.length} 段</span>
                </div>
                {st.entries.map((e) => (
                  <div key={e.id} className="pierce-entry">
                    <div className="pe-meta">
                      <span className="pe-time">{fmtRange(e.startedAt, e.endedAt) || '时长'} · {fmtMin(e.minutes)}</span>
                      {e.sourceTool && <Tag tone="blue">{e.sourceTool}</Tag>}
                      {e.sessionId && <code className="pe-sid" title="工作会话 ID（原文在本人本地）">{e.sessionId}</code>}
                    </div>
                    {e.briefSummary && <div className="pe-brief">{e.briefSummary}</div>}
                    {e.detailSummary && <div className="pe-detail">{e.detailSummary}</div>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

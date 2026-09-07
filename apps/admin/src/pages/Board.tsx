import { useMemo, useState } from 'react';
import type { ActivityEvent } from '@everyone/shared';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AppState } from '../lib/api';
import { patch } from '../lib/api';
import { isAlive, isOpen, QUADS, quadrantOf, TONE_HEX } from '../lib/format';
import { ActivityFeed } from '../components/ActivityFeed';
import { Schedule, useSevenDays } from '../components/Schedule';
import { TaskDrawer } from '../components/TaskDrawer';
import {
  Empty, IconActivity, IconBot, IconClock, IconGrid, IconQuadrant, IconTrend, Stat,
} from '../ui';

/** 全局视图：全群四象限、排期甘特、任务趋势、实时活动流 */
export function Board({ state, activities, refresh }: {
  state: AppState;
  activities: ActivityEvent[];
  refresh: () => void;
}) {
  const { tasks, persons, runs } = state;
  const [drawer, setDrawer] = useState<string | null>(null);
  const personName = (id: string) => persons.find((p) => p.id === id)?.name ?? id;
  const open = tasks.filter(isOpen);
  const working = tasks.filter((t) => t.status === 'running' || t.status === 'reviewing');

  const stats = [
    { label: '总任务', value: tasks.filter(isAlive).length, hex: TONE_HEX.gray, hint: '不含已取消' },
    { label: '待办', value: tasks.filter((t) => t.status === 'todo' || t.status === 'pending_confirm').length, hex: TONE_HEX.blue, hint: '含待确认' },
    { label: '分身进行中', value: working.length, hex: TONE_HEX.purple, hint: '写作与待审阅' },
    { label: '已发布', value: tasks.filter((t) => t.status === 'published').length, hex: TONE_HEX.green, hint: '经人工拍板' },
    { label: '承诺完成率', value: state.completionRate, hex: TONE_HEX.orange, hint: '按到期时间统计' },
  ];

  const trend = useMemo(() => {
    const byDay = new Map<string, { day: string; created: number; published: number }>();
    for (const t of tasks) {
      const day = t.createdAt.slice(5, 10);
      const e = byDay.get(day) ?? { day, created: 0, published: 0 };
      e.created++;
      if (t.status === 'published') e.published++;
      byDay.set(day, e);
    }
    return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-14);
  }, [tasks]);

  const days = useSevenDays();

  const setDue = async (taskId: string, dateStr: string) => {
    if (!dateStr) return;
    await patch(`/api/task/${taskId}`, { dueAt: new Date(`${dateStr}T18:00:00`).toISOString() });
    refresh();
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>全局视图</h1>
          <div className="desc">群里的承诺自动涌现为任务，分身替人完成——这里是全团队的一张图</div>
        </div>
      </div>

      <div className="stats">
        {stats.map((s) => <Stat key={s.label} {...s} />)}
      </div>

      {/* Agent 运行中（需求 2：分身任务 + 超级代理本体的运行都在这里） */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <span className="ct"><IconBot size={16} color="var(--purple)" />Agent 运行中</span>
          <span className="cs">分身任务、Agent 对话、心跳——所有正在跑的 Agent · 点击看沙箱或轨迹</span>
        </div>
        <div className="card-body">
          {(() => {
            const liveRuns = (state.agentRuns ?? []).filter((r) => r.status === 'running');
            const liveTaskIds = new Set(liveRuns.map((r) => r.taskId).filter(Boolean));
            // 正在执行的任务由 agentRuns 呈现；这里补充「待审阅」的任务卡（分身干完等本人拍板）
            const reviewingOnly = working.filter((t) => !liveTaskIds.has(t.id) && t.status === 'reviewing');
            const runningTasksNoAgent = working.filter((t) => t.status === 'running' && !liveTaskIds.has(t.id));
            if (!liveRuns.length && !reviewingOnly.length && !runningTasksNoAgent.length) {
              return <Empty tight icon={<IconBot size={19} />} title="当前没有 Agent 在干活">群里许个承诺、@Everyone 让它动手做事、或等心跳任务到点</Empty>;
            }
            const MODE_LABEL: Record<string, string> = { chat: 'Agent 对话', task: '分身任务', heartbeat: '心跳任务' };
            return (
              <div className="takeover">
                {liveRuns.map((r) => (
                  <div
                    className="tk-card" key={r.id}
                    onClick={() => {
                      if (r.taskId) setDrawer(r.taskId);
                      else window.location.hash = `#/traces?run=${r.id}`;
                    }}
                  >
                    <div className="tkt"><span className="pulse" />{r.label}</div>
                    <div className="tkm">
                      <span>{MODE_LABEL[r.mode] ?? r.mode}</span>
                      {r.personName && <span>{r.personName}</span>}
                      <span>OpenCode · {r.taskId ? '点击看任务' : '点击看轨迹'}</span>
                    </div>
                  </div>
                ))}
                {[...runningTasksNoAgent, ...reviewingOnly].map((t) => {
                  const run = runs.find((r) => r.taskId === t.id);
                  return (
                    <div className="tk-card" key={t.id} onClick={() => setDrawer(t.id)}>
                      <div className="tkt">{t.status === 'running' && <span className="pulse" />}{t.title}</div>
                      <div className="tkm">
                        <span>{personName(t.ownerId)} 的分身</span>
                        <span>{t.status === 'running' ? `第 ${run?.iteration ?? 1} 稿写作中` : `第 ${run?.iteration ?? 1} 稿待审阅`}</span>
                        <span>{run?.engine === 'builtin' ? '内置引擎' : 'OpenCode'}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        {/* 四象限 */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <span className="ct"><IconQuadrant size={16} color="var(--red)" />全群四象限</span>
            <span className="cs">点任务可调整象限与截止</span>
          </div>
          <div className="card-body">
            <div className="quads">
              {QUADS.map((q) => {
                const list = open.filter((t) => quadrantOf(t) === q.key);
                return (
                  <div className="quad" key={q.key} style={{ background: q.bg }}>
                    <div className="qh" style={{ color: q.color }}>
                      {q.title}
                      <span className="qhint">{q.hint}</span>
                    </div>
                    {list.slice(0, 5).map((t) => (
                      <div className="qrow" key={t.id} onClick={() => setDrawer(t.id)}>
                        <span className="qn">{t.title}</span>
                        <span className="qo">{personName(t.ownerId)}</span>
                      </div>
                    ))}
                    {list.length > 5 && <div className="qmore" style={{ color: q.color }}>+{list.length - 5} 项</div>}
                    {list.length === 0 && <div className="qrow" style={{ color: 'var(--ink-5)', cursor: 'default' }}>暂无</div>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* 排期：全宽，7 天格子才排得开 */}
        <div className="card">
          <div className="card-head">
            <span className="ct"><IconClock size={16} color="var(--blue)" />全员排期</span>
            <span className="cs">未来 7 天 · 行内直接改截止日</span>
          </div>
          <div className="card-body">
            <Schedule
              tasks={tasks} persons={persons} days={days} limit={12} editable
              onOpen={setDrawer} onDue={setDue}
            />
          </div>
        </div>
      </div>

      <div className="grid c2">
        {/* 趋势 */}
        <div className="card">
          <div className="card-head">
            <span className="ct"><IconTrend size={16} color="var(--green)" />任务量与发布趋势</span>
            <span className="cs">按创建日 · 近 14 天</span>
          </div>
          <div className="card-body">
            {trend.length === 0
              ? <Empty tight icon={<IconGrid size={19} />}>还没有数据</Empty>
              : (
                <ResponsiveContainer width="100%" height={244}>
                  <AreaChart data={trend} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
                    <defs>
                      <linearGradient id="gCreated" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#3370ff" stopOpacity={0.2} />
                        <stop offset="100%" stopColor="#3370ff" stopOpacity={0.01} />
                      </linearGradient>
                      <linearGradient id="gPub" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#34c724" stopOpacity={0.22} />
                        <stop offset="100%" stopColor="#34c724" stopOpacity={0.01} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#ececf1" vertical={false} />
                    <XAxis dataKey="day" tick={{ fontSize: 11.5, fill: '#9a9aa8' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11.5, fill: '#9a9aa8' }} axisLine={false} tickLine={false} allowDecimals={false} width={38} />
                    <Tooltip
                      contentStyle={{
                        borderRadius: 12, border: '1px solid #ececf1', fontSize: 12.5,
                        boxShadow: '0 4px 16px rgba(13,13,13,.07)', padding: '8px 12px',
                      }}
                    />
                    <Area
                      type="monotone" dataKey="created" name="新建任务" stroke="#3370ff" strokeWidth={2}
                      fill="url(#gCreated)" dot={{ r: 2.5, strokeWidth: 0, fill: '#3370ff' }} activeDot={{ r: 4 }}
                    />
                    <Area
                      type="monotone" dataKey="published" name="已发布" stroke="#34c724" strokeWidth={2}
                      fill="url(#gPub)" dot={{ r: 2.5, strokeWidth: 0, fill: '#34c724' }} activeDot={{ r: 4 }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            {trend.length === 1 && (
              <div className="chart-note">只有 1 天有任务活动，攒够 2 天才看得出趋势</div>
            )}
          </div>
        </div>

        {/* 活动流 */}
        <div className="card feed-card" style={{ maxHeight: 340 }}>
          <div className="card-head" style={{ paddingBottom: 14, borderBottom: '1px solid var(--line)' }}>
            <span className="ct"><IconActivity size={16} color="var(--blue)" />Agent 实时活动流</span>
            <span className="cs">{activities.length} 条</span>
          </div>
          <ActivityFeed activities={activities} />
        </div>
      </div>

      {drawer && <TaskDrawer taskId={drawer} onClose={() => setDrawer(null)} onChanged={refresh} />}
    </div>
  );
}


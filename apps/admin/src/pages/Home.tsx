import { useMemo, useState } from 'react';
import type { Person, Task } from '@everyone/shared';
import type { AppState } from '../lib/api';
import {
  ASSIST_STATUS, fmtDate, fmtDue, greeting, isOpen, QUADS, quadrantOf, quadSpecOf,
  SOURCE_SHORT, statusOf,
} from '../lib/format';
import { Schedule, useSevenDays } from '../components/Schedule';
import { TaskDrawer } from '../components/TaskDrawer';
import {
  Avatar, Empty, IconAnswer, IconArrowRight, IconBot, IconCheck, IconClock, IconInbox,
  IconQuadrant, IconSparkle, IconTask, Tag,
} from '../ui';

/** 排序：逾期最前，然后按截止升序，无截止排最后，同档按象限 */
function byUrgency(a: Task, b: Task): number {
  const at = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
  const bt = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
  if (at !== bt) return at - bt;
  return quadrantOf(a) - quadrantOf(b);
}

/** 我的工作台：以当前登录人为主体，回答「我现在该干什么」 */
export function Home({ state, me, refresh }: {
  state: AppState;
  me: Person;
  refresh: () => void;
}) {
  const [drawer, setDrawer] = useState<string | null>(null);
  const days = useSevenDays();
  const mine = useMemo(() => state.tasks.filter((t) => t.ownerId === me.id), [state.tasks, me.id]);

  const open = useMemo(() => mine.filter(isOpen).sort(byUrgency), [mine]);
  const needMe = open.filter((t) => t.status === 'pending_confirm' || t.status === 'reviewing');
  const working = mine.filter((t) => t.status === 'running' || t.status === 'reviewing');
  const published = mine.filter((t) => t.status === 'published');
  const overdue = open.filter((t) => t.dueAt && new Date(t.dueAt).getTime() < Date.now());
  const myAssists = state.assists.filter((a) => a.personId === me.id).slice(0, 8);
  const latestRun = (taskId: string) => state.runs.find((r) => r.taskId === taskId);

  return (
    <div className="page">
      <div className="hero">
        <Avatar person={me} size={52} />
        <div className="htext">
          <div className="hhi">{greeting()}，{me.name}</div>
          <div className="hsub">
            {working.length > 0
              ? <>你的分身正在处理 {working.length} 件事{needMe.length > 0 && `，其中 ${needMe.length} 件等你拍板`}。</>
              : open.length > 0
                ? <>你有 {open.length} 件事在推进中，分身随时可以接手。</>
                : <>手头没有未完成的事。到群里许个承诺，分身就会自动开工。</>}
          </div>
        </div>
        <div className="hstat">
          <div>
            <div className="n">{open.length}</div>
            <div className="l">未完成</div>
          </div>
          <div>
            <div className="n" style={{ color: overdue.length ? 'var(--red)' : undefined }}>{overdue.length}</div>
            <div className="l">已逾期</div>
          </div>
          <div>
            <div className="n">{published.length}</div>
            <div className="l">已发布</div>
          </div>
        </div>
      </div>

      {/* 需要我拍板 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <span className="ct"><IconSparkle size={16} color="var(--orange)" />需要我拍板</span>
          <span className="cs">待确认入账、或分身已交初稿等你过目</span>
        </div>
        <div className="card-body">
          {needMe.length === 0
            ? <Empty tight icon={<IconCheck size={19} />} title="没有待你处理的事">分身有需要确认的动作时，会在这里出现，同时给你发飞书私信</Empty>
            : (
              <div className="tasklist">
                {needMe.map((t) => <TaskRow key={t.id} task={t} onOpen={() => setDrawer(t.id)} />)}
              </div>
            )}
        </div>
      </div>

      <div className="grid c2" style={{ marginBottom: 16 }}>
        {/* 我的任务 */}
        <div className="card">
          <div className="card-head">
            <span className="ct"><IconTask size={16} color="var(--blue)" />我的任务</span>
            <a className="cs" href="#/tasks">看全部台账 <IconArrowRight size={11} /></a>
          </div>
          <div className="card-body">
            {open.length === 0
              ? <Empty tight icon={<IconTask size={19} />} title="暂无未完成任务">在群里说「周五前我把 XX 发出来」试试</Empty>
              : (
                <div className="tasklist">
                  {open.slice(0, 8).map((t) => <TaskRow key={t.id} task={t} onOpen={() => setDrawer(t.id)} />)}
                </div>
              )}
          </div>
        </div>

        {/* 我的四象限 */}
        <div className="card">
          <div className="card-head">
            <span className="ct"><IconQuadrant size={16} color="var(--red)" />我的四象限</span>
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
                    {list.slice(0, 4).map((t) => (
                      <div className="qrow" key={t.id} onClick={() => setDrawer(t.id)}>
                        <span className="qn">{t.title}</span>
                      </div>
                    ))}
                    {list.length > 4 && <div className="qmore" style={{ color: q.color }}>+{list.length - 4} 项</div>}
                    {list.length === 0 && <div className="qrow" style={{ color: 'var(--ink-5)', cursor: 'default' }}>暂无</div>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="grid c2">
        {/* Agent 运行中（需求 2：分身任务 + 我触发的超级代理运行统一在这里） */}
        <div className="card">
          <div className="card-head">
            <span className="ct"><IconBot size={16} color="var(--purple)" />Agent 运行中</span>
            <a className="cs" href="#/traces">看运行轨迹 <IconArrowRight size={11} /></a>
          </div>
          <div className="card-body">
            {(() => {
              const myLive = (state.agentRuns ?? []).filter((r) => r.status === 'running' && r.personId === me.id);
              const liveTaskIds = new Set(myLive.map((r) => r.taskId).filter(Boolean));
              const rest = working.filter((t) => !liveTaskIds.has(t.id));
              if (!myLive.length && !rest.length) {
                return <Empty tight icon={<IconBot size={19} />} title="Agent 待命中">承诺确认入账后分身自动开工；@Everyone 让它动手做事也会出现在这里</Empty>;
              }
              const MODE_LABEL: Record<string, string> = { chat: 'Agent 对话', task: '分身任务', heartbeat: '心跳任务' };
              return (
                <div className="takeover">
                  {myLive.map((r) => (
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
                        <span>OpenCode · {r.taskId ? '点击看任务' : '点击看轨迹'}</span>
                      </div>
                    </div>
                  ))}
                  {rest.map((t) => {
                    const run = latestRun(t.id);
                    return (
                      <div className="tk-card" key={t.id} onClick={() => setDrawer(t.id)}>
                        <div className="tkt">{t.status === 'running' && <span className="pulse" />}{t.title}</div>
                        <div className="tkm">
                          <span>{t.status === 'running' ? `第 ${run?.iteration ?? 1} 稿写作中` : `第 ${run?.iteration ?? 1} 稿待你审阅`}</span>
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

        {/* 分身替我收 / 答 */}
        <div className="card">
          <div className="card-head">
            <span className="ct"><IconInbox size={16} color="var(--cyan)" />分身替我收 / 答</span>
            <span className="cs">群里归我管的意见、以我署名的代答</span>
          </div>
          <div className="card-body" style={{ paddingTop: 6 }}>
            {myAssists.length === 0
              ? <Empty tight icon={<IconAnswer size={19} />} title="还没有代收代答">别人在群里提到你负责的事，分身会记下来并私信你</Empty>
              : (
                <div className="tasklist">
                  {myAssists.map((a) => {
                    const st = ASSIST_STATUS[a.status] ?? { label: a.status, tone: 'gray' as const };
                    return (
                      <div className="task-row" key={a.id} style={{ cursor: 'default' }}>
                        <span style={{ color: a.type === 'collect' ? 'var(--orange)' : 'var(--cyan)', display: 'flex' }}>
                          {a.type === 'collect' ? <IconInbox size={15} /> : <IconAnswer size={15} />}
                        </span>
                        <span className="tt" style={{ fontWeight: 400, color: 'var(--ink-2)' }}>{a.content}</span>
                        <span className="tm">
                          <Tag tone={st.tone}>{st.label}</Tag>
                          <span>{fmtDate(a.createdAt)}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
          </div>
        </div>
      </div>

      {/* 全员排期：看得到大家在忙什么，看不到别人任务的细节 */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <span className="ct"><IconClock size={16} color="var(--blue)" />全员排期</span>
          <span className="cs">未来 7 天 · 你的行高亮，别人的只看排期</span>
        </div>
        <div className="card-body">
          <Schedule
            tasks={state.tasks} persons={state.persons} days={days} limit={12}
            editable={false} meId={me.id} onOpen={setDrawer}
          />
        </div>
      </div>

      {drawer && <TaskDrawer taskId={drawer} onClose={() => setDrawer(null)} onChanged={refresh} />}
    </div>
  );
}

function TaskRow({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const st = statusOf(task.status);
  const due = fmtDue(task.dueAt);
  const q = quadSpecOf(task);
  return (
    <div className="task-row" onClick={onOpen}>
      <span className="qbar" style={{ background: q.color }} title={q.title} />
      <span className="tt">{task.title}</span>
      <span className="tm">
        <span>{SOURCE_SHORT[task.source] ?? task.source}</span>
        <Tag tone={due.tone}>{due.text}</Tag>
        <Tag tone={st.tone} dot>{st.label}</Tag>
      </span>
    </div>
  );
}

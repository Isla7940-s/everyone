import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentRun, Person } from '@everyone/shared';
import type { AppState } from '../lib/api';
import { get } from '../lib/api';
import { fmtDate } from '../lib/format';
import { Empty, IconBot, IconDoc, IconPulse, IconRoute, IconTask, Segmented, Tag } from '../ui';

/**
 * 运行轨迹（需求 3）：每一次 Agent 运行（分身任务 / Agent 对话 / 心跳）都留有 OpenCode 原始轨迹。
 * 管理员看全部；普通成员只看自己的分身与自己触发的运行（服务端按 personId 过滤兜底，前端再过滤一层）。
 */

const MODE_META: Record<AgentRun['mode'], { label: string; icon: (p: { size?: number; color?: string }) => JSX.Element; color: string }> = {
  chat: { label: 'Agent 对话', icon: IconBot, color: 'var(--purple)' },
  task: { label: '分身任务', icon: IconTask, color: 'var(--blue)' },
  heartbeat: { label: '心跳', icon: IconPulse, color: 'var(--red)' },
  wiki: { label: '知识库', icon: IconDoc, color: 'var(--green, #34c724)' },
};

const STATUS_META: Record<AgentRun['status'], { label: string; tone: 'blue' | 'green' | 'red' | 'orange' }> = {
  running: { label: '运行中', tone: 'blue' },
  succeeded: { label: '成功', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
  timeout: { label: '超时', tone: 'orange' },
};

function duration(r: AgentRun): string {
  const end = r.finishedAt ? new Date(r.finishedAt).getTime() : Date.now();
  const sec = Math.max(0, Math.round((end - new Date(r.startedAt).getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`;
}

export function Traces({ state, me, isAdmin }: { state: AppState; me: Person | null; isAdmin: boolean }) {
  const [mode, setMode] = useState<'all' | AgentRun['mode']>('all');
  const [openId, setOpenId] = useState<string | null>(() => new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('run'));

  const runs = useMemo(() => {
    const base = isAdmin ? state.agentRuns : state.agentRuns.filter((r) => r.personId === me?.id);
    return mode === 'all' ? base : base.filter((r) => r.mode === mode);
  }, [state.agentRuns, isAdmin, me?.id, mode]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>运行轨迹</h1>
          <div className="desc">
            {isAdmin
              ? '每一次 Agent 运行（任何分身或超级代理本体）都在这里留痕 · 点开看 OpenCode 原始轨迹'
              : '你的分身与你触发的超级代理的每次运行 · 点开看 OpenCode 原始轨迹'}
          </div>
        </div>
        <Segmented
          value={mode}
          options={[
            { value: 'all', label: '全部' },
            { value: 'chat', label: 'Agent 对话' },
            { value: 'task', label: '分身任务' },
            { value: 'heartbeat', label: '心跳' },
            { value: 'wiki', label: '知识库' },
          ]}
          onChange={(v) => setMode(v as never)}
        />
      </div>

      <div className="card">
        <div className="card-body">
          {runs.length === 0
            ? (
              <Empty icon={<IconRoute size={20} />} title="还没有运行记录">
                在群里 @Everyone 让它动手做点什么，或等分身接任务开工
              </Empty>
            )
            : (
              <div className="tracelist">
                {runs.map((r) => {
                  const m = MODE_META[r.mode];
                  const st = STATUS_META[r.status];
                  const MIcon = m.icon;
                  return (
                    <div key={r.id}>
                      <button className={`trace-row ${openId === r.id ? 'on' : ''}`} onClick={() => setOpenId(openId === r.id ? null : r.id)}>
                        <span className="tr-mico" style={{ color: m.color }}><MIcon size={16} /></span>
                        <span className="tr-main">
                          <span className="tr-label">
                            {r.status === 'running' && <span className="pulse" />}
                            {r.label}
                          </span>
                          <span className="tr-req">{r.request}</span>
                        </span>
                        <span className="tr-meta">
                          {isAdmin && r.personName && <span className="tr-person">{r.personName}</span>}
                          <Tag tone={st.tone} dot={r.status === 'running'}>{st.label}</Tag>
                          <span className="tr-time">{fmtDate(r.startedAt)} · {duration(r)}</span>
                          {r.deliveries > 0 && <span className="tr-deliver">{r.deliveries} 次交付</span>}
                        </span>
                      </button>
                      {openId === r.id && <TraceViewer runId={r.id} running={r.status === 'running'} />}
                    </div>
                  );
                })}
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

interface TraceEvent {
  kind: 'text' | 'tool' | 'step' | 'meta' | 'stderr' | 'raw';
  title: string;
  body?: string;
}

/** NDJSON 轨迹 → 可读时间线；解析不了的行原样展示，绝不吞信息 */
function parseTrace(raw: string): TraceEvent[] {
  const out: TraceEvent[] = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    if (s.startsWith('#')) {
      out.push({ kind: 'meta', title: s.replace(/^#\s?/, '') });
      continue;
    }
    if (s.startsWith('[stderr]')) {
      out.push({ kind: 'stderr', title: s.slice(8).trim() });
      continue;
    }
    try {
      const ev = JSON.parse(s);
      const part = ev.part ?? {};
      if (ev.type === 'text' && typeof part.text === 'string') {
        out.push({ kind: 'text', title: 'Agent 输出', body: part.text });
      } else if (ev.type === 'step_start') {
        out.push({ kind: 'step', title: '── 步骤开始 ──' });
      } else if (ev.type === 'step_finish') {
        const tk = part.tokens?.total ? ` · ${part.tokens.total} tokens` : '';
        out.push({ kind: 'step', title: `── 步骤结束（${part.reason ?? 'done'}${tk}）──` });
      } else if (part.type === 'tool' || ev.type === 'tool' || ev.type === 'tool_use' || part.tool) {
        const st = part.state ?? {};
        out.push({
          kind: 'tool',
          title: `工具 ${part.tool ?? ev.tool ?? '?'}${st.status ? ` · ${st.status}` : ''}`,
          body: st.title ?? st.error ?? (st.input ? JSON.stringify(st.input).slice(0, 400) : undefined),
        });
      } else if (ev.type === 'error') {
        out.push({ kind: 'stderr', title: `错误：${JSON.stringify(ev.error ?? ev).slice(0, 300)}` });
      } else {
        out.push({ kind: 'raw', title: ev.type ?? 'event', body: s.slice(0, 400) });
      }
    } catch {
      out.push({ kind: 'raw', title: '', body: s });
    }
  }
  return out;
}

function TraceViewer({ runId, running }: { runId: string; running: boolean }) {
  const [trace, setTrace] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(running);
  const [rawMode, setRawMode] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);

  const load = useCallback(async () => {
    try {
      const d = await get<{ trace: string; running: boolean }>(`/api/agent-run/${runId}/trace`);
      setTrace(d.trace ?? '');
      setIsRunning(d.running);
    } catch {
      setTrace('（轨迹读取失败）');
    }
  }, [runId]);

  useEffect(() => {
    load();
  }, [load]);

  // 运行中每 2.5s 增量刷新，像盯终端一样盯它
  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [isRunning, load]);

  useEffect(() => {
    const el = boxRef.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [trace]);

  const events = useMemo(() => (trace === null || rawMode ? [] : parseTrace(trace)), [trace, rawMode]);

  return (
    <div className="trace-view">
      <div className="tv-bar">
        <span className="tv-note">
          {isRunning ? '运行中 · 实时刷新' : 'OpenCode 原始轨迹'}
          {trace !== null && trace.length === 0 && ' · （这次运行没有留下轨迹文件，可能是旧版本运行或轨迹已清理）'}
        </span>
        <button className="btn xs" onClick={() => setRawMode((v) => !v)}>{rawMode ? '解析视图' : '原始 NDJSON'}</button>
      </div>
      <div
        className="tv-body"
        ref={boxRef}
        onScroll={() => {
          const el = boxRef.current;
          if (el) stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
        }}
      >
        {trace === null && <div className="sb-loading">读取中…</div>}
        {trace !== null && rawMode && <pre className="tv-raw">{trace || '（空）'}</pre>}
        {trace !== null && !rawMode && events.map((e, i) => (
          <div className={`tv-ev ${e.kind}`} key={i}>
            {e.title && <div className="tv-t">{e.title}</div>}
            {e.body && <div className="tv-b">{e.body}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

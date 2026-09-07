import { useEffect, useState } from 'react';
import type { Assist, Person, Task } from '@everyone/shared';
import type { AppState } from '../lib/api';
import { get } from '../lib/api';
import { fmtDue, isAlive, statusOf } from '../lib/format';
import { Markdown } from '../components/Markdown';
import {
  Avatar, Empty, IconAnswer, IconArrowRight, IconBot, IconInbox, IconSkill, IconUsers, Modal, Tag,
} from '../ui';

interface WsData {
  person: Person;
  memory: string;
  skills: Array<{ name: string; content: string; enabled: boolean }>;
  files: Array<{ path: string; size: number }>;
  tasks: Task[];
  assists: Assist[];
}

/**
 * 团队与分身：一人一分身的全景。别人的分身只读围观，自己的去「我的分身」调。
 * 成员只看得到画像与技能；别人的任务清单是管理员视角才有的。
 */
export function Team({ state, me, isAdmin }: { state: AppState; me: Person | null; isAdmin: boolean }) {
  const [domains, setDomains] = useState<Record<string, string>>({});
  const [peek, setPeek] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const out: Record<string, string> = {};
      await Promise.all(state.persons.map(async (p) => {
        try {
          const d = await get<{ memory: string }>(`/api/workspace/${p.id}`);
          const line = (d.memory ?? '').split('\n').find((l) => l.includes('负责域'));
          const domain = line?.replace(/^[-*]\s*负责域[:：]\s*/, '').trim();
          if (domain) out[p.id] = domain;
        } catch { /* 忽略 */ }
      }));
      if (alive) setDomains(out);
    })();
    return () => { alive = false; };
  }, [state.persons]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>团队与分身</h1>
          <div className="desc">
            {isAdmin
              ? '一人一分身：独立的记忆、技能与产物仓 · 点成员看 TA 的画像、技能与近期任务'
              : '一人一分身：独立的记忆、技能与产物仓 · 点成员围观 TA 的画像与技能'}
          </div>
        </div>
      </div>

      {state.persons.length === 0 && (
        <div className="card"><Empty icon={<IconUsers size={20} />} title="还没有成员">启动 server 后会写入演示成员</Empty></div>
      )}

      <div className="team-grid">
        {state.persons.map((p) => {
          const isMe = p.id === me?.id;
          const mine = state.tasks.filter((t) => t.ownerId === p.id && isAlive(t));
          const published = mine.filter((t) => t.status === 'published').length;
          const assists = state.assists.filter((a) => a.personId === p.id).length;
          return (
            <div
              className="card member hoverable" key={p.id}
              onClick={() => { if (isMe) window.location.hash = '#/me/memory'; else setPeek(p.id); }}
            >
              <div className="mh">
                <Avatar person={p} size={44} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="mname">
                    {p.name}
                    {isMe && <Tag tone="blue">我</Tag>}
                  </div>
                  <div className="mdomain">{domains[p.id] || p.id}</div>
                </div>
                <span style={{ color: 'var(--purple)', display: 'flex' }} title="分身在线"><IconBot size={20} /></span>
              </div>

              <div className="mnums">
                <div><div className="n">{mine.length}</div><div className="l">任务</div></div>
                <div><div className="n">{published}</div><div className="l">已发布</div></div>
                <div><div className="n">{assists}</div><div className="l">代收代答</div></div>
              </div>

              <div className="mcaps">
                {/* 开着是常态不必赘述，关掉才标注——异常状态才值得占字 */}
                <Tag tone={p.collectEnabled ? 'orange' : 'gray'}>
                  <IconInbox size={12} />帮你收{p.collectEnabled ? '' : ' 已关'}
                </Tag>
                <Tag tone={p.answerEnabled ? 'cyan' : 'gray'}>
                  <IconAnswer size={12} />帮你答{p.answerEnabled ? '' : ' 已关'}
                </Tag>
                <span style={{ marginLeft: 'auto', color: 'var(--ink-5)', display: 'flex', alignItems: 'center' }}>
                  <IconArrowRight size={14} />
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {peek && <PeekModal personId={peek} isAdmin={isAdmin} onClose={() => setPeek(null)} />}
    </div>
  );
}

/** 只读围观：别人的记忆画像与技能清单（任务清单仅管理员） */
function PeekModal({ personId, isAdmin, onClose }: {
  personId: string;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<WsData | null>(null);
  const [tab, setTab] = useState<'memory' | 'skills' | 'tasks'>('memory');

  useEffect(() => {
    get<WsData>(`/api/workspace/${personId}`).then(setData).catch(() => setData(null));
  }, [personId]);

  const p = data?.person;

  return (
    <Modal
      title={
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Avatar person={p} size={28} />
          {p?.name ?? personId} 的分身
          <Tag tone="gray">只读围观</Tag>
        </span>
      }
      onClose={onClose}
      footer={<button className="btn" onClick={onClose}>关闭</button>}
    >
      <div className="tabs" style={{ marginBottom: 16 }}>
        {([
          ['memory', '记忆画像'],
          ['skills', 'Skills'],
          ...(isAdmin ? [['tasks', '近期任务'] as const] : []),
        ] as const).map(([k, label]) => (
          <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
            {label}
            {k === 'skills' && data && <span className="tcount">{data.skills.length}</span>}
            {k === 'tasks' && data && <span className="tcount">{data.tasks.length}</span>}
          </button>
        ))}
      </div>

      {!data && <Empty tight>读取中…</Empty>}

      {data && tab === 'memory' && (
        <div style={{ maxHeight: 440, overflowY: 'auto' }}>
          <Markdown text={data.memory} />
        </div>
      )}

      {data && tab === 'skills' && (
        <>
          {data.skills.length === 0 && <Empty tight icon={<IconSkill size={18} />}>TA 还没有 skill</Empty>}
          {data.skills.map((s) => (
            <div className="skill" key={s.name}>
              <div className="sh">
                <IconSkill size={14} color={s.enabled ? 'var(--yellow)' : 'var(--ink-5)'} />
                <span className="sname">{s.name}</span>
                <Tag tone={s.enabled ? 'green' : 'gray'}>{s.enabled ? '启用中' : '已停用'}</Tag>
              </div>
              <div className="sbody">{s.content}</div>
            </div>
          ))}
        </>
      )}

      {data && tab === 'tasks' && (
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>任务</th><th style={{ width: 108 }}>状态</th><th style={{ width: 100 }}>截止</th></tr></thead>
            <tbody>
              {data.tasks.slice(0, 20).map((t) => {
                const st = statusOf(t.status);
                const due = fmtDue(t.dueAt);
                return (
                  <tr key={t.id}>
                    <td style={{ fontWeight: 500 }}>{t.title}</td>
                    <td><Tag tone={st.tone} dot>{st.label}</Tag></td>
                    <td><Tag tone={due.tone}>{due.text}</Tag></td>
                  </tr>
                );
              })}
              {data.tasks.length === 0 && <tr><td colSpan={3}><Empty tight>还没有任务</Empty></td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

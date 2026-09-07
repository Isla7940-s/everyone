import { useEffect, useState } from 'react';
import type { Person } from '@everyone/shared';
import { get } from '../lib/api';
import { Avatar, BrandMark, IconArrowRight, IconInfo, IconShield } from '../ui';

/**
 * 登录 = 选人。演示环境不做鉴权，选择的身份只决定「以谁的视角看」，
 * 并作为工作空间、任务归属与分身开关的默认主体。
 */
export function Login({ persons, mode, onPick, onAdmin }: {
  persons: Person[];
  mode: 'mock' | 'lark';
  onPick: (personId: string) => void;
  onAdmin: () => void;
}) {
  const [domains, setDomains] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    (async () => {
      const out: Record<string, string> = {};
      await Promise.all(persons.map(async (p) => {
        try {
          const d = await get<{ memory: string }>(`/api/workspace/${p.id}`);
          const line = (d.memory ?? '').split('\n').find((l) => l.includes('负责域'));
          const domain = line?.replace(/^[-*]\s*负责域[:：]\s*/, '').trim();
          if (domain) out[p.id] = domain;
        } catch { /* 无负责域就退回展示 id */ }
      }));
      if (alive) setDomains(out);
    })();
    return () => { alive = false; };
  }, [persons]);

  return (
    <div className="login">
      <div className="login-inner">
        <div className="lmark">
          <BrandMark size={32} />
          <span className="bname">Everyone</span>
        </div>

        <h1>你是谁？</h1>
        <p className="lsub">
          Everyone 给每个人配一个分身。选择你的身份后，
          <br />
          你会看到属于你的任务、你的分身和你的记忆。
        </p>

        <div className="llabel">团队成员</div>

        {persons.length === 0 ? (
          <div className="lnote">
            <span className="ni"><IconInfo size={15} /></span>
            <div>
              还没有任何成员。启动 server 后会自动写入演示成员，
              真实模式下会同步 <code>DEMO_CHAT_ID</code> 群里的人。
            </div>
          </div>
        ) : (
          <div className="person-list">
            {persons.map((p) => (
              <button key={p.id} className="person-row" onClick={() => onPick(p.id)}>
                <Avatar person={p} size={44} />
                <span className="pinfo">
                  <span className="pname">{p.name}</span>
                  <span className="pmeta">{domains[p.id] || p.id}</span>
                </span>
                <span className="parrow"><IconArrowRight size={18} /></span>
              </button>
            ))}
          </div>
        )}

        <div className="llabel" style={{ marginTop: 26 }}>管理员</div>

        <button className="person-row admin-row" onClick={onAdmin}>
          <span className="admin-mark"><IconShield size={22} /></span>
          <span className="pinfo">
            <span className="pname">以管理员身份进入</span>
            <span className="pmeta">全局视图 · 全员台账与排期 · 评审与日报开关</span>
          </span>
          <span className="parrow"><IconArrowRight size={18} /></span>
        </button>

        <div className="lnote">
          <span className="ni"><IconInfo size={15} /></span>
          <div>
            演示环境暂不校验身份，选谁就是谁。
            <b style={{ fontWeight: 600, color: 'var(--ink-2)' }}>成员</b>只看得到自己的任务与分身，外加全员排期；
            <b style={{ fontWeight: 600, color: 'var(--ink-2)' }}>管理员</b>才看得到全局动态、别人的任务，以及评审与日报开关。
            当前运行在<b style={{ fontWeight: 600, color: 'var(--ink-2)' }}>
              {mode === 'lark' ? '真实飞书模式' : '模拟模式'}
            </b>。
          </div>
        </div>

        <div className="lfoot">每个人的分身，替每个人做事</div>
      </div>
    </div>
  );
}

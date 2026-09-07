import { useCallback, useEffect, useState } from 'react';
import type { HelpRequest, Person, WorkSession } from '@everyone/shared';
import { del, get, post, useToast } from '../lib/api';
import { fmtDate } from '../lib/format';
import { Empty, IconLink, IconTrend, Tag, Toast } from '../ui';

/**
 * 跨端协同（成员页）：本地 Agent 接入引导 —— 个人 token、CLI/Skill/本地客户端安装、
 * 最近上传的工作总结、远程求助记录。
 */

interface CollabState {
  sessions: Array<WorkSession & { personName: string }>;
  helps: Array<HelpRequest & { personName: string }>;
  tokens: Array<{ token: string; label: string | null; createdAt: string; lastUsedAt: string | null }>;
  baseUrl: string;
}

const HELP_STATUS: Record<string, { label: string; tone: 'blue' | 'green' | 'orange' | 'gray' | 'red' }> = {
  pending: { label: '待本地领取', tone: 'orange' },
  claimed: { label: '本地已领取', tone: 'blue' },
  running: { label: '本地执行中', tone: 'blue' },
  succeeded: { label: '已完成', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
};

export function Collab({ me }: { me: Person }) {
  const { toast, show } = useToast();
  const [data, setData] = useState<CollabState | null>(null);

  const load = useCallback(async () => {
    setData(await get<CollabState>(`/api/collab/admin/state?personId=${me.id}`));
  }, [me.id]);
  useEffect(() => { load().catch(() => {}); }, [load]);

  const issueToken = async () => {
    const r = await post<{ token: string }>('/api/collab/admin/token', { personId: me.id, label: 'cli' });
    await navigator.clipboard?.writeText(r.token).catch(() => {});
    show('token 已生成并复制到剪贴板');
    load();
  };
  const revoke = async (token: string) => {
    if (!window.confirm('吊销这个 token？用它登录的 CLI / 本地客户端会立即失效。')) return;
    await del(`/api/collab/admin/token/${token}`);
    show('已吊销');
    load();
  };
  const copy = (text: string, tip: string) => {
    navigator.clipboard?.writeText(text).then(() => show(tip)).catch(() => show('复制失败，请手动选择'));
  };

  const base = data?.baseUrl ?? window.location.origin;
  const installCmd = `curl -fsSL ${base}/api/collab/kit/install -o /tmp/everyone-install.sh && BASE_URL=${base} bash /tmp/everyone-install.sh`;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>跨端协同</h1>
          <div className="desc">
            把 Codex / Cursor / Claude Code 里的工作接进 Everyone：本地 Agent 上传工作总结、同步任务与时间；云端 Agent 缺上下文时远程求助你的本地 Agent
          </div>
        </div>
      </div>

      {/* 接入配置 */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-body">
          <div className="sec-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <IconLink size={14} />接入三步
          </div>
          <ol className="collab-steps">
            <li>
              <b>生成个人 token</b>（CLI 与本地客户端的身份凭证）
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
                <button className="btn xs primary" onClick={issueToken}>生成新 token</button>
                {(data?.tokens ?? []).map((t) => (
                  <span key={t.token} className="collab-token">
                    <code onClick={() => copy(t.token, 'token 已复制')} title="点击复制">{t.token.slice(0, 14)}…</code>
                    <span className="ct-meta">{t.lastUsedAt ? `最近使用 ${fmtDate(t.lastUsedAt)}` : '未使用'}</span>
                    <button className="icon-btn xs" title="吊销" onClick={() => revoke(t.token)}>×</button>
                  </span>
                ))}
              </div>
            </li>
            <li>
              <b>本机安装 Skill + CLI</b>（标准方式装进 Codex / Cursor / Claude Code）
              <div className="pre" onClick={() => copy(installCmd, '安装命令已复制')} title="点击复制">{installCmd}</div>
              <div className="ab-note">装完登录：<code>node ~/.everyone/everyone.mjs auth login --base-url {base} --token ct_xxx</code></div>
            </li>
            <li>
              <b>启动本地客户端</b>（接收云端远程求助：还原会话 → 建沙箱 → 跑本地 Codex → 回传结果）
              <div
                className="pre"
                onClick={() => copy(`curl -fsSL ${base}/api/collab/kit/client -o ~/.everyone/everyone_local_client.py\npython3 ~/.everyone/everyone_local_client.py init --base-url ${base} --token ct_xxx\npython3 ~/.everyone/everyone_local_client.py run`, '命令已复制')}
                title="点击复制"
              >
                {`curl -fsSL ${base}/api/collab/kit/client -o ~/.everyone/everyone_local_client.py\npython3 ~/.everyone/everyone_local_client.py init --base-url ${base} --token ct_xxx\npython3 ~/.everyone/everyone_local_client.py run`}
              </div>
            </li>
          </ol>
          <div className="ab-note">
            隐私边界：云端只保存工作总结（25 字 + 100 字）与元数据，聊天原文永远留在你本地；
            任务完成与时间去向必须你本人确认后，本地 Agent 才会正式上传。
          </div>
        </div>
      </div>

      {/* 最近工作总结 */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-body">
          <div className="sec-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <IconTrend size={14} />我最近上传的工作总结
          </div>
          {!data?.sessions.length
            ? (
              <Empty tight title="还没有工作总结">
                在本地 AI 工具里让 Agent 按 everyone-collab Skill 上传：<code>everyone sessions upload …</code>
              </Empty>
            )
            : (
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 150 }}>会话 ID</th>
                      <th style={{ width: 120 }}>时间</th>
                      <th>大需求 / 子任务</th>
                      <th>短总结</th>
                      <th style={{ width: 90 }}>来源</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sessions.map((s) => (
                      <tr key={s.id}>
                        <td><code className="pe-sid" onClick={() => copy(s.id, '会话 ID 已复制')} title="点击复制">{s.id}</code></td>
                        <td className="num">{fmtDate(s.sessionAt)}</td>
                        <td>{s.requirement} / {s.subtask}</td>
                        <td title={s.detailSummary}>{s.briefSummary}</td>
                        <td><Tag tone="blue">{s.sourceTool}</Tag></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      </div>

      {/* 远程求助记录 */}
      <div className="card">
        <div className="card-body">
          <div className="sec-title">发给我的远程求助</div>
          {!data?.helps.length
            ? <Empty tight title="还没有远程求助">云端 Agent 缺少上下文时，会指名求助你本地的历史工作会话</Empty>
            : data.helps.map((h) => {
              const st = HELP_STATUS[h.status] ?? HELP_STATUS.pending;
              return (
                <div key={h.id} className="collab-help">
                  <div className="ch-head">
                    <Tag tone={st.tone} dot={h.status === 'running'}>{st.label}</Tag>
                    <code className="pe-sid">{h.sessionId}</code>
                    <span style={{ color: 'var(--ink-4)', fontSize: 12 }}>{fmtDate(h.createdAt)}{h.requesterLabel ? ` · 来自 ${h.requesterLabel}` : ''}</span>
                  </div>
                  <div className="ch-q">{h.question}</div>
                  {h.replyText && <div className="ch-reply">回复：{h.replyText.slice(0, 200)}{h.replyText.length > 200 ? '…' : ''}</div>}
                  {h.error && <div className="ch-err">错误：{h.error}</div>}
                  {h.attachments.length > 0 && (
                    <div style={{ color: 'var(--ink-4)', fontSize: 12, marginTop: 4 }}>
                      附件：{h.attachments.map((a) => a.name).join('、')}
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      </div>

      <Toast text={toast} />
    </div>
  );
}

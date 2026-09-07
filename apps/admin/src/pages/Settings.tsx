import { useState } from 'react';
import type { AppState } from '../lib/api';
import { post, useToast } from '../lib/api';
import { fmtDate } from '../lib/format';
import { Empty, IconActivity, IconChat, IconDoc, IconSparkle, Switch, Tag, TimeField, Toast } from '../ui';

const PERSONAS = [
  { name: '老 K', desc: '数据严谨型 · 盯口径与来源，对模糊量词零容忍', color: '#f54a45' },
  { name: '小鹿', desc: '用户视角型 · 永远先问「这对读者有什么用」', color: '#3370ff' },
  { name: '谨叔', desc: '风控敏感型 · 挑风险与合规漏洞，必附降险建议', color: '#ff8800' },
];

/** 评审与日报 + 消息采集：管理员开关，立即生效 */
export function Settings({ state, refresh }: { state: AppState; refresh?: () => void }) {
  const { toast, show } = useToast();
  const [time, setTime] = useState(state.digest.time);
  const [running, setRunning] = useState(false);

  const toggleChat = async (chatId: string, name: string, on: boolean) => {
    await post(`/api/chat/${encodeURIComponent(chatId)}/toggle`, { on });
    show(`「${name}」消息采集已${on ? '启用' : '禁用'}`);
    refresh?.();
  };

  const toggleWiki = async (chatId: string, name: string, on: boolean) => {
    await post(`/api/chat/${encodeURIComponent(chatId)}/wiki-toggle`, { on });
    show(on ? `「${name}」群知识库已启用，正在生成第一版` : `「${name}」群知识库已停用`);
    refresh?.();
  };

  const runWiki = async (chatId: string) => {
    await post(`/api/chat/${encodeURIComponent(chatId)}/wiki-run`);
    show('知识库更新已发起，稍后看「运行轨迹」');
  };

  const rebindWikiDoc = async (chatId: string, currentUrl: string | null) => {
    const url = window.prompt('粘贴新的飞书文档链接（docx）；留空并确定 = 解绑，下次发布自动新建', currentUrl ?? '');
    if (url === null) return;
    const r = await post<{ ok?: boolean; error?: string }>(`/api/chat/${encodeURIComponent(chatId)}/wiki-doc`, { url });
    if (r?.error) show(r.error);
    else show(url.trim() ? '知识库文档已换绑' : '已解绑，下次发布自动新建');
    refresh?.();
  };

  const runDigest = async () => {
    setRunning(true);
    try {
      await post('/api/digest/run');
      show('日报生成中，稍后看群消息');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1>评审与日报</h1>
          <div className="desc">面向全团队的开关，改动立即生效</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <span className="ct"><IconSparkle size={16} color="var(--purple)" />评审团</span>
          <span className="cs">报告发布后自动多视角评论，逐条引用原文</span>
        </div>
        <div className="card-body">
          <div className="setting">
            <div className="st">
              <div className="t">自动评审</div>
              <div className="d">分身发布报告、或群里 @Everyone 求评审时触发</div>
            </div>
            <Switch
              checked={state.reviewEnabled}
              onChange={async (on) => {
                await post('/api/review/toggle', { on });
                show(on ? '评审团已开启' : '评审团已关闭');
              }}
            />
          </div>

          <div style={{ marginTop: 18 }}>
            <div className="sec-title">内置评审人设 · personas/ 目录可编辑</div>
            <div className="grid c3">
              {PERSONAS.map((p) => (
                <div className="persona" key={p.name}>
                  <div className="ph">
                    <span className="avatar s28" style={{ background: p.color }}>{p.name.replace(/\s/g, '')[0]}</span>
                    {p.name}
                  </div>
                  <div className="pd">{p.desc}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <span className="ct"><IconActivity size={16} color="var(--yellow)" />日报导读</span>
          <span className="cs">每天定时把群里发生的事浓缩成 ≤300 字</span>
        </div>
        <div className="card-body">
          <div className="setting">
            <div className="st">
              <div className="t">定时发送</div>
              <div className="d">五段结构：决策 / 承诺 / 未回应 / 明日到期 / 有趣瞬间</div>
            </div>
            <Switch
              checked={state.digest.enabled}
              onChange={async (on) => {
                await post('/api/digest/config', { enabled: on });
                show(on ? '日报已开启' : '日报已关闭');
              }}
            />
          </div>
          <div className="setting">
            <div className="st">
              <div className="t">发送时间</div>
              <div className="d">默认 18:30</div>
            </div>
            <TimeField
              className="field tf-time"
              kind="time"
              commitOn="blur"
              empty="+ 设置时间"
              value={time}
              onCommit={async (v) => {
                setTime(v);
                await post('/api/digest/config', { time: v });
                show(`日报时间已设为 ${v}`);
              }}
            />
          </div>
          <div className="setting">
            <div className="st">
              <div className="t">立即生成一份</div>
              <div className="d">汇总今天到现在的群消息，附全群排期图</div>
            </div>
            <button className="btn primary" onClick={runDigest} disabled={running}>
              {running ? '生成中…' : '立即生成'}
            </button>
          </div>
        </div>
      </div>

      {/* 消息采集（需求 6）：按群启停落库，默认全部启用 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <span className="ct"><IconChat size={16} color="var(--blue)" />消息采集</span>
          <span className="cs">收集保存飞书会话消息落库，供 Agent 检索历史上下文 · 禁用后该会话消息不再存档</span>
        </div>
        <div className="card-body">
          {(state.chats ?? []).length === 0
            ? <Empty tight icon={<IconChat size={19} />} title="还没有会话">机器人收到第一条消息时，会话会自动登记到这里（默认启用采集）</Empty>
            : (state.chats ?? []).map((ch) => (
              <div className="setting" key={ch.chatId}>
                <div className="st">
                  <div className="t">
                    {ch.name ?? (ch.kind === 'p2p' ? '私聊' : '群聊')}
                    <span style={{ color: 'var(--ink-5)', fontWeight: 400, marginLeft: 8, fontSize: 12 }}>{ch.chatId.slice(0, 24)}</span>
                  </div>
                  <div className="d">
                    {ch.kind === 'p2p' ? '私聊' : '群聊'} · 已存 {ch.msgCount} 条
                    {ch.lastMsgAt ? ` · 最近 ${fmtDate(ch.lastMsgAt)}` : ''}
                  </div>
                </div>
                <Switch
                  checked={ch.collectEnabled}
                  onChange={(on) => toggleChat(ch.chatId, ch.name ?? ch.chatId.slice(0, 12), on)}
                />
              </div>
            ))}
        </div>
      </div>

      {/* 群知识库（2026-08-29 需求⑥）：按群启用，每日自动维护，在线文档系统托管、可换绑 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <span className="ct"><IconDoc size={16} color="var(--green, #34c724)" />群知识库</span>
          <span className="cs">每日自动整理群知识进在线文档（跟随日报，没日报则 {state.wiki?.time ?? '19:30'} 兜底）· 新人导读 / Agent 工作底座 / 群内查阅</span>
        </div>
        <div className="card-body">
          {(state.chats ?? []).filter((ch) => ch.kind === 'group').length === 0
            ? <Empty tight icon={<IconDoc size={19} />} title="还没有群会话">机器人进群收到消息后，群会出现在这里</Empty>
            : (state.chats ?? []).filter((ch) => ch.kind === 'group').map((ch) => (
              <div className="setting" key={`wiki-${ch.chatId}`}>
                <div className="st">
                  <div className="t">
                    {ch.name ?? '群聊'}
                    <span style={{ color: 'var(--ink-5)', fontWeight: 400, marginLeft: 8, fontSize: 12 }}>{ch.chatId.slice(0, 24)}</span>
                  </div>
                  <div className="d">
                    {ch.wikiEnabled
                      ? <>
                          {ch.wikiUpdatedAt ? `最近更新 ${fmtDate(ch.wikiUpdatedAt)}` : '已启用 · 第一版生成中'}
                          {ch.wikiDocUrl && (
                            <> · <a href={ch.wikiDocUrl} target="_blank" rel="noreferrer">在线文档</a></>
                          )}
                        </>
                      : '启用后由独立沙箱 Agent 每日维护（维护期间禁言，唯一出口是覆盖在线文档）'}
                  </div>
                </div>
                {ch.wikiEnabled && (
                  <>
                    <button className="btn xs" onClick={() => runWiki(ch.chatId)}>立即更新</button>
                    <button className="btn xs" onClick={() => rebindWikiDoc(ch.chatId, ch.wikiDocUrl)}>换绑文档</button>
                  </>
                )}
                <Switch
                  checked={ch.wikiEnabled}
                  onChange={(on) => toggleWiki(ch.chatId, ch.name ?? ch.chatId.slice(0, 12), on)}
                />
              </div>
            ))}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <span className="ct">最近评审记录</span>
          <span className="cs">{state.reviews.length} 条</span>
        </div>
        <div className="card-body">
          {state.reviews.length === 0
            ? <Empty tight icon={<IconSparkle size={19} />} title="还没有评审记录">分身发布报告后，三个人设会逐条引用原文评论</Empty>
            : (
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 78 }}>人设</th>
                      <th style={{ width: 200 }}>引用原文</th>
                      <th>评论</th>
                      <th style={{ width: 104 }}>时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.reviews.slice(0, 20).map((r, i) => (
                      <tr key={i}>
                        <td><Tag tone="purple">{r.persona}</Tag></td>
                        <td style={{ color: 'var(--ink-4)', fontSize: 12.5 }}>{r.quoted_text}</td>
                        <td style={{ color: 'var(--ink-2)' }}>{r.content}</td>
                        <td className="num">{fmtDate(r.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      </div>

      <Toast text={toast} />
    </div>
  );
}

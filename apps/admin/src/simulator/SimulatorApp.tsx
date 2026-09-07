import { useEffect, useMemo, useRef, useState } from 'react';
import type { MockChatMessage, Person } from '@everyone/shared';
import { inline } from '../components/Markdown';
import { ActivityFeed } from '../components/ActivityFeed';
import { post, useHashRoute, useSimulatorState } from '../lib/api';
import { fmtTime, initial } from '../lib/format';
import { Doc } from '../pages/Doc';
import {
  Avatar, BrandMark, Empty, IconActivity, IconBot, IconChat, IconSend, IconTerminal, IconUsers,
} from '../ui';
import { FeishuCard } from './FeishuCard';

const GROUP_ID = 'mock-demo-chat';
const IDENTITY_KEY = 'everyone.sim.identity';

const QUICK = [
  '周五前我把竞品分析报告发出来',
  '@小红 帮我把上周的数据整理一下，周三要',
  '@Everyone 上次说的预算口径是多少',
  '这个空白页体验很影响使用',
];

/** 飞书 emoji_type → 展示字符（机器人表情回应；未映射的显示原名） */
const EMOJI_GLYPH: Record<string, string> = {
  Get: '✌️ Get',
  OneSecond: '⏳ 稍等',
  DONE: '✅ 完成',
  THUMBSUP: '👍',
  OK: '👌',
};

/**
 * 模拟群聊（开发工具，独立入口）：
 * 用浏览器界面替代飞书群，与真实模式走同一套业务代码，
 * 只有消息进出改走 HTTP + SSE。主前端不链接到这里。
 */
export function SimulatorApp() {
  const hash = useHashRoute('#/chat');
  const { state, activities, messages } = useSimulatorState();

  const docMatch = hash.match(/^#\/doc\/(.+)$/);
  if (docMatch) {
    return (
      <div className="sim">
        <SimBar state={state} />
        <div className="sim-doc">
          <Doc taskId={docMatch[1]} backHash="#/chat" backLabel="返回群聊" />
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="sim">
        <SimBar state={null} />
        <div className="sim-body" style={{ alignItems: 'center', justifyContent: 'center' }}>
          <Empty icon={<IconTerminal size={20} />} title="连不上 server">
            确认已启动 <code>CHAT_ADAPTER=mock pnpm dev</code>
          </Empty>
        </div>
      </div>
    );
  }

  if (state.mode !== 'mock') {
    return (
      <div className="sim">
        <SimBar state={state} />
        <div className="sim-body" style={{ alignItems: 'center', justifyContent: 'center' }}>
          <Empty icon={<IconChat size={20} />} title="当前是真实飞书模式">
            模拟群聊仅在 <code>CHAT_ADAPTER=mock</code> 下可用。
            <br />
            真实模式请直接在飞书群里与 Everyone 互动。
          </Empty>
        </div>
      </div>
    );
  }

  return <Chat persons={state.persons} messages={messages} activities={activities} state={state} />;
}

function SimBar({ state }: { state: { mode: string; memoryEngineUp: boolean } | null }) {
  return (
    <div className="sim-bar">
      <span className="sb-mark">
        <BrandMark size={28} />
        <span className="sb-title">模拟群聊</span>
      </span>
      <span className="sb-sub">开发工具 · 与真实飞书走同一套业务代码，仅消息进出改走浏览器</span>
      <span className="spacer" />
      {state && (
        <>
          <span className={`pill ${state.mode === 'mock' ? 'mock' : 'live'}`}>
            <span className="pdot" />
            <span>{state.mode === 'mock' ? 'CHAT_ADAPTER=mock' : '真实飞书'}</span>
          </span>
          <span className={`pill ${state.memoryEngineUp ? 'mem-on' : 'mem-off'}`}>
            <span className="pdot" />
            <span>{state.memoryEngineUp ? '四层记忆在线' : '记忆降级'}</span>
          </span>
        </>
      )}
    </div>
  );
}

function Chat({ persons, messages, activities, state }: {
  persons: Person[];
  messages: MockChatMessage[];
  activities: Parameters<typeof ActivityFeed>[0]['activities'];
  state: { mode: string; memoryEngineUp: boolean };
}) {
  const [identity, setIdentity] = useState(
    () => localStorage.getItem(IDENTITY_KEY) || persons[0]?.id || 'xiaoming',
  );
  const [conv, setConv] = useState(GROUP_ID);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [readMap, setReadMap] = useState<Record<string, number>>({});
  const [joinName, setJoinName] = useState('');
  const [joining, setJoining] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  const joinMember = async () => {
    const name = joinName.trim();
    if (!name || joining) return;
    setJoining(true);
    try {
      const r = await post<{ ok?: boolean; personId?: string; error?: string }>('/api/mock/join', { name });
      if (r?.error) {
        alert(r.error);
      } else {
        setJoinName('');
        if (r?.personId) setConv(`mock-p2p-${r.personId}`); // 直接跳到新人私聊，看快速指引到达
      }
    } finally {
      setJoining(false);
    }
  };

  useEffect(() => {
    localStorage.setItem(IDENTITY_KEY, identity);
  }, [identity]);

  useEffect(() => {
    if (persons.length && !persons.some((p) => p.id === identity)) setIdentity(persons[0].id);
  }, [persons, identity]);

  const convMsgs = useMemo(() => messages.filter((m) => m.chatId === conv), [messages, conv]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [convMsgs.length, conv]);

  useEffect(() => {
    setReadMap((prev) => ({ ...prev, [conv]: messages.filter((m) => m.chatId === conv).length }));
  }, [conv, messages.length]);

  const conversations = useMemo(() => {
    const list = [{
      id: GROUP_ID,
      name: '星航项目群',
      kind: 'group' as const,
      sub: `${persons.length} 名成员 + Everyone`,
    }];
    const sorted = [...persons].sort((a, b) => (a.id === identity ? -1 : b.id === identity ? 1 : 0));
    for (const p of sorted) {
      list.push({
        id: `mock-p2p-${p.id}`,
        name: `Everyone × ${p.name}`,
        kind: 'dm' as any,
        sub: p.id === identity ? '我与分身的私聊' : `${p.name} 与分身的私聊`,
      });
    }
    return list;
  }, [persons, identity]);

  const personOf = (id: string) => persons.find((p) => p.id === id);
  const me = personOf(identity);
  const current = conversations.find((c) => c.id === conv);
  const hasUnread = (id: string) => messages.filter((m) => m.chatId === id).length > (readMap[id] ?? 0);

  const send = async (raw?: string) => {
    const t = (raw ?? text).trim();
    if (!t || sending) return;
    setSending(true);
    try {
      await post('/api/mock/message', {
        personId: identity,
        text: t,
        chatKind: conv === GROUP_ID ? 'group' : 'p2p',
      });
      setText('');
    } finally {
      setSending(false);
      boxRef.current?.focus();
    }
  };

  const jumpTo = (msgId: string) => {
    const el = document.getElementById(`m-${msgId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('msg-hl');
    void el.offsetWidth;
    el.classList.add('msg-hl');
  };

  return (
    <div className="sim">
      <SimBar state={state} />

      <div className="sim-body">
        <aside className="sim-side">
          <div className="ss-label"><IconUsers size={12} />以谁的身份发言</div>
          <div className="idpick">
            {persons.map((p) => (
              <button key={p.id} className={`opt ${identity === p.id ? 'on' : ''}`} onClick={() => setIdentity(p.id)}>
                <Avatar person={p} size={28} />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span className="n" style={{ display: 'block' }}>{p.name}</span>
                  <span className="h">{p.id}</span>
                </span>
                {identity === p.id && <span className="me">当前</span>}
              </button>
            ))}
          </div>

          <div className="ss-label"><IconUsers size={12} />拉新人进群（触发快速指引）</div>
          <div className="join-box">
            <input
              value={joinName}
              placeholder="新成员名字，如：小李"
              maxLength={20}
              onChange={(e) => setJoinName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') joinMember(); }}
            />
            <button className="join-btn" onClick={joinMember} disabled={joining || !joinName.trim()}>
              {joining ? '拉人中…' : '拉进群'}
            </button>
          </div>

          <div className="ss-label"><IconChat size={12} />会话</div>
          <div className="convs">
            {conversations.map((c) => (
              <button key={c.id} className={`conv ${conv === c.id ? 'on' : ''}`} onClick={() => setConv(c.id)}>
                <span className="cico">{c.kind === 'group' ? <IconUsers size={17} /> : <IconBot size={17} />}</span>
                <span className="cbody">
                  <span className="cname" style={{ display: 'block' }}>{c.name}</span>
                  <span className="csub">{c.sub}</span>
                </span>
                {conv !== c.id && hasUnread(c.id) && <span className="unread" />}
              </button>
            ))}
          </div>
        </aside>

        <main className="sim-main">
          <div className="sim-head">
            <span className="t">{current?.name ?? conv}</span>
            <span className="s">{current?.sub}</span>
          </div>

          <div className="msgs" ref={listRef}>
            {convMsgs.length === 0 && (
              <Empty icon={<IconChat size={20} />} title="这里还没有消息">
                {conv === GROUP_ID
                  ? <>试试以{me?.name ?? '成员'}的身份说「周五前我把竞品分析报告发出来」，<br />或粘贴一段以 <code>#会议</code> 开头的会议记录</>
                  : <>给 Everyone 发私信，它会以你的分身身份回应</>}
              </Empty>
            )}
            {convMsgs.map((m) => {
              const mine = !m.senderIsBot && m.senderId === identity;
              const sender = personOf(m.senderId);
              const replied = m.replyToMsgId ? messages.find((x) => x.msgId === m.replyToMsgId) : null;
              return (
                <div className={`msg ${mine ? 'mine' : ''}`} key={m.msgId} id={`m-${m.msgId}`}>
                  {m.senderIsBot
                    ? <Avatar bot size={36} />
                    : sender
                      ? <Avatar person={sender} size={36} />
                      : <span className="avatar s36" style={{ background: '#9a9aa8' }}>{initial(m.senderName)}</span>}
                  <div className="mbody">
                    <div className="mmeta">
                      <span className="mname">{m.senderName}</span>
                      {m.senderIsBot && <span className="bot-chip">机器人</span>}
                      <span className="mtime">{fmtTime(m.ts)}</span>
                    </div>
                    {replied && (
                      <div className="reply-ref" onClick={() => jumpTo(replied.msgId)}>
                        回复 {replied.senderName}：
                        {(replied.text ?? (replied.kind === 'image' ? '[图片]' : '[卡片]')).slice(0, 60)}
                      </div>
                    )}
                    {m.kind === 'card'
                      ? <FeishuCard card={m.card} msgId={m.msgId} operatorId={identity} />
                      : m.kind === 'image'
                        ? <img className="msg-img" src={m.imageUrl} alt="分身渲染的图" onClick={() => setLightbox(m.imageUrl!)} />
                        : (
                          <div className={`bubble ${m.senderIsBot ? 'bot' : ''}`}>
                            {(m.text ?? '').split('\n').map((line, i) =>
                              line.startsWith('>')
                                ? <span className="quote-line" key={i}>{inline(line.replace(/^>\s?/, ''))}</span>
                                : <span key={i}>{inline(line)}{'\n'}</span>,
                            )}
                          </div>
                        )}
                    {(m.reactions?.length ?? 0) > 0 && (
                      <div className="msg-reactions">
                        {m.reactions!.map((r, i) => (
                          <span className="reaction-chip" key={i}>{EMOJI_GLYPH[r] ?? r}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="composer">
            <div className="chint">
              以 <b style={{ color: me?.avatarColor, fontWeight: 600 }}>{me?.name ?? identity}</b> 的身份发言 · Enter 发送，Shift+Enter 换行
              {conv !== GROUP_ID && ' · 有待审阅初稿时，输入文字即为修改意见'}
            </div>
            <div className="cbox">
              <textarea
                ref={boxRef}
                value={text}
                rows={Math.min(6, Math.max(1, text.split('\n').length))}
                placeholder={conv === GROUP_ID ? '在群里说点什么…（承诺、@指派、#会议、提问、吐槽）' : '给 Everyone 发私信…'}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <button className="send" onClick={() => send()} disabled={sending || !text.trim()} aria-label="发送">
                <IconSend size={17} />
              </button>
            </div>
            {conv === GROUP_ID && convMsgs.length < 3 && (
              <div className="hints">
                {QUICK.map((h) => (
                  <button key={h} className="hint-chip" onClick={() => setText(h)}>{h}</button>
                ))}
              </div>
            )}
          </div>
        </main>

        <aside className="sim-stage">
          <div className="stage-head">
            <IconActivity size={15} color="var(--blue)" />
            幕后 · Agent 实时活动
          </div>
          <ActivityFeed activities={activities} />
        </aside>
      </div>

      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="放大查看" />
        </div>
      )}
    </div>
  );
}

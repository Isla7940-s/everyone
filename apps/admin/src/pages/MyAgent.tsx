import { useCallback, useEffect, useState } from 'react';
import type { Assist, Person, Task } from '@everyone/shared';
import { SandboxBrowser, type SandboxEntry } from '../components/SandboxBrowser';
import type { AppState } from '../lib/api';
import { del, get, post, put, useToast } from '../lib/api';
import { ASSIST_STATUS, docLink, fmtDate, fmtDue, SOURCE_SHORT, statusOf } from '../lib/format';
import {
  Empty, IconAnswer, IconInbox, IconPlus, IconSkill,
  IconTask, IconTrash, IconEdit, Modal, Switch, Tag, Toast,
} from '../ui';

interface WsData {
  person: Person;
  memory: string;
  skills: Array<{ name: string; content: string; enabled: boolean }>;
  files: SandboxEntry[];
  tasks: Task[];
  assists: Assist[];
}

/** 随产品发布的通用写作模板，装进沙箱后就是这个人自己的 skill，可再改 */
interface PresetSkill {
  name: string;
  title: string;
  summary: string;
  content: string;
}

export type AgentTab = 'memory' | 'skills' | 'tasks' | 'assist' | 'files';

const TAB_META: Record<AgentTab, { title: string; short: string; desc: string }> = {
  memory: {
    title: '记忆画像',
    short: '记忆',
    desc: 'L3 画像的人工可编辑视图 · 分身执行、能力自评、帮你收 / 帮你答都会读它',
  },
  skills: {
    title: '技能 Skills',
    short: '技能',
    desc: 'markdown 指令文件 · 分身执行时注入任务书，关掉即不注入',
  },
  tasks: {
    title: '任务与产出',
    short: '产出',
    desc: '分身替你干过的活，以及每件事的产出文档',
  },
  assist: {
    title: '代收代答',
    short: '代答',
    desc: '分身替你收意见、替你答问题的记录与开关',
  },
  files: {
    title: '沙箱文件',
    short: '沙箱',
    desc: '分身的全部工作现场 · 一任务一目录，读写都出不了你的工作区',
  },
};

/** 我的分身：调记忆、调技能、看产出、管代收代答、透视沙箱（分页由侧边栏路由驱动） */
export function MyAgent({ state, me, tab }: { state: AppState; me: Person; tab: AgentTab }) {
  const [data, setData] = useState<WsData | null>(null);
  const [memoryText, setMemoryText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [skillModal, setSkillModal] = useState<{ name: string; content: string; isNew: boolean } | null>(null);
  const [presets, setPresets] = useState<PresetSkill[] | null>(null);
  const [presetOpen, setPresetOpen] = useState(false);
  const { toast, show } = useToast();

  const load = useCallback(async () => {
    try {
      const d = await get<WsData>(`/api/workspace/${me.id}`);
      setData(d);
      setMemoryText((prev) => (dirty ? prev : d.memory));
    } catch { /* server 抖动时保留旧数据 */ }
  }, [me.id, dirty]);

  useEffect(() => {
    setDirty(false);
  }, [me.id]);

  useEffect(() => {
    load();
  }, [load, state.tasks.length, state.assists.length]);

  const saveMemory = async () => {
    setSaving(true);
    try {
      await put(`/api/workspace/${me.id}/memory`, { content: memoryText });
      setDirty(false);
      show('记忆已保存 · 下次分身执行即生效');
    } finally {
      setSaving(false);
    }
  };

  const saveSkill = async () => {
    if (!skillModal) return;
    const name = skillModal.name.trim().replace(/\.md$/, '');
    if (!name) return;
    await put(`/api/workspace/${me.id}/skill/${encodeURIComponent(name)}`, { content: skillModal.content, enabled: true });
    setSkillModal(null);
    show(`Skill「${name}」已保存`);
    load();
  };

  const openPresets = async () => {
    setPresetOpen(true);
    if (presets) return;
    try {
      const d = await get<{ presets: PresetSkill[] }>('/api/skills/presets');
      setPresets(d.presets ?? []);
    } catch {
      setPresets([]);
    }
  };

  /** 装预制 skill：直接落盘启用，随后可在编辑器里按自己的习惯改 */
  const installPreset = async (ps: PresetSkill) => {
    const has = data?.skills.some((s) => s.name === ps.name);
    if (has && !window.confirm(`你已经有同名 skill「${ps.name}」，用预制版覆盖它？`)) return;
    await put(`/api/workspace/${me.id}/skill/${encodeURIComponent(ps.name)}`, { content: ps.content, enabled: true });
    setPresetOpen(false);
    show(`已装上「${ps.title}」· 下次分身干活即生效`);
    load();
  };

  const toggleSkill = async (s: { name: string; content: string; enabled: boolean }) => {
    await put(`/api/workspace/${me.id}/skill/${encodeURIComponent(s.name)}`, { content: s.content, enabled: !s.enabled });
    load();
  };

  const removeSkill = async (name: string) => {
    if (!window.confirm(`删除 Skill「${name}」？`)) return;
    await del(`/api/workspace/${me.id}/skill/${encodeURIComponent(name)}`);
    show(`Skill「${name}」已删除`);
    load();
  };

  const toggleCap = async (key: 'collect' | 'answer', on: boolean) => {
    await post(`/api/person/${me.id}/toggle`, { key, on });
    show(`「${key === 'collect' ? '帮你收' : '帮你答'}」已${on ? '开启' : '关闭'}`);
    load();
  };

  const p = data?.person ?? me;
  const meta = TAB_META[tab];

  return (
    // 标题在侧边栏已经高亮着，这里不再重复页头——宽度和留白全让给内容
    <div className="page agent">
      {/* 窄屏底栏放不下分身的五个入口，这里补一排页内 tab */}
      <div className="tabs only-mobile">
        {(Object.keys(TAB_META) as AgentTab[]).map((k) => (
          <a key={k} href={`#/me/${k}`} className={`tab ${tab === k ? 'on' : ''}`}>
            {TAB_META[k].short}
          </a>
        ))}
      </div>

      {tab === 'memory' && (
        <div className="card">
          <div className="card-body">
            <div className="agent-bar">
              <span className="ab-note">{meta.desc}</span>
              {dirty && <Tag tone="orange">未保存</Tag>}
              <button
                className={dirty ? 'btn primary' : 'btn'}
                onClick={saveMemory}
                disabled={saving || !dirty}
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
            <textarea
              className="editor"
              value={memoryText}
              spellCheck={false}
              onChange={(e) => { setMemoryText(e.target.value); setDirty(true); }}
            />
          </div>
        </div>
      )}

      {tab === 'skills' && (
        <div className="card">
          <div className="card-body">
            <div className="agent-bar">
              <span className="ab-note">{meta.desc}</span>
              <button className="btn" onClick={openPresets}>
                <IconSkill size={14} />从预制库添加
              </button>
              <button className="btn primary" onClick={() => setSkillModal({ name: '', content: '# Skill: \n\n', isNew: true })}>
                <IconPlus size={14} />新建 Skill
              </button>
            </div>
            {data?.skills.length === 0 && (
              <Empty icon={<IconSkill size={20} />} title="还没有 skill">
                从预制库装一个写作模板，分身的产出就会稳定遵循它
              </Empty>
            )}
            {data?.skills.map((s) => (
              <div className="skill" key={s.name}>
                <div className="sh">
                  <IconSkill size={15} color={s.enabled ? 'var(--yellow)' : 'var(--ink-5)'} />
                  <span className="sname">{s.name}</span>
                  <Tag tone={s.enabled ? 'green' : 'gray'}>{s.enabled ? '启用中' : '已停用'}</Tag>
                  <span style={{ flex: 1 }} />
                  <Switch checked={s.enabled} onChange={() => toggleSkill(s)} title="启用 / 停用" />
                  <button className="btn xs" onClick={() => setSkillModal({ name: s.name, content: s.content, isNew: false })}>
                    <IconEdit size={13} />编辑
                  </button>
                  <button className="btn xs danger" onClick={() => removeSkill(s.name)}>
                    <IconTrash size={13} />
                  </button>
                </div>
                <div className="sbody">{s.content}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'tasks' && (
        <div className="card">
          <div className="card-body">
            <div className="agent-bar">
              <span className="ab-note">{meta.desc}</span>
              <span className="ab-count">{data?.tasks.length ?? 0} 条</span>
            </div>
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>任务</th>
                    <th style={{ width: 84 }}>来源</th>
                    <th style={{ width: 112 }}>状态</th>
                    <th style={{ width: 104 }}>截止</th>
                    <th style={{ width: 76 }}>置信度</th>
                    <th style={{ width: 76 }}>产出</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.tasks.map((t) => {
                    const st = statusOf(t.status);
                    const due = fmtDue(t.dueAt);
                    const doc = docLink(t);
                    return (
                      <tr key={t.id}>
                        <td style={{ fontWeight: 500 }}>{t.title}</td>
                        <td className="num">{SOURCE_SHORT[t.source] ?? t.source}</td>
                        <td><Tag tone={st.tone} dot>{st.label}</Tag></td>
                        <td><Tag tone={due.tone}>{due.text}</Tag></td>
                        <td className="num">{(t.confidence * 100).toFixed(0)}%</td>
                        <td>
                          {doc
                            ? <a href={doc.href} target={doc.external ? '_blank' : undefined} rel="noreferrer">查看</a>
                            : <span style={{ color: 'var(--ink-5)' }}>—</span>}
                        </td>
                      </tr>
                    );
                  })}
                  {(data?.tasks.length ?? 0) === 0 && (
                    <tr><td colSpan={6}><Empty icon={<IconTask size={20} />} title="还没有任务">到群里许个承诺试试</Empty></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === 'assist' && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-body">
              <div className="setting">
                <div className="st">
                  <div className="t"><IconInbox size={15} color="var(--orange)" />帮你收</div>
                  <div className="d">群里出现归你管的意见时，分身记入你的记忆并私信你</div>
                </div>
                <Switch checked={p.collectEnabled ?? true} onChange={(on) => toggleCap('collect', on)} />
              </div>
              <div className="setting">
                <div className="st">
                  <div className="t"><IconAnswer size={15} color="var(--cyan)" />帮你答</div>
                  <div className="d">有把握时以你的分身署名代答，必带出处、可更正、可撤回</div>
                </div>
                <Switch checked={p.answerEnabled ?? true} onChange={(on) => toggleCap('answer', on)} />
              </div>
            </div>
          </div>
          <div className="card">
            <div className="card-body">
              <div className="agent-bar">
                <span className="ab-note">分身替你收 / 答过的每一条，都在这里留痕</span>
                <span className="ab-count">{data?.assists.length ?? 0} 条</span>
              </div>
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 96 }}>类型</th>
                      <th>内容</th>
                      <th style={{ width: 108 }}>状态</th>
                      <th style={{ width: 104 }}>时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data?.assists.map((a) => {
                      const st = ASSIST_STATUS[a.status] ?? { label: a.status, tone: 'gray' as const };
                      return (
                        <tr key={a.id}>
                          <td>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                              {a.type === 'collect'
                                ? <><IconInbox size={14} color="var(--orange)" />帮你收</>
                                : <><IconAnswer size={14} color="var(--cyan)" />帮你答</>}
                            </span>
                          </td>
                          <td style={{ color: 'var(--ink-2)' }}>{a.content}</td>
                          <td><Tag tone={st.tone}>{st.label}</Tag></td>
                          <td className="num">{fmtDate(a.createdAt)}</td>
                        </tr>
                      );
                    })}
                    {(data?.assists.length ?? 0) === 0 && (
                      <tr><td colSpan={4}><Empty icon={<IconAnswer size={20} />} title="分身还没替你收 / 答过" /></td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}

      {tab === 'files' && (
        <div className="card">
          <SandboxBrowser
            personId={me.id}
            entries={data?.files ?? []}
            tasks={data?.tasks ?? []}
            rootLabel={`${p.name}的沙箱`}
            rootPath={p.workspaceDir}
            onUploaded={load}
          />
        </div>
      )}

      {presetOpen && (
        <Modal
          title="预制 skill 库"
          onClose={() => setPresetOpen(false)}
          footer={<button className="btn" onClick={() => setPresetOpen(false)}>关闭</button>}
        >
          <div className="ab-note" style={{ marginBottom: 12 }}>
            通用写作模板，装上就是你自己的 skill，之后可以随便改。分身干活时会照着它的骨架和规则写。
          </div>
          {presets === null && <div className="sb-loading">读取中…</div>}
          {presets?.length === 0 && <Empty tight icon={<IconSkill size={18} />}>预制库是空的</Empty>}
          {presets?.map((ps) => {
            const has = data?.skills.some((s) => s.name === ps.name);
            return (
              <div className="preset" key={ps.name}>
                <div className="ph">
                  <IconSkill size={15} color="var(--yellow)" />
                  <span className="sname">{ps.title}</span>
                  <span className="pfile">{ps.name}</span>
                  {has && <Tag tone="gray">已装过</Tag>}
                  <span style={{ flex: 1 }} />
                  <button className="btn xs" onClick={() => { setPresetOpen(false); setSkillModal({ name: ps.name, content: ps.content, isNew: true }); }}>
                    先改再装
                  </button>
                  <button className="btn xs primary" onClick={() => installPreset(ps)}>
                    {has ? '覆盖' : '装上'}
                  </button>
                </div>
                <div className="psum">{ps.summary}</div>
              </div>
            );
          })}
        </Modal>
      )}

      {skillModal && (
        <Modal
          title={skillModal.isNew ? '新建 Skill' : `编辑 Skill · ${skillModal.name}`}
          onClose={() => setSkillModal(null)}
          footer={
            <>
              <button className="btn" onClick={() => setSkillModal(null)}>取消</button>
              <button className="btn primary" onClick={saveSkill} disabled={!skillModal.name.trim()}>保存</button>
            </>
          }
        >
          {skillModal.isNew && (
            <input
              className="field" type="text" placeholder="skill 名称（如 weekly-report）"
              value={skillModal.name} style={{ marginBottom: 12 }}
              onChange={(e) => setSkillModal({ ...skillModal, name: e.target.value })}
            />
          )}
          <textarea
            className="field mono" rows={16} spellCheck={false} value={skillModal.content}
            onChange={(e) => setSkillModal({ ...skillModal, content: e.target.value })}
          />
        </Modal>
      )}

      <Toast text={toast} />
    </div>
  );
}

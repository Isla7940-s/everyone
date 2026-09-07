import { useEffect, useRef, useState } from 'react';
import type { ActivityEvent, Person } from '@everyone/shared';
import { useAppState, useHashRoute } from './lib/api';
import { isOpen } from './lib/format';
import { useSession } from './lib/session';
import { AdminSandbox } from './pages/AdminSandbox';
import { Board } from './pages/Board';
import { Collab } from './pages/Collab';
import { Doc } from './pages/Doc';
import { Heartbeats } from './pages/Heartbeats';
import { Home } from './pages/Home';
import { Login } from './pages/Login';
import { MyAgent, type AgentTab } from './pages/MyAgent';
import { Settings } from './pages/Settings';
import { Tasks } from './pages/Tasks';
import { Team } from './pages/Team';
import { TimePierce } from './pages/TimePierce';
import { Traces } from './pages/Traces';
import {
  Avatar, BrandMark, IconAnswer, IconCheck, IconChevronDown, IconClock, IconFolder, IconGear,
  IconGrid, IconHome, IconLink, IconLogout, IconMemory, IconPulse, IconRoute, IconShield,
  IconSkill, IconSwap, IconTask, IconUsers,
} from './ui';

interface NavItem {
  route: string;
  label: string;
  short: string;
  mobile?: 'hide';
  icon: (p: { size?: number }) => JSX.Element;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

/** 成员导航：只有「我的」+ 全员排期，看不到别人的任务与全局动态 */
const MEMBER_NAV: NavGroup[] = [
  {
    label: '工作区',
    items: [
      { route: 'home', label: '我的工作台', short: '工作台', icon: IconHome },
      { route: 'tasks', label: '我的任务', short: '任务', icon: IconTask },
      { route: 'pierce', label: '时间穿透', short: '时间', icon: IconClock },
      { route: 'heartbeats', label: '心跳任务', short: '心跳', mobile: 'hide', icon: IconPulse },
    ],
  },
  {
    label: '我的分身',
    items: [
      { route: 'me/memory', label: '记忆画像', short: '分身', icon: IconMemory },
      { route: 'me/skills', label: '技能 Skills', short: '技能', mobile: 'hide', icon: IconSkill },
      { route: 'me/tasks', label: '任务与产出', short: '产出', mobile: 'hide', icon: IconTask },
      { route: 'me/assist', label: '代收代答', short: '代答', mobile: 'hide', icon: IconAnswer },
      { route: 'me/files', label: '沙箱文件', short: '沙箱', mobile: 'hide', icon: IconFolder },
      { route: 'collab', label: '跨端协同', short: '协同', mobile: 'hide', icon: IconLink },
      { route: 'traces', label: '运行轨迹', short: '轨迹', icon: IconRoute },
    ],
  },
];

/** 管理员导航：全局视角，没有「我的分身」（管理员不是某个成员） */
const ADMIN_NAV: NavGroup[] = [
  {
    label: '管理视图',
    items: [
      { route: 'board', label: '全局视图', short: '全局', icon: IconGrid },
      { route: 'tasks', label: '任务台账', short: '台账', icon: IconTask },
      { route: 'team', label: '团队与分身', short: '团队', icon: IconUsers },
      { route: 'pierce', label: '时间穿透', short: '时间', icon: IconClock },
      { route: 'heartbeats', label: '心跳任务', short: '心跳', mobile: 'hide', icon: IconPulse },
      { route: 'settings', label: '评审与日报', short: '评审', icon: IconGear },
    ],
  },
  {
    label: '超级代理',
    items: [
      { route: 'sandbox', label: '沙箱', short: '沙箱', mobile: 'hide', icon: IconFolder },
      { route: 'traces', label: '运行轨迹', short: '轨迹', icon: IconRoute },
    ],
  },
];

const MEMBER_ROUTES = new Set(['home', 'tasks', 'pierce', 'heartbeats', 'traces', 'collab', 'me/memory', 'me/skills', 'me/tasks', 'me/assist', 'me/files']);
const ADMIN_ROUTES = new Set(['board', 'tasks', 'team', 'pierce', 'heartbeats', 'settings', 'sandbox', 'traces']);

export function App() {
  const hash = useHashRoute();
  const { state, activities, offline, refresh } = useAppState();
  const { personId, me, isAdmin, signedIn, login, loginAdmin, logout } = useSession(state?.persons);

  // 切换身份后地址栏可能停在另一角色的页面上，纠正过来，别让 URL 撒谎
  const asked = hash.replace(/^#\//, '').split('?')[0];
  const allowed = isAdmin ? ADMIN_ROUTES : MEMBER_ROUTES;
  const home = isAdmin ? 'board' : 'home';
  useEffect(() => {
    if (!signedIn || asked.startsWith('doc/')) return;
    if (!allowed.has(asked)) window.location.replace(`#/${home}`);
  }, [signedIn, asked, allowed, home]);

  if (!state) {
    return (
      <div className="login">
        <div className="login-inner">
          <div className="lmark"><BrandMark size={32} /><span className="bname">Everyone</span></div>
          <h1>{offline ? '连不上 server' : '正在连接…'}</h1>
          <p className="lsub">
            {offline
              ? '请确认 Everyone server 已启动，默认监听 8902 端口。'
              : '正在读取任务台账与成员列表。'}
          </p>
          {offline && (
            <>
              <div className="pre" style={{ marginBottom: 18 }}>pnpm dev{'\n'}# 或者不连飞书：CHAT_ADAPTER=mock pnpm dev</div>
              <button className="btn primary" onClick={refresh}>重新连接</button>
            </>
          )}
        </div>
      </div>
    );
  }

  if (!signedIn) {
    return (
      <Login persons={state.persons} mode={state.mode} onPick={login} onAdmin={loginAdmin} />
    );
  }

  const docMatch = hash.match(/^#\/doc\/(.+)$/);
  if (docMatch) return <Doc taskId={docMatch[1]} />;

  const nav = isAdmin ? ADMIN_NAV : MEMBER_NAV;
  // 越权路由（成员开管理页 / 管理员开「我的分身」）一律回各自首页
  const route = allowed.has(asked) ? asked : home;

  const myOpen = me ? state.tasks.filter((t) => t.ownerId === me.id && isOpen(t)).length : 0;
  const counts: Record<string, number> = isAdmin
    ? { tasks: state.tasks.filter(isOpen).length }
    : { home: myOpen, tasks: myOpen };

  const page = renderPage({ route, state, me, activities, refresh, isAdmin });

  return (
    <div className={`shell ${isAdmin ? 'as-admin' : ''}`}>
      <header className="topbar">
        <a href={`#/${home}`} className="brand">
          <BrandMark size={30} />
          <span className="bname">Everyone</span>
          <span className="bsub">每个人的分身，替每个人做事</span>
        </a>
        <span className="spacer" />
        <span
          className={`pill ${state.mode === 'lark' ? 'live' : 'mock'}`}
          title={state.mode === 'lark' ? '已连接飞书' : '模拟模式'}
        >
          <span className="pdot" />
          <span>{state.mode === 'lark' ? '已连接飞书' : '模拟模式'}</span>
        </span>
        <span
          className={`pill ${state.memoryEngineUp ? 'mem-on' : 'mem-off'}`}
          title={state.memoryEngineUp ? '四层记忆在线' : '记忆降级'}
        >
          <span className="pdot" />
          <span>{state.memoryEngineUp ? '四层记忆在线' : '记忆降级'}</span>
        </span>
        {state.bitable?.url && isAdmin && (
          <a className="ext-link" href={state.bitable.url} target="_blank" rel="noreferrer">
            <IconLink size={14} /><span>多维表格</span>
          </a>
        )}
        <UserMenu
          me={me} isAdmin={isAdmin} persons={state.persons}
          onSwitch={login} onAdmin={loginAdmin} onLogout={logout}
        />
      </header>

      <div className="shell-body">
        <nav className="sidebar">
          {nav.map((g) => (
            <div className="snav-group" key={g.label}>
              <div className="snav-label">{g.label}</div>
              {g.items.map((n) => (
                <NavLink
                  key={n.route} {...n}
                  active={route === n.route}
                  mobileActive={n.route === 'me/memory' && route.startsWith('me/')}
                  count={counts[n.route]}
                />
              ))}
            </div>
          ))}
          <div className="sfoot">
            <b>{isAdmin ? '管理员视角' : '超级代理运行中'}</b>
            {isAdmin
              ? '看得到全员任务与实时动态'
              : state.mode === 'lark' ? '监听真实飞书群消息' : '模拟模式 · 未连接飞书'}
          </div>
        </nav>
        <main className="shell-main">{page}</main>
      </div>
    </div>
  );
}

function renderPage({ route, state, me, activities, refresh, isAdmin }: {
  route: string;
  state: NonNullable<ReturnType<typeof useAppState>['state']>;
  me: Person | null;
  activities: ActivityEvent[];
  refresh: () => void;
  isAdmin: boolean;
}) {
  if (isAdmin) {
    switch (route) {
      case 'tasks': return <Tasks state={state} me={null} refresh={refresh} isAdmin />;
      case 'team': return <Team state={state} me={null} isAdmin />;
      case 'pierce': return <TimePierce state={state} me={null} isAdmin />;
      case 'heartbeats': return <Heartbeats state={state} me={null} isAdmin refresh={refresh} />;
      case 'settings': return <Settings state={state} refresh={refresh} />;
      case 'sandbox': return <AdminSandbox />;
      case 'traces': return <Traces state={state} me={null} isAdmin />;
      default: return <Board state={state} activities={activities} refresh={refresh} />;
    }
  }
  if (!me) return null;
  const tab = route.startsWith('me/') ? route.slice(3) : null;
  if (tab) return <MyAgent state={state} me={me} tab={tab as AgentTab} />;
  switch (route) {
    case 'tasks': return <Tasks state={state} me={me} refresh={refresh} isAdmin={false} />;
    case 'pierce': return <TimePierce state={state} me={me} isAdmin={false} />;
    case 'collab': return <Collab me={me} />;
    case 'heartbeats': return <Heartbeats state={state} me={me} isAdmin={false} refresh={refresh} />;
    case 'traces': return <Traces state={state} me={me} isAdmin={false} />;
    default: return <Home state={state} me={me} refresh={refresh} />;
  }
}

function NavLink({ route, label, short, mobile, icon: Icon, active, mobileActive, count }: {
  route: string;
  label: string;
  short: string;
  /** 移动端底栏放不下八项：次级项收起，由分身页内的 tab 承担切换 */
  mobile?: 'hide';
  icon: (p: { size?: number }) => JSX.Element;
  active: boolean;
  mobileActive?: boolean;
  count?: number;
}) {
  const cls = [
    'nav-item',
    active ? 'active' : '',
    mobile === 'hide' ? 'm-hide' : '',
    mobileActive ? 'm-active' : '',
  ].filter(Boolean).join(' ');
  return (
    <a href={`#/${route}`} className={cls} title={label}>
      <span className="nico"><Icon size={17} /></span>
      <span className="nfull">{label}</span>
      <span className="nshort">{short}</span>
      {count ? <span className="ncount">{count}</span> : null}
    </a>
  );
}

function UserMenu({ me, isAdmin, persons, onSwitch, onAdmin, onLogout }: {
  me: Person | null;
  isAdmin: boolean;
  persons: Person[];
  onSwitch: (id: string) => void;
  onAdmin: () => void;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="usermenu" ref={ref}>
      <button className="trigger" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {isAdmin
          ? <span className="admin-chip"><IconShield size={15} /></span>
          : <Avatar person={me} size={28} />}
        <span className="uname">{isAdmin ? '管理员' : me?.name}</span>
        <IconChevronDown size={14} color="var(--ink-4)" />
      </button>
      {open && (
        <div className="panel">
          <div className="plabel" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <IconSwap size={12} />切换身份
          </div>
          {persons.map((p) => (
            <button
              key={p.id}
              className={`pitem ${!isAdmin && p.id === me?.id ? 'on' : ''}`}
              onClick={() => { onSwitch(p.id); setOpen(false); }}
            >
              <Avatar person={p} size={24} />
              <span style={{ flex: 1, minWidth: 0 }}>{p.name}</span>
              {!isAdmin && p.id === me?.id && <span className="chk"><IconCheck size={15} /></span>}
            </button>
          ))}
          <button
            className={`pitem ${isAdmin ? 'on' : ''}`}
            onClick={() => { onAdmin(); setOpen(false); }}
          >
            <span className="admin-chip s24"><IconShield size={14} /></span>
            <span style={{ flex: 1, minWidth: 0 }}>管理员</span>
            {isAdmin && <span className="chk"><IconCheck size={15} /></span>}
          </button>
          <div className="psep" />
          <button className="pitem" onClick={onLogout}>
            <IconLogout size={16} color="var(--ink-4)" />
            退出登录
          </button>
        </div>
      )}
    </div>
  );
}

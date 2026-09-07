import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ActivityEvent, AgentRun, Assist, ChatInfo, Heartbeat, MockChatMessage, Person, Run, Task,
} from '@everyone/shared';

export interface AppState {
  mode: 'mock' | 'lark';
  demoMode: boolean;
  memoryEngineUp: boolean;
  bitable: { url: string };
  digest: { enabled: boolean; time: string };
  wiki: { time: string };
  reviewEnabled: boolean;
  completionRate: string;
  persons: Person[];
  tasks: Task[];
  runs: Run[];
  assists: Assist[];
  reviews: Array<{ persona: string; quoted_text: string; content: string; created_at: string }>;
  activities: ActivityEvent[];
  agentRuns: AgentRun[];
  chats: ChatInfo[];
  heartbeats: Heartbeat[];
}
async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  return r.json() as Promise<T>;
}

export const get = <T,>(path: string) => json<T>(path);

export const post = <T = any,>(path: string, body?: unknown) =>
  json<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const put = <T = any,>(path: string, body: unknown) =>
  json<T>(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

export const patch = <T = any,>(path: string, body: unknown) =>
  json<T>(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

export const del = <T = any,>(path: string) => json<T>(path, { method: 'DELETE' });

interface SseOptions {
  onActivity?: (a: ActivityEvent) => void;
  onMockMessage?: (m: MockChatMessage) => void;
  onMockRecall?: (msgId: string) => void;
  onMockCardUpdate?: (u: { msgId: string; card: unknown }) => void;
  onMockReaction?: (u: { msgId: string; reactions: string[] }) => void;
  onChanged?: () => void;
}

/** 订阅 server SSE，返回清理函数 */
function subscribe(opts: SseOptions): () => void {
  const es = new EventSource('/api/events');
  const parse = <T,>(e: Event) => JSON.parse((e as MessageEvent).data) as T;

  if (opts.onActivity) es.addEventListener('activity', (e) => opts.onActivity!(parse<ActivityEvent>(e)));
  if (opts.onMockMessage) es.addEventListener('mock_message', (e) => opts.onMockMessage!(parse<MockChatMessage>(e)));
  if (opts.onMockRecall) es.addEventListener('mock_recall', (e) => opts.onMockRecall!(parse<{ msgId: string }>(e).msgId));
  if (opts.onMockCardUpdate) {
    es.addEventListener('mock_card_update', (e) => opts.onMockCardUpdate!(parse<{ msgId: string; card: unknown }>(e)));
  }
  if (opts.onMockReaction) {
    es.addEventListener('mock_reaction', (e) => opts.onMockReaction!(parse<{ msgId: string; reactions: string[] }>(e)));
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  if (opts.onChanged) {
    es.addEventListener('changed', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => opts.onChanged!(), 300);
    });
  }

  return () => {
    es.close();
    if (timer) clearTimeout(timer);
  };
}

/** 主应用：/api/state + 活动流增量 */
export function useAppState() {
  const [state, setState] = useState<AppState | null>(null);
  const [activities, setActivities] = useState<ActivityEvent[]>([]);
  const [offline, setOffline] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await get<AppState>('/api/state');
      setState(s);
      setActivities(s.activities ?? []);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    return subscribe({
      onActivity: (a) => setActivities((prev) => [...prev.slice(-400), a]),
      onChanged: refresh,
    });
  }, [refresh]);

  return { state, activities, offline, refresh };
}

/** 模拟群聊：状态 + 消息流 */
export function useSimulatorState() {
  const [state, setState] = useState<AppState | null>(null);
  const [activities, setActivities] = useState<ActivityEvent[]>([]);
  const [messages, setMessages] = useState<MockChatMessage[]>([]);
  const loaded = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const s = await get<AppState>('/api/state');
      setState(s);
      setActivities((prev) => (prev.length ? prev : s.activities ?? []));
    } catch { /* server 未起，界面自行提示 */ }
  }, []);

  useEffect(() => {
    refresh();
    if (!loaded.current) {
      loaded.current = true;
      get<MockChatMessage[]>('/api/mock/history')
        .then((h) => Array.isArray(h) && setMessages(h))
        .catch(() => {});
    }
    return subscribe({
      onActivity: (a) => setActivities((prev) => [...prev.slice(-400), a]),
      onMockMessage: (m) => setMessages((prev) => (prev.some((x) => x.msgId === m.msgId) ? prev : [...prev, m])),
      onMockRecall: (msgId) => setMessages((prev) => prev.filter((m) => m.msgId !== msgId)),
      onMockCardUpdate: ({ msgId, card }) =>
        setMessages((prev) => prev.map((m) => (m.msgId === msgId ? { ...m, card } : m))),
      onMockReaction: ({ msgId, reactions }) =>
        setMessages((prev) => prev.map((m) => (m.msgId === msgId ? { ...m, reactions } : m))),
      onChanged: refresh,
    });
  }, [refresh]);

  return { state, activities, messages, refresh };
}

/** hash 路由 */
export function useHashRoute(fallback = '#/home'): string {
  const [hash, setHash] = useState(() => window.location.hash || fallback);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || fallback);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, [fallback]);
  return hash;
}

/** 轻量 toast */
export function useToast() {
  const [toast, setToast] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((text: string) => {
    setToast(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(''), 2400);
  }, []);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return { toast, show };
}

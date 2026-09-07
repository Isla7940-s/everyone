import { useCallback, useEffect, useState } from 'react';
import type { Person } from '@everyone/shared';

/**
 * 会话身份：演示环境下「登录」= 选人，不做鉴权。
 * 两种角色：
 * - member：某个成员本人，只看得到自己的任务与分身
 * - admin：管理员，看全局视图、全员台账与评审/日报开关，但没有「我的分身」
 * 选择结果落 localStorage，刷新后保持；跨标签页同步。
 */
const KEY = 'everyone.session.personId';
const ROLE_KEY = 'everyone.session.role';
const EVENT = 'everyone:session';

export type Role = 'member' | 'admin';

function read(): { personId: string | null; role: Role } {
  try {
    const role = localStorage.getItem(ROLE_KEY) === 'admin' ? 'admin' : 'member';
    return { personId: localStorage.getItem(KEY), role };
  } catch {
    return { personId: null, role: 'member' };
  }
}

function write(personId: string | null, role: Role): void {
  try {
    if (personId) localStorage.setItem(KEY, personId);
    else localStorage.removeItem(KEY);
    if (role === 'admin') localStorage.setItem(ROLE_KEY, 'admin');
    else localStorage.removeItem(ROLE_KEY);
  } catch { /* 隐私模式下静默降级 */ }
  window.dispatchEvent(new Event(EVENT));
}

export const readSessionId = () => read().personId;

/** 当前身份；persons 加载完成后校验成员 id 仍然有效 */
export function useSession(persons: Person[] | undefined) {
  const [{ personId, role }, setState] = useState(read);

  useEffect(() => {
    const sync = () => setState(read());
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  // 身份已被删除（例如换了 DATA_DIR）时退回登录页
  useEffect(() => {
    if (role === 'admin' || !persons?.length || !personId) return;
    if (!persons.some((p) => p.id === personId)) write(null, 'member');
  }, [persons, personId, role]);

  const login = useCallback((id: string) => write(id, 'member'), []);
  const loginAdmin = useCallback(() => write(null, 'admin'), []);
  const logout = useCallback(() => write(null, 'member'), []);

  const isAdmin = role === 'admin';
  const me = persons?.find((p) => p.id === personId) ?? null;
  return {
    role,
    isAdmin,
    /** 已登录（成员选了人，或以管理员进入） */
    signedIn: isAdmin || !!me,
    personId: me ? personId : null,
    me,
    login,
    loginAdmin,
    logout,
  };
}

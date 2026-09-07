import type { Person } from '@everyone/shared';
import { config } from '../config.js';

/**
 * 私信可达性（live 模式的虚拟成员没有飞书账号，--user-id 直接报参数错误）。
 * 返回 null = 不可达，调用方应跳过私信并把信息落到后台（工作台可见），不要让异常打断主流程。
 */
export function dmTargetOf(person: Person | null | undefined): { openId: string } | null {
  if (!person) return null;
  if (config.chatAdapter === 'lark') {
    return person.feishuOpenId ? { openId: person.feishuOpenId } : null;
  }
  return { openId: person.id }; // mock 模式 person.id 即会话键
}

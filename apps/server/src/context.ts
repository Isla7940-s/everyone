import type { ChatAdapter } from './lark/adapter.js';
import type { MockAdapter } from './lark/mock.js';

let _adapter: ChatAdapter | null = null;

export function setAdapter(a: ChatAdapter) {
  _adapter = a;
}

export function adapter(): ChatAdapter {
  if (!_adapter) throw new Error('adapter 尚未初始化');
  return _adapter;
}

export function mockAdapter(): MockAdapter | null {
  return _adapter?.kind === 'mock' ? (_adapter as MockAdapter) : null;
}

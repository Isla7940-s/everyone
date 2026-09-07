import { EventEmitter } from 'node:events';
import type { ActivityEvent, ActivityKind, MockChatMessage } from '@everyone/shared';

/**
 * 进程内事件总线：
 * - activity: 大屏活动流（FR-G1），SSE 推给 admin
 * - mock:*   : mock 群聊消息流，SSE 推给 mock UI
 * - task:changed / run:changed: 触发大屏数据刷新
 */
class Bus extends EventEmitter {
  private seq = 0;
  readonly recentActivities: ActivityEvent[] = [];

  activity(kind: ActivityKind, text: string, detail?: string): ActivityEvent {
    const ev: ActivityEvent = {
      id: `a${Date.now()}-${++this.seq}`,
      kind,
      text,
      detail,
      ts: new Date().toISOString(),
    };
    this.recentActivities.push(ev);
    if (this.recentActivities.length > 500) this.recentActivities.shift();
    this.emit('activity', ev);
    // 控制台一份，便于开发观察
    console.log(`[${kind}] ${text}${detail ? ` — ${detail}` : ''}`);
    return ev;
  }

  mockMessage(msg: MockChatMessage) {
    this.emit('mock:message', msg);
  }

  changed(what: 'task' | 'run' | 'assist' | 'person') {
    this.emit(`${what}:changed`);
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);

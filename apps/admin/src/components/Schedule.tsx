import { useMemo } from 'react';
import type { Person, Task } from '@everyone/shared';
import { fmtDay, isAlive, statusOf, toDateInput } from '../lib/format';
import { Avatar, Empty, TimeField } from '../ui';

/** 未来 7 天，从今天 0 点起 */
export function useSevenDays(): Date[] {
  return useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, []);
}

function byDue(a: Task, b: Task): number {
  const at = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
  const bt = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
  return at - bt;
}

/**
 * 排期甘特。两种用法：
 * - 管理员（editable）：全员任务，行内可改截止日、可点开任何任务
 * - 成员：全员排期只读，只有自己的任务可点开——看得到别人在忙什么，看不到别人任务的细节
 */
export function Schedule({ tasks, persons, days, limit = 10, editable, meId, onOpen, onDue }: {
  tasks: Task[];
  persons: Person[];
  days: Date[];
  limit?: number;
  editable: boolean;
  meId?: string;
  onOpen?: (taskId: string) => void;
  onDue?: (taskId: string, dateStr: string) => void;
}) {
  const rows = useMemo(
    () => tasks.filter(isAlive).sort(byDue).slice(0, limit),
    [tasks, limit],
  );
  const personOf = (id: string) => persons.find((p) => p.id === id);

  return (
    <>
      <div className="gantt-head">
        <span className="gname" />
        <span className="gowner" />
        <div className="gdays">
          {days.map((d, i) => (
            <span key={i} className={i === 0 ? 'today' : ''} title={`${d.getMonth() + 1}月${d.getDate()}日`}>
              {i === 0 ? '今天' : `${d.getMonth() + 1}/${d.getDate()}`}
            </span>
          ))}
        </div>
        <span className="gdue">截止日</span>
      </div>
      {rows.length === 0 && <Empty tight>暂无任务</Empty>}
      {rows.map((t) => {
        const p = personOf(t.ownerId);
        const st = statusOf(t.status);
        const mine = !!meId && t.ownerId === meId;
        const clickable = !!onOpen && (editable || mine);
        const start = days[0].getTime();
        let span = 7;
        if (t.dueAt) {
          const offset = Math.floor((new Date(t.dueAt).getTime() - start) / 86_400_000);
          span = Math.min(Math.max(offset + 1, 1), 7);
        }
        const open = clickable ? () => onOpen!(t.id) : undefined;
        // 已过期的条会被 clamp 成「今天一格」，看不出晚了——截止日标红补上这个信息
        const overdue = !!t.dueAt && new Date(t.dueAt).getTime() < Date.now() && t.status !== 'published';
        return (
          <div className={`gantt-row ${mine ? 'mine' : ''}`} key={t.id}>
            <span
              className={`gname ${clickable ? '' : 'plain'}`}
              title={t.title}
              onClick={open}
            >
              {t.title}
            </span>
            <span className="gowner">
              {p && <Avatar person={p} size={20} />}
              <span className="gon">{p?.name ?? t.ownerId}</span>
            </span>
            <div className={`gtrack ${clickable ? '' : 'plain'}`} onClick={open}>
              {days.map((_, i) => <div key={i} className={`gday ${i === 0 ? 'today' : ''}`} />)}
              <div className={`gbar ${st.tone}`} style={{ width: `calc(${(span / 7) * 100}% - 3px)` }}>
                {st.label}
              </div>
            </div>
            {editable && onDue
              ? (
                <TimeField
                  className={`gdue ${overdue ? 'over' : ''}`} value={toDateInput(t.dueAt)} display={fmtDay(t.dueAt)}
                  empty="+ 设截止" onCommit={(v) => onDue(t.id, v)}
                />
              )
              : <span className={`gdue ro ${overdue ? 'over' : ''}`}>{t.dueAt ? fmtDay(t.dueAt) : '未设定'}</span>}
          </div>
        );
      })}
    </>
  );
}

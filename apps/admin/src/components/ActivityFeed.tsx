import { useEffect, useRef } from 'react';
import type { ActivityEvent } from '@everyone/shared';
import { ACTIVITY, fmtTime } from '../lib/format';
import { Empty, IconActivity } from '../ui';

export function ActivityFeed({ activities, autoScroll = true, limit = 200 }: {
  activities: ActivityEvent[];
  autoScroll?: boolean;
  limit?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const list = activities.slice(-limit);

  useEffect(() => {
    if (autoScroll && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [activities.length, autoScroll]);

  return (
    <div className="feed" ref={ref}>
      {list.length === 0 && (
        <Empty tight icon={<IconActivity size={20} />} title="暂无活动">
          分身开始干活时，这里会实时滚动
        </Empty>
      )}
      {list.map((a) => {
        const meta = ACTIVITY[a.kind] ?? { label: a.kind, hex: '#9a9aa8' };
        return (
          <div className="feed-item" key={a.id}>
            <span className="fdot" style={{ background: meta.hex }} title={meta.label} />
            <div className="fbody">
              <div className="ftext">{a.text}</div>
              {a.detail && <div className="fdetail">{a.detail}</div>}
            </div>
            <span className="ftime">{fmtTime(a.ts)}</span>
          </div>
        );
      })}
    </div>
  );
}

import { useEffect, useState } from 'react';
import type { Task } from '@everyone/shared';
import { Markdown } from '../components/Markdown';
import { get } from '../lib/api';
import { Empty, IconArrowLeft, IconBot, IconDoc, Tag } from '../ui';

/** 分身产出的文档阅读页（mock 模式下的「飞书文档」替代） */
export function Doc({ taskId, backHash = '#/tasks', backLabel = '返回任务台账' }: {
  taskId: string;
  backHash?: string;
  backLabel?: string;
}) {
  const [doc, setDoc] = useState<{ markdown: string; task: Task | null } | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    get<{ markdown?: string; task?: Task | null; error?: string }>(`/api/mock/doc/${taskId}`)
      .then((d) => {
        if (d.error || typeof d.markdown !== 'string') throw new Error('文档不存在或已被清理');
        setDoc({ markdown: d.markdown, task: d.task ?? null });
      })
      .catch((e) => setErr(String(e.message ?? e)));
  }, [taskId]);

  return (
    <div className="shell-main" style={{ height: '100vh' }}>
      <div className="doc-shell">
        <div className="doc-bar">
          <a href={backHash}>
            <button className="btn sm"><IconArrowLeft size={14} />{backLabel}</button>
          </a>
          {doc?.task && (
            <>
              <span style={{ fontWeight: 600, letterSpacing: '-0.012em' }}>{doc.task.title}</span>
              <Tag tone="purple"><IconBot size={12} />分身起草</Tag>
            </>
          )}
        </div>
        <div className="doc-body">
          {err && <Empty icon={<IconDoc size={20} />} title={err}>产出文档保存在实例的 DATA_DIR 里</Empty>}
          {!doc && !err && <Empty tight>加载中…</Empty>}
          {doc && <Markdown text={doc.markdown} />}
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { SandboxBrowser, type SandboxEntry } from '../components/SandboxBrowser';
import { get } from '../lib/api';
import { Segmented } from '../ui';

/**
 * 管理员 · 沙箱（需求 3）：查看维护超级代理本身的沙箱。
 * _agent = Agent 对话模式按天沙箱（sessions/<会话>/ 任务书与产物）；
 * _heartbeat = 心跳任务沙箱（一任务一目录，跨触发持久）；
 * _wiki = 群知识库沙箱（一群一目录，wiki.md 即知识库工作副本）。
 */

interface WsData {
  person: { name: string; workspaceDir: string };
  files: SandboxEntry[];
}

const ROOT_LABELS: Record<string, string> = {
  _agent: '超级代理沙箱',
  _heartbeat: '心跳任务沙箱',
  _wiki: '群知识库沙箱',
};

export function AdminSandbox() {
  const [which, setWhich] = useState<'_agent' | '_heartbeat' | '_wiki'>('_agent');
  const [data, setData] = useState<WsData | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await get<WsData>(`/api/workspace/${which}`));
    } catch {
      setData(null);
    }
  }, [which]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>沙箱</h1>
          <div className="desc">超级代理本体的工作现场 · Agent 对话按天隔离，心跳任务一任务一目录，群知识库一群一目录</div>
        </div>
        <Segmented
          value={which}
          options={[
            { value: '_agent', label: 'Agent 对话沙箱' },
            { value: '_heartbeat', label: '心跳任务沙箱' },
            { value: '_wiki', label: '群知识库沙箱' },
          ]}
          onChange={(v) => setWhich(v as never)}
        />
      </div>
      <div className="card">
        {data === null
          ? <div className="card-body"><div className="sb-loading">读取中…</div></div>
          : (
            <SandboxBrowser
              personId={which}
              entries={data.files}
              tasks={[]}
              rootLabel={ROOT_LABELS[which] ?? which}
              rootPath={data.person.workspaceDir}
              canUpload={false}
              onUploaded={load}
            />
          )}
      </div>
    </div>
  );
}

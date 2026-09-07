import fs from 'node:fs';
import path from 'node:path';
import type { Task } from '@everyone/shared';
import { quadrantOf } from '@everyone/shared';
import { bus } from '../bus.js';
import { config } from '../config.js';
import { larkExec } from '../lark/exec.js';
import { persons, tasks } from '../store/repo.js';

/**
 * 多维表格对外台账（FR-B1/B2/B4）。
 * - SQLite 是事实源，Bitable 是对外镜像；写失败重试，最终失败降级（FR-I2）
 * - base_token/table_id 持久化在 data/bitable.json
 */

interface BitableState {
  baseToken: string;
  tableId: string;
  url: string;
}

const statePath = () => path.join(config.dataDir, 'bitable.json');
let state: BitableState | null = null;
let degraded = false;

const STATUS_LABEL: Record<string, string> = {
  pending_confirm: '待确认', todo: '待办', running: '分身进行中', reviewing: '待审阅', published: '已发布', cancelled: '已取消',
};
const SOURCE_LABEL: Record<string, string> = {
  commitment: '承诺', meeting: '会议', mention: '@指派', manual: '手动',
};
const QUADRANT_LABEL: Record<number, string> = { 1: 'Q1 重要紧急', 2: 'Q2 重要不紧急', 3: 'Q3 紧急不重要', 4: 'Q4 不重要不紧急' };

const FIELDS = [
  { name: '任务名', type: 'text' },
  { name: '负责人', type: 'text' },
  { name: '来源', type: 'select', options: Object.values(SOURCE_LABEL).map((name) => ({ name })) },
  { name: '重要', type: 'checkbox' },
  { name: '紧急', type: 'checkbox' },
  { name: '象限', type: 'select', options: Object.values(QUADRANT_LABEL).map((name) => ({ name })) },
  { name: '截止时间', type: 'date' },
  { name: '状态', type: 'select', options: Object.values(STATUS_LABEL).map((name) => ({ name })) },
  { name: '产出链接', type: 'url' },
  { name: '源消息链接', type: 'url' },
  { name: '任务ID', type: 'text' },
];

export function bitableState(): { state: BitableState | null; degraded: boolean } {
  return { state, degraded };
}

/** 启动时确保台账存在（仅 live 模式；mock 模式跳过） */
export async function ensureLedger(): Promise<void> {
  if (config.chatAdapter !== 'lark') return;
  try {
    if (fs.existsSync(statePath())) {
      state = JSON.parse(fs.readFileSync(statePath(), 'utf-8'));
      ensureLedgerViews().catch((e) => bus.activity('system', 'Bitable 视图确保失败（表格仍可用）', String(e).slice(0, 150)));
      return;
    }
    const data = await larkExec<any>([
      'base', '+base-create', '--as', 'user',
      '--name', 'Everyone 任务台账',
      '--table-name', '任务台账',
      '--fields', JSON.stringify(FIELDS),
      '--time-zone', 'Asia/Shanghai',
    ], { timeoutMs: 60_000 });
    const baseToken = data?.base?.base_token ?? data?.base_token ?? '';
    const url = data?.base?.url ?? data?.url ?? '';
    // 查 table id
    const tables = await larkExec<any>(['base', '+table-list', '--as', 'user', '--base-token', baseToken]);
    const tableId = tables?.tables?.[0]?.id ?? tables?.items?.[0]?.table_id ?? '';
    state = { baseToken, tableId, url };
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
    bus.activity('system', 'Bitable 台账已创建', url);
  } catch (e) {
    degraded = true;
    bus.activity('system', 'Bitable 不可用，降级 SQLite-only（FR-I2）', String(e).slice(0, 200));
  }
  ensureLedgerViews().catch((e) => bus.activity('system', 'Bitable 视图确保失败（表格仍可用）', String(e).slice(0, 150)));
}

/** FR-B2：确保「四象限看板」与「排期甘特」两个视图存在（幂等；缺 shortcut 时走原生 API） */
async function ensureLedgerViews(): Promise<void> {
  if (!state || degraded) return;
  const list = await larkExec<any>([
    'api', 'GET', `/open-apis/bitable/v1/apps/${state.baseToken}/tables/${state.tableId}/views`, '--as', 'user',
  ]);
  const views: Array<{ view_name: string; view_type: string }> = list?.items ?? [];
  const want: Array<{ name: string; type: string }> = [
    { name: '四象限看板', type: 'kanban' },
    { name: '排期甘特', type: 'gantt' },
  ];
  for (const w of want) {
    if (views.some((v) => v.view_name === w.name)) continue;
    await larkExec<any>([
      'api', 'POST', `/open-apis/bitable/v1/apps/${state.baseToken}/tables/${state.tableId}/views`, '--as', 'user',
      '--data', JSON.stringify({ view_name: w.name, view_type: w.type }),
    ]);
    bus.activity('system', `Bitable 视图已创建：${w.name}`, w.type);
  }
}

function fmtBitableTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 任务 → Bitable 记录字段（CellValue happy path：select 用数组、日期用字符串、url 用文本） */
function toFields(t: Task): Record<string, unknown> {
  const owner = persons.byId(t.ownerId);
  const fields: Record<string, unknown> = {
    任务名: t.title,
    负责人: owner?.name ?? t.ownerId,
    来源: [SOURCE_LABEL[t.source] ?? t.source],
    重要: t.important,
    紧急: t.urgent,
    象限: [QUADRANT_LABEL[quadrantOf(t)]],
    状态: [STATUS_LABEL[t.status] ?? t.status],
    任务ID: t.id,
  };
  if (t.dueAt) fields['截止时间'] = fmtBitableTime(t.dueAt);
  if (t.docUrl && t.docUrl.startsWith('http')) fields['产出链接'] = t.docUrl;
  if (t.srcMsgLink && t.srcMsgLink.startsWith('http')) fields['源消息链接'] = t.srcMsgLink;
  return fields;
}

/** 同步一条任务（FR-B4：重试；失败只告警不阻塞） */
export async function syncTaskToBitable(t: Task, attempt = 1): Promise<void> {
  if (config.chatAdapter !== 'lark' || degraded || !state) return;
  try {
    const args = [
      'base', '+record-upsert', '--as', 'user',
      '--base-token', state.baseToken, '--table-id', state.tableId,
      '--json', JSON.stringify(toFields(t)),
    ];
    if (t.bitableRecordId) args.push('--record-id', t.bitableRecordId);
    const data = await larkExec<any>(args);
    if (!t.bitableRecordId) {
      const recordId = data?.record?.record_id_list?.[0] ?? data?.record?.record_id ?? data?.record_id ?? '';
      if (recordId) tasks.update(t.id, { bitableRecordId: recordId });
    }
  } catch (e) {
    if (attempt < 3) {
      setTimeout(() => syncTaskToBitable(tasks.byId(t.id) ?? t, attempt + 1), attempt * 5000);
    } else {
      bus.activity('system', `Bitable 同步失败（已重试 ${attempt} 次）`, String(e).slice(0, 150));
    }
  }
}

export function ledgerUrl(): string {
  return state?.url ?? '';
}

/** 启动补同步：把 Bitable 建好前遗留的未同步任务批量 upsert（幂等：靠 bitableRecordId 判断） */
export async function backfillLedger(): Promise<void> {
  if (config.chatAdapter !== 'lark' || degraded || !state) return;
  const pending = tasks.all().filter((t) => !t.bitableRecordId && t.status !== 'cancelled');
  if (!pending.length) return;
  bus.activity('system', `Bitable 补同步 ${pending.length} 条历史任务`);
  for (const t of pending) {
    await syncTaskToBitable(t).catch(() => {});
    await new Promise((r) => setTimeout(r, 400)); // 限速，避免触发风控
  }
}

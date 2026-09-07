import fs from 'node:fs';
import path from 'node:path';
import { bus } from './bus.js';
import { config } from './config.js';
import { ensureWorkspace } from './executor/workspace.js';
import { chatMembers } from './lark/im.js';
import { kv, persons } from './store/repo.js';

/** demo 虚构成员（D10：全部假数据；红线 §9：不用真实同事） */
const DEMO_MEMBERS = [
  { id: 'xiaoming', name: '小明', color: '#3370FF' },
  { id: 'xiaohong', name: '小红', color: '#F54A45' },
  { id: 'laowang', name: '老王', color: '#34C724' },
];

/**
 * 隔离实例（DATA_DIR=data-xxx → 独立 workspacesDir）首次启动时，从主工作区拷贝
 * demo 成员的演示资产（画像/技能/代码仓）——否则隔离实例里分身没有记忆、没技能、
 * repo 为空，「翻仓库代答」「代码任务」这些场景全都演不了。
 */
function seedDemoAssets(id: string): void {
  const canonical = path.join(config.root, 'workspaces');
  if (path.resolve(config.workspacesDir) === canonical) return; // 主实例无需拷贝
  const src = path.join(canonical, id);
  if (!fs.existsSync(src)) return;
  const dst = path.join(config.workspacesDir, id);
  fs.mkdirSync(dst, { recursive: true });

  // 逐项判断而不是「目录已存在就整个跳过」：ensureWorkspace 会先把空骨架建出来，
  // 按目录判断的话永远命中「已初始化」，隔离实例就一直是没技能没仓库的空壳
  let copied = false;
  for (const part of ['skills', 'repo']) {
    const s = path.join(src, part);
    const d = path.join(dst, part);
    if (!fs.existsSync(s)) continue;
    if (fs.existsSync(d) && fs.readdirSync(d).length) continue; // 已有内容，不覆盖
    fs.cpSync(s, d, { recursive: true });
    copied = true;
  }
  const srcMem = path.join(src, 'memory.md');
  const dstMem = path.join(dst, 'memory.md');
  // 只在画像还是 ensureWorkspace 的空模板时才覆盖，别把实例里攒下的沉淀冲掉
  const untouched = !fs.existsSync(dstMem)
    || fs.readFileSync(dstMem, 'utf-8').includes('（在管理后台补充你的负责域与偏好）');
  if (fs.existsSync(srcMem) && untouched) {
    fs.copyFileSync(srcMem, dstMem);
    copied = true;
  }
  if (copied) bus.activity('system', `演示资产已注入隔离工作区：${id}`, '画像 + 技能 + 代码仓');
}

export async function seedPersons(): Promise<void> {
  for (const m of DEMO_MEMBERS) {
    persons.upsert({
      id: m.id,
      feishuOpenId: null,
      name: m.name,
      workspaceDir: `${config.workspacesRel}/${m.id}`,
      avatarColor: m.color,
      isBot: false,
    });
    seedDemoAssets(m.id);
    ensureWorkspace(m.id, m.name);
  }

  // live 模式：同步 demo 群真实成员（open_id 绑定）
  if (config.chatAdapter === 'lark' && config.lark.demoChatId) {
    try {
      const { users, botOpenIds } = await chatMembers(config.lark.demoChatId);
      for (const m of users) {
        if (!m.member_id?.startsWith('ou_')) continue;
        const existing = persons.byOpenId(m.member_id);
        if (existing) continue;
        const id = `u_${m.member_id.slice(-8)}`;
        persons.upsert({
          id,
          feishuOpenId: m.member_id,
          name: m.name || id,
          workspaceDir: `${config.workspacesRel}/${id}`,
          avatarColor: '#7B67EE',
          isBot: false,
        });
        ensureWorkspace(id, m.name || id);
      }
      if (botOpenIds.length) kv.setJson('bot_open_ids', botOpenIds);
      bus.activity('system', `已同步 ${users.length} 名群成员`, config.lark.demoChatId);
    } catch (e) {
      bus.activity('system', '群成员同步失败（不阻塞启动）', String(e).slice(0, 150));
    }
  }
  bus.changed('person');
}

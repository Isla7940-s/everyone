import type { MemberJoinedEvent, Person } from '@everyone/shared';
import { bus } from '../bus.js';
import { config } from '../config.js';
import { adapter } from '../context.js';
import { ensureWorkspace } from '../executor/workspace.js';
import * as cards from '../ledger/cards.js';
import { dmTargetOf } from '../lark/dm.js';
import { chatJson } from '../llm/client.js';
import * as memory from '../memory/index.js';
import { prompt } from '../prompts.js';
import { chatLog, kv, persons, tasks } from '../store/repo.js';

/** 同一人 24h 内不重复发指引（退群重进/事件与轮询双通道重复触发都拦在这里） */
const ONBOARD_COOLDOWN_MS = 24 * 3600_000;

export interface OnboardBrief {
  project_summary: string;
  current_state: string[];
  key_info: string[];
  who_is_who: string[];
  tips: string[];
}

/**
 * 入群快速指引（新功能 1）：
 * 新成员进群 → 注册 person + 工作区 → 汇总群上下文生成项目指引 → 私信新成员。
 * 私信不属于 §6.0 需要确认的对外输出（不发群、不以他人名义），可直接发送。
 */
export async function handleMemberJoined(evt: MemberJoinedEvent): Promise<void> {
  for (const m of evt.members) {
    try {
      await onboardOne(evt.chatId, m.openId, m.name, evt.via);
    } catch (e) {
      bus.activity('system', `入群指引生成失败（${m.name || m.openId}）`, String(e).slice(0, 200));
    }
  }
}

async function onboardOne(chatId: string, openId: string, name: string, via: MemberJoinedEvent['via']): Promise<void> {
  const person = ensureMemberRegistered(openId, name);
  if (!person) return;

  // 幂等：事件 + 轮询双通道、退群重进，24h 内只发一次
  const key = `onboarded:${chatId}:${person.id}`;
  const last = kv.get(key);
  if (last && Date.now() - new Date(last).getTime() < ONBOARD_COOLDOWN_MS) {
    bus.activity('system', `${person.name} 24h 内已收过快速指引，跳过`, `via ${via}`);
    return;
  }

  bus.activity('assist', `新成员 ${person.name} 入群（${via}），生成项目快速指引`, chatId.slice(0, 18));

  const brief = await buildOnboardBrief(person.name, chatId);
  kv.set(key, new Date().toISOString());

  // 入群事实进群记忆（其他人问「谁是新来的」时可召回）
  memory.capture({
    personId: person.id, chatId,
    content: `${person.name} 加入了群聊，Everyone 已私信项目快速指引`,
    sourceLink: null, kind: 'chat',
  }).catch(() => {});

  const to = dmTargetOf(person);
  if (!to) {
    bus.activity('assist', `${person.name} 是虚拟成员（无飞书账号），指引已生成未私信`, brief.project_summary.slice(0, 80));
    return;
  }
  const card = cards.onboardCard(person.name, brief);
  await adapter().sendCard(to, card, `onboard-${chatId}-${person.id}`);
  bus.activity('send', `项目快速指引已私信 ${person.name}`, brief.project_summary.slice(0, 80));
}

/** 新成员注册（live 事件里只有 open_id/name；mock 由 /api/mock/join 预建，这里兜底） */
function ensureMemberRegistered(openId: string, name: string): Person | null {
  let person = persons.byOpenId(openId) ?? persons.byId(openId);
  if (person) return person;
  if (config.chatAdapter === 'lark' && !openId.startsWith('ou_')) return null;
  const id = openId.startsWith('ou_') ? `u_${openId.slice(-8)}` : openId;
  persons.upsert({
    id,
    feishuOpenId: openId.startsWith('ou_') ? openId : null,
    name: name || id,
    workspaceDir: `${config.workspacesRel}/${id}`,
    avatarColor: '#7B67EE',
    isBot: false,
  });
  ensureWorkspace(id, name || id);
  person = persons.byId(id);
  bus.activity('system', `新成员已注册：${person?.name}`, openId);
  bus.changed('person');
  return person;
}

/** 汇总群上下文 → LLM 生成指引；LLM 失败降级为模板拼接（指引必须发得出去） */
export async function buildOnboardBrief(newMemberName: string, chatId: string): Promise<OnboardBrief> {
  const memberLines = persons.all().map((p) => {
    const mem = memory.readPersonMemory(p.id);
    const domainLine = mem.split('\n').find((l) => l.includes('负责域')) ?? '';
    const open = tasks.openTasksOf(p.id);
    return `${p.name}（${p.id}）| ${domainLine.replace(/^-\s*/, '') || '负责域未填'} | 未完成任务 ${open.length} 条${open.length ? `：${open.slice(0, 3).map((t) => t.title).join('、')}` : ''}`;
  }).join('\n') || '（暂无成员资料）';

  const taskLines = tasks.all({ statuses: ['pending_confirm', 'todo', 'running', 'reviewing'] })
    .slice(0, 30)
    .map((t) => {
      const owner = persons.byId(t.ownerId);
      return `${owner?.name ?? t.ownerId} | ${t.title} | ${t.status} | 截止 ${t.dueAt ? t.dueAt.slice(0, 10) : '未定'}`;
    }).join('\n') || '（台账为空）';

  const recent = chatLog.recent(chatId, 60)
    .map((r) => `${r.senderName ?? '成员'}：${(r.text ?? '').slice(0, 120)}`)
    .join('\n') || '（群里还没有聊天记录）';

  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  try {
    const brief = await chatJson<OnboardBrief>(
      '你是项目快速指引生成器，只输出 JSON。',
      prompt('onboard_brief', {
        today: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
        weekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()],
        new_member: newMemberName,
        members: memberLines,
        tasks: taskLines,
        recent: recent.slice(0, 16_000),
      }),
      { temperature: 0.3 },
    );
    if (brief?.project_summary) {
      return {
        project_summary: brief.project_summary,
        current_state: (brief.current_state ?? []).slice(0, 5),
        key_info: (brief.key_info ?? []).slice(0, 5),
        who_is_who: (brief.who_is_who ?? []).slice(0, 8),
        tips: (brief.tips ?? []).slice(0, 3),
      };
    }
    throw new Error('LLM 指引为空');
  } catch (e) {
    bus.activity('system', '指引 LLM 生成失败，降级为模板拼接', String(e).slice(0, 120));
    const openTasks = tasks.all({ statuses: ['todo', 'running', 'reviewing'] });
    return {
      project_summary: `这个群正在推进中的项目有 ${openTasks.length} 条未完成任务，成员 ${persons.all().length} 人。详细背景可以在群里 @Everyone 问我。`,
      current_state: openTasks.slice(0, 5).map((t) => `${persons.byId(t.ownerId)?.name ?? t.ownerId}：${t.title}（${t.status}）`),
      key_info: [],
      who_is_who: persons.all().map((p) => `${p.name}：未完成任务 ${tasks.openTasksOf(p.id).length} 条`),
      tips: ['@Everyone 说「四象限」或「排期」可以看任务全景', '在群里的承诺我会自动记录，确认后入台账'],
    };
  }
}

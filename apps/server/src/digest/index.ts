import { bus } from '../bus.js';
import { config } from '../config.js';
import { adapter } from '../context.js';
import { digestCard, personalDigestCard } from '../ledger/cards.js';
import { completionRate, sendScheduleImage } from '../ledger/tasks.js';
import { dmTargetOf } from '../lark/dm.js';
import { chatJson } from '../llm/client.js';
import { prompt } from '../prompts.js';
import { assists, chatLog, persons, runs, tasks } from '../store/repo.js';

function localDateStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 管理员开关与时间（FR-E3） */
export const digestState = {
  enabled: true,
  time: config.digestTime, // HH:mm
  lastSentDate: '',
};

export function startDigestScheduler(): void {
  setInterval(() => {
    if (!digestState.enabled) return;
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const today = localDateStr(now);
    if (hhmm === digestState.time && digestState.lastSentDate !== today) {
      digestState.lastSentDate = today;
      generateAndSendDigest().catch((e) => bus.activity('system', '日报生成失败', String(e).slice(0, 200)));
      // 日报分层：群发总报的同时，逐人私信个人日报（互不阻塞）
      generateAndSendPersonalDigests().catch((e) => bus.activity('system', '个人日报生成失败', String(e).slice(0, 200)));
    }
  }, 30_000);
}

/** 生成并发送日报（S5/FR-E1/E2），可由后台手动触发 */
export async function generateAndSendDigest(): Promise<void> {
  const chatId = adapter().demoChatId;
  const msgs = chatLog.todayOf(chatId);
  bus.activity('digest', `开始生成日报（今日 ${msgs.length} 条消息）`);

  const msgLines = msgs.map((m) => {
    const t = new Date(m.ts);
    return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')} | ${m.senderName ?? '成员'} | ${m.text.slice(0, 100)}`;
  }).join('\n') || '（今天群里没有消息）';

  const taskLines = tasks.all().slice(0, 30).map((t) => {
    const owner = persons.byId(t.ownerId);
    return `${owner?.name ?? t.ownerId} | ${t.title} | ${t.status} | ${t.dueAt ?? '无截止'}`;
  }).join('\n') || '（台账为空）';

  const d = new Date();
  // 分身今日工作：今天更新且已发布/待审阅的任务（日报「替你做」成果段）
  // 注意：updatedAt 是 UTC ISO，必须转本地日期再比较（凌晨时段 startsWith 会整段漏掉）
  const todayStr = localDateStr(d);
  const avatarLines = tasks.all()
    .filter((t) => (t.status === 'published' || t.status === 'reviewing') && t.updatedAt && localDateStr(new Date(t.updatedAt)) === todayStr)
    .slice(0, 10)
    .map((t) => {
      const owner = persons.byId(t.ownerId);
      const kind = t.taskKind === 'code' ? '代码修改' : '产出文档';
      return `${owner?.name ?? t.ownerId} | ${t.title} | ${t.status === 'published' ? `已发布（${kind}）` : '初稿待本人审阅'}`;
    }).join('\n') || '（分身今天没有产出）';

  const digest = await chatJson<{
    title: string;
    key_decisions: string[]; new_commitments: string[]; avatar_done: string[]; unanswered_mentions: string[];
    due_tomorrow: string[]; fun_moments: string[];
  }>(
    '你是群日报导读生成器，只输出 JSON。',
    prompt('daily_digest', {
      today: localDateStr(d),
      weekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()],
      messages: msgLines.slice(0, 20_000),
      tasks: taskLines,
      avatar_work: avatarLines,
    }),
    { temperature: 0.3 },
  );

  const dateStr = `${d.getMonth() + 1}/${d.getDate()}`;
  // 海报形式为主（发起人需求⑤，黑金长图）：渲染失败降级为原卡片，信息不丢
  try {
    const { renderDigestPoster } = await import('../render/poster.js');
    const newTasksToday = tasks.all().filter((t) => t.createdAt >= new Date(new Date(d).setHours(0, 0, 0, 0)).toISOString() && t.status !== 'cancelled').length;
    const png = renderDigestPoster({
      ...digest,
      stats: { messages: msgs.length, newTasks: newTasksToday, avatarDone: (digest.avatar_done ?? []).length },
    }, completionRate(), d);
    await adapter().sendImage({ chatId }, png, `digest-${localDateStr(d)}`);
    bus.activity('digest', '日报海报已发群', png);
  } catch (e) {
    bus.activity('system', '日报海报渲染失败，降级卡片', String(e).slice(0, 150));
    const card = digestCard(digest, completionRate(), dateStr);
    await adapter().sendCard({ chatId }, card, `digest-${localDateStr(d)}`);
  }
  // FR-E2：附全群排期图
  await sendScheduleImage(chatId);
  bus.activity('digest', `日报已发群`, `完成率 ${completionRate()}`);

  // 群知识库跟随日报更新（需求⑥）：日报生成的同时发起 Agent 整理今日新记录进知识库
  try {
    const { chats } = await import('../store/repo.js');
    if (chats.byId(chatId)?.wikiEnabled) {
      const { runWikiUpdate } = await import('../agent/wiki.js');
      runWikiUpdate(chatId, '日报同步').catch((e) => bus.activity('system', '群知识库随日报更新失败', String(e).slice(0, 150)));
    }
  } catch { /* wiki 模块异常不阻断日报 */ }
}

// ===== 日报分层（新功能 2）：个人日报私信 =====

/** 汇总某人当日的分身工作（纯数据模板，不走 LLM——确定、快、零幻觉） */
export function collectPersonalDigest(personId: string, now = new Date()): {
  avatarWork: string[]; answered: string[]; collected: string[]; newTasks: string[]; dueSoon: string[]; overdue: string[];
} | null {
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const sinceIso = dayStart.toISOString();
  const my = (t: { ownerId: string }) => t.ownerId === personId;

  // 分身替你做：今天有执行记录（成功产出）或今天发布/待审阅的任务
  const myTasks = tasks.all({ ownerId: personId });
  const taskById = new Map(myTasks.map((t) => [t.id, t]));
  const ranTaskIds = new Set(
    runs.all(300).filter((r) => r.startedAt >= sinceIso && r.status === 'succeeded' && taskById.has(r.taskId)).map((r) => r.taskId),
  );
  const avatarWork = myTasks
    .filter((t) => (ranTaskIds.has(t.id) || ((t.status === 'published' || t.status === 'reviewing') && t.updatedAt >= sinceIso)))
    .slice(0, 6)
    .map((t) => `${t.title}（${t.status === 'published' ? '已发布' : t.status === 'reviewing' ? '初稿等你审' : t.status}）`);

  // 分身替你答/收（assists 审计表）
  const myAssists = assists.ofPersonSince(personId, sinceIso);
  const answered = myAssists.filter((a) => a.type === 'answer').slice(0, 6)
    .map((a) => `${a.content.slice(0, 60)}${a.status === 'retracted' ? '（已撤回）' : a.status === 'skipped' ? '（没把握，只私信了建议）' : ''}`);
  const collected = myAssists.filter((a) => a.type === 'collect').slice(0, 6)
    .map((a) => `${a.content.slice(0, 60)}（${a.status === 'converted' ? '已转任务' : a.status === 'rejected' ? '你说不归你管' : a.status === 'acked' ? '你已知晓' : '待你处理'}）`);

  // 今天新排给你的任务（不含已取消）
  const newTasks = tasks.all().filter((t) => my(t) && t.createdAt >= sinceIso && t.status !== 'cancelled')
    .slice(0, 6).map((t) => `${t.title}${t.dueAt ? `（截止 ${t.dueAt.slice(5, 10)}）` : ''}`);

  // 排期提醒：48h 内到期 / 已逾期（未完成口径）
  const open = tasks.openTasksOf(personId).filter((t) => t.dueAt);
  const dueSoon = open.filter((t) => {
    const diff = new Date(t.dueAt!).getTime() - now.getTime();
    return diff > 0 && diff <= 48 * 3600_000;
  }).slice(0, 6).map((t) => `${t.title}（${fmtShort(t.dueAt!)}）`);
  const overdue = open.filter((t) => new Date(t.dueAt!).getTime() < now.getTime())
    .slice(0, 6).map((t) => `${t.title}（本应 ${fmtShort(t.dueAt!)}）`);

  if (!avatarWork.length && !answered.length && !collected.length && !newTasks.length && !dueSoon.length && !overdue.length) {
    return null; // 今天没有任何与此人相关的分身动作 → 不打扰
  }
  return { avatarWork, answered, collected, newTasks, dueSoon, overdue };
}

/** 逐人生成并私信个人日报；无内容的人跳过，虚拟成员落活动流 */
export async function generateAndSendPersonalDigests(): Promise<{ sent: number; skipped: number }> {
  const d = new Date();
  const dateStr = `${d.getMonth() + 1}/${d.getDate()}`;
  let sent = 0; let skipped = 0;
  for (const p of persons.all()) {
    try {
      const data = collectPersonalDigest(p.id, d);
      if (!data) { skipped += 1; continue; }
      const to = dmTargetOf(p);
      if (!to) {
        bus.activity('digest', `个人日报生成（${p.name} 为虚拟成员，未私信）`, summaryLine(data));
        skipped += 1;
        continue;
      }
      await adapter().sendCard(to, personalDigestCard(p.name, dateStr, data), `pdigest-${p.id}-${localDateStr(d)}`);
      bus.activity('digest', `个人日报已私信 ${p.name}`, summaryLine(data));
      sent += 1;
    } catch (e) {
      bus.activity('system', `个人日报发送失败（${p.name}）`, String(e).slice(0, 150));
    }
  }
  bus.activity('digest', `个人日报本轮完成：发送 ${sent} 份，跳过 ${skipped} 人`);
  return { sent, skipped };
}

function summaryLine(data: ReturnType<typeof collectPersonalDigest> & object): string {
  return `做${data.avatarWork.length} 答${data.answered.length} 收${data.collected.length} 新任务${data.newTasks.length} 将到期${data.dueSoon.length} 逾期${data.overdue.length}`;
}

function fmtShort(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

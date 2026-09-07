import type { Task } from '@everyone/shared';

/** 飞书交互卡片 JSON（schema 1.0，mock UI 渲染同一结构） */

const QUADRANT_NAME: Record<number, string> = { 1: '重要 · 紧急', 2: '重要 · 不紧急', 3: '紧急 · 不重要', 4: '不重要 · 不紧急' };

function fmtDue(dueAt: string | null): string {
  if (!dueAt) return '未设截止时间';
  const d = new Date(dueAt);
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}（${wd}）${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function btn(text: string, action: string, value: Record<string, string>, type: 'primary' | 'default' | 'danger' = 'default') {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    value: { action, ...value },
  };
}

/** 任务确认卡（FR-B3）：确认 / 修改 / 忽略 */
export function taskConfirmCard(task: Task, ownerName: string, srcText: string): unknown {
  const q = (task.important ? (task.urgent ? 1 : 2) : (task.urgent ? 3 : 4));
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: '📌 发现一个新任务，等你拍板' } },
    elements: [
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**任务**\n${task.title}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**负责人**\n${ownerName}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**截止**\n${fmtDue(task.dueAt)}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**象限**\n${QUADRANT_NAME[q]}` } },
        ],
      },
      { tag: 'div', text: { tag: 'lark_md', content: `**来源**：${srcText.length > 80 ? srcText.slice(0, 80) + '…' : srcText}` } },
      {
        tag: 'action',
        actions: [
          btn('✅ 确认入账', 'task_confirm', { task_id: task.id }, 'primary'),
          btn('✏️ 修改', 'task_edit', { task_id: task.id }),
          btn('忽略', 'task_ignore', { task_id: task.id }, 'danger'),
        ],
      },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '确认后才入台账（人工确认铁律）· 按钮没反应？直接回复：确认 / 忽略，或点「修改」后用文字改' }] },
    ],
  };
}

/** 确认后的静态卡（原地更新） */
export function taskConfirmedCard(task: Task, ownerName: string, verdict: '已入台账' | '已忽略' | '待修改'): unknown {
  const color = verdict === '已入台账' ? 'green' : verdict === '已忽略' ? 'grey' : 'orange';
  const icon = verdict === '已入台账' ? '✅' : verdict === '已忽略' ? '🚫' : '✏️';
  return {
    config: { wide_screen_mode: true },
    header: { template: color, title: { tag: 'plain_text', content: `${icon} ${task.title} · ${verdict}` } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `负责人 **${ownerName}** · 截止 ${fmtDue(task.dueAt)}${verdict === '待修改' ? '\n直接回复文字修改，如「改到周六」「负责人改成小红」' : ''}` } },
    ],
  };
}

/** 分身初稿私信卡（FR-C5）：查看 / 发布 / 放弃 + 文字迭代提示 */
export function draftCard(task: Task, docUrl: string, iteration: number, summary: string): unknown {
  return {
    config: { wide_screen_mode: true },
    header: { template: 'purple', title: { tag: 'plain_text', content: iteration === 1 ? `🤖 你的分身写完初稿了` : `🤖 第 ${iteration} 稿改好了` } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**${task.title}**\n${summary}` } },
      {
        tag: 'action',
        actions: [
          { tag: 'button', text: { tag: 'plain_text', content: '👀 查看全文' }, type: 'default', url: docUrl, value: { action: 'noop' } },
          btn('🚀 发布到群', 'draft_publish', { task_id: task.id }, 'primary'),
          btn('放弃任务', 'draft_abort', { task_id: task.id }, 'danger'),
        ],
      },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '直接回复文字 = 修改意见，分身立刻改（不限次数）· 按钮没反应？回复：发布 / 放弃' }] },
    ],
  };
}

/** 帮你收私信卡（FR-J2）：知道了 / 转为任务 / 不归我管 */
export function collectCard(assistId: string, opinionText: string, senderName: string, srcLink: string | null): unknown {
  return {
    config: { wide_screen_mode: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: '📥 群里有条意见，可能归你管' } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `> ${opinionText}\n—— ${senderName}${srcLink ? ` · [查看原文](${srcLink})` : ''}` } },
      { tag: 'div', text: { tag: 'lark_md', content: '已记入你的记忆。要不要进一步处理？' } },
      {
        tag: 'action',
        actions: [
          btn('知道了', 'collect_ack', { assist_id: assistId }),
          btn('📋 转为任务', 'collect_to_task', { assist_id: assistId }, 'primary'),
          btn('不归我管', 'collect_reject', { assist_id: assistId }, 'danger'),
        ],
      },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '按钮没反应？直接回复：知道了 / 转任务 / 不归我管' }] },
    ],
  };
}

/** 帮你收处理完的静态卡 */
export function collectDoneCard(opinionText: string, verdict: string): unknown {
  return {
    config: { wide_screen_mode: true },
    header: { template: 'grey', title: { tag: 'plain_text', content: `📥 意见 · ${verdict}` } },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: `> ${opinionText}` } }],
  };
}

/** 日报卡片（FR-E1） */
export function digestCard(digest: {
  key_decisions: string[]; new_commitments: string[]; avatar_done?: string[]; unanswered_mentions: string[];
  due_tomorrow: string[]; fun_moments: string[];
}, completionRate: string, dateStr: string): unknown {
  const section = (title: string, items: string[]) =>
    items.length ? `**${title}**\n${items.map((i) => `· ${i}`).join('\n')}` : `**${title}**\n· 无`;
  return {
    config: { wide_screen_mode: true },
    header: { template: 'wathet', title: { tag: 'plain_text', content: `📰 今日群导读 · ${dateStr}` } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: section('🔑 关键决策', digest.key_decisions) } },
      { tag: 'div', text: { tag: 'lark_md', content: section('🤝 新增承诺', digest.new_commitments) } },
      { tag: 'div', text: { tag: 'lark_md', content: section('🤖 分身今日完成', digest.avatar_done ?? []) } },
      { tag: 'div', text: { tag: 'lark_md', content: section('⏳ 被 @ 未回应', digest.unanswered_mentions) } },
      { tag: 'div', text: { tag: 'lark_md', content: section('📅 明日到期', digest.due_tomorrow) } },
      { tag: 'div', text: { tag: 'lark_md', content: section('✨ 有趣瞬间', digest.fun_moments) } },
      { tag: 'hr' },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `承诺完成率：${completionRate} · Everyone 自动生成` }] },
    ],
  };
}

/** 入群快速指引私信卡（新功能 1）：项目背景 + 进展 + 关键信息 + 成员分工 */
export function onboardCard(memberName: string, brief: {
  project_summary: string; current_state: string[]; key_info: string[]; who_is_who: string[]; tips: string[];
}): unknown {
  const section = (title: string, items: string[]) =>
    items.length ? { tag: 'div', text: { tag: 'lark_md', content: `**${title}**\n${items.map((i) => `· ${i}`).join('\n')}` } } : null;
  return {
    config: { wide_screen_mode: true },
    header: { template: 'turquoise', title: { tag: 'plain_text', content: `👋 ${memberName}，欢迎加入！项目快速指引` } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: brief.project_summary } },
      section('📍 项目进展', brief.current_state),
      section('🔑 你需要知道', brief.key_info),
      section('👥 谁在做什么', brief.who_is_who),
      section('💡 上手建议', brief.tips),
      { tag: 'hr' },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '以上由 Everyone 根据群聊记录与任务台账自动整理 · 有问题在群里 @Everyone 问我' }] },
    ].filter(Boolean),
  };
}

/** 个人日报私信卡（新功能 2：日报分层——群发总报，私信发个人报） */
export function personalDigestCard(name: string, dateStr: string, data: {
  avatarWork: string[]; answered: string[]; collected: string[]; newTasks: string[]; dueSoon: string[]; overdue: string[];
}): unknown {
  const section = (title: string, items: string[]) =>
    items.length ? { tag: 'div', text: { tag: 'lark_md', content: `**${title}**\n${items.map((i) => `· ${i}`).join('\n')}` } } : null;
  return {
    config: { wide_screen_mode: true },
    header: { template: 'indigo', title: { tag: 'plain_text', content: `📮 ${name} 的今日分身战报 · ${dateStr}` } },
    elements: [
      section('🤖 分身替你做了', data.avatarWork),
      section('💬 分身替你答了', data.answered),
      section('📥 分身替你收了', data.collected),
      section('📌 今天新排给你的', data.newTasks),
      section('⏰ 快到期（48h 内）', data.dueSoon),
      section('🔴 已逾期', data.overdue),
      { tag: 'hr' },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '只发给你自己 · 群里的总日报照常 · 回复「四象限」可看任务全景' }] },
    ].filter(Boolean),
  };
}

/** 进度确认私信卡（新功能 3：到期前/逾期主动询问 owner） */
export function progressNudgeCard(task: Task, overdue: boolean, creatorName: string | null): unknown {
  const dueText = fmtDue(task.dueAt);
  return {
    config: { wide_screen_mode: true },
    header: {
      template: overdue ? 'red' : 'yellow',
      title: { tag: 'plain_text', content: overdue ? '🔴 这个任务已经过期了，现在什么情况？' : '⏰ 任务快到期了，进度怎么样？' },
    },
    elements: [
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**任务**\n${task.title}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**截止**\n${dueText}` } },
        ],
      },
      ...(creatorName ? [{ tag: 'div', text: { tag: 'lark_md', content: `你确认后我会把情况转告发起人 **${creatorName}**。` } }] : []),
      {
        tag: 'action',
        actions: [
          btn('✅ 已完成', 'nudge_done', { task_id: task.id }, 'primary'),
          btn('🟢 顺利推进中', 'nudge_ok', { task_id: task.id }),
          btn('🟠 有风险 / 要延期', 'nudge_risk', { task_id: task.id }, 'danger'),
        ],
      },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '按钮没反应？直接回复：已完成 / 顺利 / 有风险' }] },
    ],
  };
}

/** 进度确认后的静态卡 */
export function progressNudgeDoneCard(task: Task, verdict: string, extra?: string): unknown {
  const color = verdict.includes('完成') ? 'green' : verdict.includes('风险') ? 'orange' : 'blue';
  return {
    config: { wide_screen_mode: true },
    header: { template: color, title: { tag: 'plain_text', content: `⏰ ${task.title} · ${verdict}` } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `截止 ${fmtDue(task.dueAt)}${extra ? `\n${extra}` : ''}` } },
    ],
  };
}

/** 执行失败私信卡（FR-C7） */
export function runFailedCard(task: Task, reason: string): unknown {
  return {
    config: { wide_screen_mode: true },
    header: { template: 'red', title: { tag: 'plain_text', content: '⚠️ 分身执行遇到问题' } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**${task.title}**\n${reason.slice(0, 200)}` } },
      { tag: 'action', actions: [btn('🔄 重试', 'run_retry', { task_id: task.id }, 'primary')] },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '按钮没反应？直接回复：重试' }] },
    ],
  };
}

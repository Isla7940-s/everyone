import fs from 'node:fs';
import path from 'node:path';
import type { Task } from '@everyone/shared';
import { recentSummariesBlock } from '../collab/service.js';
import * as memory from '../memory/index.js';
import { prompt } from '../prompts.js';
import { chatLog, persons } from '../store/repo.js';
import { fmtStamp, timeVars } from '../time.js';
import { briefPath, draftPath, taskDir } from './workspace.js';

/** 组装 task-brief.md（FR-C3 五段固定结构），写入工作区，返回绝对路径 */
export async function buildTaskBrief(task: Task, feedbacks: string[]): Promise<string> {
  const owner = persons.byId(task.ownerId)!;

  // 2. 源消息与群上下文摘录（带时间，需求 1）
  const recent = task.chatId ? chatLog.recent(task.chatId, 20) : [];
  const context = [
    task.srcMsgLink ? `源消息：${task.srcMsgLink}` : '',
    '',
    '最近群聊摘录（带时间）：',
    ...recent.map((m) => `- [${fmtStamp(m.ts)}] ${m.senderName ?? '成员'}：${m.text.slice(0, 120)}`),
  ].filter(Boolean).join('\n');

  // 3. 记忆要点：memory.md 全文（≤2k tokens 近似 6000 字符）+ recall Top-K 带出处（FR-F5）
  let mem = memory.readPersonMemory(task.ownerId);
  if (mem.length > 6000) mem = mem.slice(0, 3000) + '\n…（中略）…\n' + mem.slice(-3000);
  const hits = await memory.recall(task.ownerId, task.title, 5);
  const recallText = hits.length ? hits.map(memory.recallLine).join('\n') : '（无相关召回）';

  // 4. 可用 skills：按与任务的相关度选注入，技能库变大也不会把任务书撑爆
  const skillsText = pickSkills(memory.readPersonSkills(task.ownerId).filter((s) => s.enabled), task.title);

  // 5. 产出要求按任务类型定制（发起人验收点：非报告类任务也要能接、能完成、能报告）
  //    交付出口 = feishu MCP（新需求 2b：不再由系统读 draft.md 转档，Agent 自己调工具交付）
  //    路径给绝对路径：OpenCode 的文件工具按项目根（repo 根）解析相对路径，与沙箱 cwd 不一致，相对路径会读写到错误位置
  const outputRel = draftPath(task.ownerId, task.id);
  const notesRel = path.join(taskDir(task.ownerId, task.id), 'notes');
  const deliverCommon = [
    `- **怎么交付（必做）**：把成稿写入 \`${outputRel}\`（第一行 \`# 标题\`），然后调用 MCP 工具 \`feishu_reply\`：text 传两三句话的成果摘要，attachment_path 传 \`${outputRel}\`——系统会自动转成飞书云文档私信给本人审阅。**不调用 feishu_reply = 本人收不到任何东西**`,
    '- 只调用一次 feishu_reply（最终交付那次）；过程草稿不要发',
    '- 需要群里的背景知识（口径/决策/分工/FAQ）时，先调 `feishu_get_wiki` 把群知识库拉进工作区参考；查开源库/框架文档用 context7 MCP 工具',
  ];
  const outputRequirements = task.taskKind === 'code'
    ? [
        '- 这是一个**代码修改任务**：在 `repo/` 目录内完成代码改动（可创建/修改文件，遵循仓库现有风格与语言）',
        '- 改动要最小且正确：只改与任务相关的代码，不做无关重构',
        '- 如果仓库里有可运行的测试或脚本（如 test.js、package.json scripts），改完必须运行验证，把结果如实写进报告',
        `- 把**变更报告**写入 \`${outputRel}\`：第一行 \`# 标题\`，正文三节——改了什么（文件+要点）、为什么这么改（根因分析）、怎么验证的（命令与输出摘要）；报告用中文，直接可交付（本人确认后会原样发进群）`,
        ...deliverCommon,
      ].join('\n')
    : task.taskKind === 'data'
      ? [
          '- 这是一个**数据整理/计算任务**：基于任务书里给到的数据与记忆要点完成整理、计算或对比',
          `- 计算过程要可复核：关键数字标注来源与口径，推导步骤写清楚；中间脚本/草表放 \`${notesRel}/\``,
          `- 结果适合表格呈现就写 markdown（\`${outputRel}\`，第一行 \`# 标题\`）；数据量大、适合交互浏览时可改交**单文件 HTML 看板**（CSS/JS 内联，写到 \`${path.join(taskDir(task.ownerId, task.id), 'dashboard.html')}\`，attachment_path 传它——系统会自动部署成 24h 网页，以链接卡片私信本人；写 HTML 前先读工作区根的 \`html-style.md\`，页面风格必须与 Everyone 产品一致）`,
          ...deliverCommon,
        ].join('\n')
      : [
          '- 用中文写作，markdown 格式',
          '- 直接可交付的完整成稿（不是大纲），结构清晰、有数据支撑处标注假设',
          '- 遵守「记忆要点」里本人的写作偏好与历史修改意见',
          `- 把最终成稿写入 \`${outputRel}\`（第一行 \`# 标题\`）；草稿大纲可先放 \`${notesRel}/\` 打磨`,
          ...deliverCommon,
        ].join('\n');

  const feedbackSection = feedbacks.length
    ? `## 6. 本人历轮修改意见（必须全部落实，按最新优先）\n\n${feedbacks.map((f, i) => `${i + 1}. ${f}`).join('\n')}`
    : '';

  const briefContent = prompt('task_brief', {
    ...timeVars(),
    title: task.title,
    owner_name: owner.name,
    due: task.dueAt ?? '未设定',
    source: task.source,
    context,
    memory: mem || '（暂无画像）',
    recall: recallText,
    // 跨端协同 §八：任务分身启动时同样自动获得最近 5 条工作总结
    work_summaries: recentSummariesBlock(5),
    skills: skillsText,
    output_requirements: outputRequirements,
    feedback_section: feedbackSection,
  });

  const dest = briefPath(task.ownerId, task.id);
  fs.writeFileSync(dest, briefContent);
  return dest;
}

interface SkillFile { name: string; content: string }

/**
 * 技能多到一定程度就只注入相关的几份全文，其余列目录。
 * 一份 skill 约 1500 字，四份以上就会盖过任务书里真正重要的任务描述与记忆要点；
 * 而且给「写竞品分析」的任务塞一份「版本发布说明」模板，纯属干扰。
 */
const SKILLS_FULL_TOP = 3;
/** 技能库很小时（总字数低于此）不做取舍，全给 */
const SKILLS_ALL_BELOW = 3500;

/** 中文没有空格，用 2-gram 交集做粗相关度。只用于排序，排错了也只是少注入一份模板 */
function bigrams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, '');
  const out = new Set<string>();
  for (let i = 0; i + 2 <= t.length; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

/** 标题行「# Skill: xxx」与下面那行引用，是这份 skill 最浓缩的自我介绍 */
function headline(s: SkillFile): { title: string; summary: string } {
  return {
    title: /^#\s*Skill:\s*(.+)$/m.exec(s.content)?.[1]?.trim() ?? s.name,
    summary: /^>\s*(.+)$/m.exec(s.content)?.[1]?.trim() ?? '',
  };
}

function pickSkills(skills: SkillFile[], taskTitle: string): string {
  if (!skills.length) return '（无预置 skill，按通用最佳实践写作）';
  const full = (s: SkillFile) => `### ${s.name}\n\n${s.content}`;
  const total = skills.reduce((n, s) => n + s.content.length, 0);
  if (skills.length <= SKILLS_FULL_TOP || total <= SKILLS_ALL_BELOW) return skills.map(full).join('\n\n');

  const q = bigrams(taskTitle);
  const scored = skills
    .map((s, i) => {
      const h = headline(s);
      const g = bigrams(`${s.name} ${h.title} ${h.summary}`);
      let hit = 0;
      for (const b of q) if (g.has(b)) hit += 1;
      return { s, h, hit, i };
    })
    .sort((a, b) => b.hit - a.hit || a.i - b.i);

  const parts = scored.slice(0, SKILLS_FULL_TOP).map((x) => full(x.s));
  const rest = scored.slice(SKILLS_FULL_TOP);
  if (rest.length) {
    parts.push([
      '### 其余可用 skill（跟本次任务关系不大，需要时自己读 `skills/<名>.md` 全文）',
      '',
      ...rest.map((x) => `- \`${x.s.name}\`（${x.h.title}）：${x.h.summary}`),
    ].join('\n'));
  }
  return parts.join('\n\n');
}

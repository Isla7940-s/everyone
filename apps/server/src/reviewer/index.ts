import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, Task } from '@everyone/shared';
import { bus } from '../bus.js';
import { config } from '../config.js';
import { adapter } from '../context.js';
import { fetchDoc } from '../lark/docs.js';
import { chatJson } from '../llm/client.js';
import { prompt } from '../prompts.js';
import { persons, reviewComments, runs } from '../store/repo.js';

/** 管理员开关（FR-D5，默认开） */
export let reviewEnabled = true;
export function setReviewEnabled(on: boolean) {
  reviewEnabled = on;
  bus.activity('review', `评审团${on ? '已开启' : '已关闭'}`);
}

const PERSONAS = ['laok', 'xiaolu', 'jinshu'] as const;
const PERSONA_NAMES: Record<string, string> = { laok: '老 K', xiaolu: '小鹿', jinshu: '谨叔' };

function readPersona(id: string): { persona: string; memory: string } {
  const dir = path.join(config.personasDir, id);
  const read = (f: string) => {
    try { return fs.readFileSync(path.join(dir, f), 'utf-8'); } catch { return ''; }
  };
  return { persona: read('persona.md'), memory: read('memory.md') };
}

/** S3 发布后触发（task:published 事件） */
export async function reviewPublishedTask(task: Task, groupMsgId: string, draft: string): Promise<void> {
  if (!reviewEnabled) return;
  const owner = persons.byId(task.ownerId);
  await runReview({
    title: task.title,
    content: draft,
    ownerName: owner?.name ?? task.ownerId,
    replyToMsgId: groupMsgId,
    taskId: task.id,
    runId: runs.latestOfTask(task.id)?.id ?? null,
  });
}

/** 群内 @Everyone + 文档链接求评审（FR-D2） */
export async function maybeReviewDocLink(msg: IncomingMessage, senderName: string): Promise<void> {
  if (!reviewEnabled) return;
  const m = msg.text.match(/https?:\/\/\S+/);
  if (!m) return;
  let content = '';
  try {
    content = await fetchDoc(m[0]);
  } catch {
    await adapter().replyText(msg.msgId, '这篇文档我没有权限读取。请把机器人加为文档协作者，或直接把全文粘贴进群。', `noperm-${msg.msgId}`);
    return;
  }
  if (!content.trim()) {
    await adapter().replyText(msg.msgId, '文档内容为空或无法解析，请直接粘贴全文。', `empty-${msg.msgId}`);
    return;
  }
  await runReview({
    title: content.split('\n')[0]?.replace(/^#\s*/, '').slice(0, 40) || '外部文档',
    content,
    ownerName: senderName,
    replyToMsgId: msg.msgId,
    taskId: null,
    runId: null,
  });
}

/** 评审主流程（S4）：结构化分析 + 三人设回复式评论 */
async function runReview(args: {
  title: string; content: string; ownerName: string;
  replyToMsgId: string; taskId: string | null; runId: string | null;
}): Promise<void> {
  bus.activity('review', `评审团开始审「${args.title}」`);

  // 1) 结构化四维分析（FR-D3）
  try {
    const a = await chatJson<Record<string, { score: number; reason: string }>>(
      '你是报告质量分析器，只输出 JSON。',
      prompt('review_analysis', { title: args.title, content: args.content.slice(0, 12_000) }),
      { temperature: 0 },
    );
    const dims: Array<[string, string]> = [
      ['data_reliability', '数据可靠'], ['logic', '逻辑完整'], ['readability', '可读性'], ['risk', '风险控制'],
    ];
    const stars = (n: number) => '★'.repeat(Math.max(1, Math.min(5, Math.round(n)))) + '☆'.repeat(5 - Math.max(1, Math.min(5, Math.round(n))));
    const lines = dims.map(([k, label]) => {
      const d = a[k];
      return d ? `${label} ${stars(d.score)} ${d.reason}` : null;
    }).filter(Boolean);
    await adapter().replyText(args.replyToMsgId, `🔍 Everyone 质量分析\n${lines.join('\n')}`, `analysis-${args.replyToMsgId}`);
  } catch (e) {
    bus.activity('system', '结构化分析失败（继续人设评论）', String(e).slice(0, 150));
  }

  // 2) 三人设依次评论（FR-D4：引用原文 + 署名，回复式）
  for (const pid of PERSONAS) {
    try {
      const { persona, memory } = readPersona(pid);
      const res = await chatJson<{ comments: Array<{ quoted_text: string; comment: string }> }>(
        '你是评审人设扮演器，只输出 JSON。',
        prompt('review_persona', {
          persona_name: PERSONA_NAMES[pid],
          persona, persona_memory: memory,
          owner_name: args.ownerName,
          content: args.content.slice(0, 12_000),
          max_comments: '3',
        }),
        { temperature: 0.5 },
      );
      const comments = (res.comments ?? []).slice(0, 3);
      for (const c of comments) {
        const text = `> ${c.quoted_text}\n\n${c.comment}\n—— ${PERSONA_NAMES[pid]}`;
        await adapter().replyText(args.replyToMsgId, text, `rc-${pid}-${args.replyToMsgId}-${comments.indexOf(c)}`);
        reviewComments.add({
          runId: args.runId, taskId: args.taskId,
          persona: PERSONA_NAMES[pid], quotedText: c.quoted_text, content: c.comment,
        });
      }
      bus.activity('review', `${PERSONA_NAMES[pid]} 发表了 ${comments.length} 条评论`);
    } catch (e) {
      bus.activity('system', `人设 ${PERSONA_NAMES[pid]} 评论失败`, String(e).slice(0, 150));
    }
  }
  bus.changed('run');
}

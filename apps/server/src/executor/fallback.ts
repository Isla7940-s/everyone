import fs from 'node:fs';
import { bus } from '../bus.js';
import { chat } from '../llm/client.js';

/** 内置 executor（FR-I2 降级）：直接按 task-brief 调 OpenAI 兼容 API 生成成稿 */
export async function runBuiltin(briefPath: string, outputPath: string): Promise<void> {
  bus.activity('run', '内置 executor 开工（OpenCode 降级路径）');
  const brief = fs.readFileSync(briefPath, 'utf-8');
  const content = await chat(
    [
      '你是一位严谨的职场写作分身。根据 task-brief 完成任务，直接输出最终成稿的 markdown 全文（第一行是 # 标题），不要输出任何解释或前后缀。',
      'task-brief 里的「记忆要点」（本人写作偏好、历史修改意见）与「可用 skills」是硬性规范，必须逐条对照落实；数据要带来源与口径，没有的写明假设。',
    ].join('\n'),
    brief,
    { temperature: 0.4, maxTokens: 8192 },
  );
  const cleaned = content.trim().replace(/^```(?:markdown)?\s*/i, '').replace(/\s*```$/, '');
  fs.writeFileSync(outputPath, cleaned);
}

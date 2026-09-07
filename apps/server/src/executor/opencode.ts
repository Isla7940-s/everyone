import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { bus } from '../bus.js';
import { config } from '../config.js';
import { taskRel } from './workspace.js';

/** 轨迹文件目录（需求 3：每次运行的 OpenCode 原始轨迹，随 DATA_DIR 隔离） */
export function tracesDir(): string {
  const dir = path.join(config.dataDir, 'traces');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function tracePath(runId: string): string {
  return path.join(tracesDir(), `${runId}.log`);
}

export interface SpawnResult {
  /** 模型最后一条消息的正文（未走 MCP 交付时可抢救给用户） */
  finalText: string;
  /** stdout/stderr 尾部（诊断用） */
  tail: string;
}

/**
 * OpenCode headless 通用启动器：
 * - cwd = 沙箱目录；env 里的 PWD 必须同步指向沙箱——OpenCode 解析工作目录优先信 $PWD，
 *   否则会话 directory 会落在 server 进程的 cwd（实测教训：bash 相对路径全跑偏）
 * - `--format json`：stdout 是 NDJSON 事件流（step/text/tool），全量落轨迹文件（需求 3）
 * - `--auto` + opencode.json permission 全放行：headless 没有人能点确认，任何 ask 都等于卡死（需求 4 卡点一）
 * - extraEnv 注入 MCP 会话（EVERYONE_MCP_URL / EVERYONE_AGENT_TOKEN）
 */
export async function spawnOpenCode(opts: {
  cwd: string;
  prompt: string;
  timeoutSec?: number;
  extraEnv?: Record<string, string>;
  /** 轨迹文件名（约定 = agent_runs.id）；不传则不落轨迹 */
  traceId?: string;
}): Promise<SpawnResult> {
  const args = ['run', opts.prompt, '--model', `gateway/${config.openai.model}`, '--format', 'json', '--auto'];
  const child = spawn(config.opencode.bin, args, {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PWD: opts.cwd,
      OPENAI_BASE_URL: config.openai.baseURL,
      OPENAI_API_KEY: config.openai.apiKey,
      ...opts.extraEnv,
    },
  });

  const trace = opts.traceId ? fs.createWriteStream(tracePath(opts.traceId), { flags: 'a' }) : null;
  trace?.write(`# trace ${opts.traceId} · started ${new Date().toISOString()}\n# cwd ${opts.cwd}\n# prompt\n${opts.prompt.split('\n').map((l) => `#   ${l}`).join('\n')}\n`);

  let tail = '';
  const keep = (d: Buffer) => {
    tail = (tail + d.toString()).slice(-4000);
  };

  // NDJSON 事件流解析：抢救「最后一条消息的 text」（需求 4 卡点二：模型把答案当聊天输出、没走 MCP）
  let stdoutBuf = '';
  const textParts: Array<{ messageId: string; text: string }> = [];
  const feedLine = (line: string) => {
    const s = line.trim();
    if (!s) return;
    try {
      const ev = JSON.parse(s);
      if (ev?.type === 'text' && typeof ev.part?.text === 'string') {
        textParts.push({ messageId: String(ev.part.messageID ?? ''), text: ev.part.text });
      }
    } catch {
      // 非 JSON 行（假引擎/降级输出）也计入抢救素材
      if (s.length > 1 && !s.startsWith('#')) textParts.push({ messageId: 'raw', text: s });
    }
  };
  child.stdout.on('data', (d: Buffer) => {
    keep(d);
    trace?.write(d);
    stdoutBuf += d.toString();
    let idx: number;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      feedLine(stdoutBuf.slice(0, idx));
      stdoutBuf = stdoutBuf.slice(idx + 1);
    }
  });
  child.stderr.on('data', (d: Buffer) => {
    keep(d);
    trace?.write(`[stderr] ${d.toString()}`);
  });

  const timeoutSec = opts.timeoutSec ?? config.opencode.timeoutSec;
  let exitCode = -1;
  let timedOut = false;
  try {
    // 超时不立刻抛：先 SIGTERM，等进程收尾（≤5s 强杀），把 stdout 缓冲里最后的文本吃完再判——
    // 抢救逻辑（需求 4）依赖这段"临终输出"
    exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000);
      }, timeoutSec * 1000);
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => { clearTimeout(timer); resolve(code ?? -1); });
    });
  } finally {
    if (stdoutBuf) feedLine(stdoutBuf);
    trace?.write(`\n# finished ${new Date().toISOString()} · ${timedOut ? 'timeout' : `exit=${exitCode}`}\n`);
    trace?.end();
  }

  const finalText = extractFinalText(textParts);
  if (timedOut) {
    const err = new Error(`OpenCode 超时（${timeoutSec}s）`) as Error & { finalText?: string };
    err.finalText = finalText; // 中断前最后的输出（进展/半成品结论）交给抢救
    throw err;
  }
  if (exitCode !== 0) {
    const err = new Error(`OpenCode 退出码 ${exitCode}：${tail.slice(-500)}`) as Error & { finalText?: string };
    err.finalText = finalText; // 非零退出也可能已有可抢救文本
    throw err;
  }
  return { finalText, tail };
}

/** 最后一条 assistant 消息的全部 text 段拼起来（跨 step 的同 messageID 合并） */
function extractFinalText(parts: Array<{ messageId: string; text: string }>): string {
  if (!parts.length) return '';
  const lastId = parts[parts.length - 1].messageId;
  return parts.filter((p) => p.messageId === lastId).map((p) => p.text).join('\n').trim();
}

/**
 * 任务（帮我干）执行入口（D2/FR-C3）。
 */
export async function runOpenCode(
  workspaceDir: string, taskId: string, taskKind?: string | null,
  extraEnv?: Record<string, string>, traceId?: string,
): Promise<SpawnResult> {
  // 绝对路径：OpenCode 文件工具按项目根解析相对路径（不是沙箱 cwd），相对路径会找不到文件
  const brief = path.join(workspaceDir, taskRel(taskId, 'brief.md'));
  const draft = path.join(workspaceDir, taskRel(taskId, 'draft.md'));
  const notes = path.join(workspaceDir, taskRel(taskId, 'notes'));
  // 提示词要把路径给死。让它自己去 ls 找文件会白烧好几轮工具调用，也更容易触到步数上限
  const deliverLine = `产出写好后必须调用 MCP 工具 feishu_reply 交付（text=两三句成果摘要，attachment_path=${draft}）——不调用它，本人什么都收不到。只在最终交付时调用一次。`;
  const promptText = taskKind === 'code'
    ? [
        `直接读文件 ${brief}（不用先浏览目录），严格按其要求完成任务。`,
        `这是一个代码修改任务：在 repo/ 目录内完成代码改动，若仓库带测试或可运行脚本必须运行验证。`,
        `完成后把变更报告写入 ${draft}（改了什么 / 为什么 / 怎么验证的）。`,
        deliverLine,
        `不要修改 memory.md、skills/ 与 ${brief}，也不要动别的任务目录。`,
      ].join('\n')
    : taskKind === 'data'
      ? [
          `直接读文件 ${brief}（不用先浏览目录），严格按其要求完成任务。`,
          `这是一个数据整理/计算任务：中间计算、脚本、草表可以放在 ${notes}/ 里（允许写脚本并运行来算数）。`,
          `关键数字必须可复核：来源、口径、推导步骤写清楚；能用表格就用表格（适合交互浏览时可按任务书交单文件 HTML 看板）。`,
          `把结果写入 ${draft}（第一行是 # 标题）。`,
          deliverLine,
          `不要修改 memory.md、skills/ 与 ${brief}，也不要动别的任务目录。`,
        ].join('\n')
      : [
          `直接读文件 ${brief}（不用先浏览目录），严格按其要求完成任务。`,
          `任务书里的「记忆要点」（本人写作偏好、历史修改意见）和「可用 skills」是硬性规范，必须逐条对照遵守。`,
          `把最终成稿写入 ${draft}；草稿或大纲可以先放 ${notes}/ 里打磨。`,
          `交稿前自查一遍：结构是否符合 skills 约定、数据是否都带口径、是否落实了全部历史修改意见。`,
          deliverLine,
          `不要修改 memory.md、skills/ 与 ${brief}，也不要动别的任务目录。`,
        ].join('\n');

  bus.activity('run', `OpenCode 分身开工`, `cwd=${path.basename(workspaceDir)} model=${config.openai.model}`);
  return spawnOpenCode({ cwd: workspaceDir, prompt: promptText, extraEnv, traceId });
}

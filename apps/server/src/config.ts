import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 项目根（monorepo root）：lark-cli 子进程 cwd 固定在这里，渲染产物相对路径由此起算 */
export const ROOT = path.resolve(__dirname, '../../..');

dotenv.config({ path: path.join(ROOT, '.env') });

function env(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`缺少环境变量 ${key}（见 .env.example）`);
}

// 沙箱跟着 DATA_DIR 一起隔离：否则 smoke/stress 的任务目录会混进真实工作区，
// 用户在沙箱里会看到一堆查不到出处的任务文件夹
const WORKSPACES_DIR = process.env.WORKSPACES_DIR
  ? path.resolve(ROOT, process.env.WORKSPACES_DIR)
  : process.env.DATA_DIR
    ? path.resolve(ROOT, `${process.env.DATA_DIR}-workspaces`)
    : path.join(ROOT, 'workspaces');

export const config = {
  root: ROOT,
  openai: {
    baseURL: env('OPENAI_BASE_URL'),
    apiKey: env('OPENAI_API_KEY'),
    model: env('MODEL', 'kimi-k3'),
    modelFast: env('MODEL_FAST', env('MODEL', 'kimi-k3')),
  },
  lark: {
    bin: env('LARK_CLI_BIN', 'lark-cli'),
    demoChatId: process.env.DEMO_CHAT_ID || '',
  },
  chatAdapter: (env('CHAT_ADAPTER', 'mock') === 'lark' ? 'lark' : 'mock') as 'lark' | 'mock',
  demoMode: env('DEMO_MODE', '0') === '1',
  digestTime: env('DAILY_DIGEST_TIME', '18:30'),
  /** 群知识库每日兜底更新时间（需求⑥）：有日报跟随日报，没日报到点自更；默认晚于日报时间 */
  wikiTime: env('WIKI_UPDATE_TIME', '19:30'),
  adminPort: Number(env('ADMIN_PORT', '8901')),
  serverPort: Number(env('SERVER_PORT', '8902')),
  memoryGatewayPort: Number(env('MEMORY_GATEWAY_PORT', '8420')),
  opencode: {
    bin: env('OPENCODE_BIN', 'opencode'),
    timeoutSec: Number(env('OPENCODE_TIMEOUT_SEC', '600')),
  },
  /** Agent 对话模式（聊天场景 OpenCode+MCP）的执行上限，比任务模式短——用户在会话里等。
   * 真实网络调研（多次 webfetch）420s 不够用（AI+∞ case 实测），默认放宽到 600s；超时仍有抢救代发兜底 */
  agentChatTimeoutSec: Number(env('AGENT_CHAT_TIMEOUT_SEC', '600')),
  // DATA_DIR 可覆盖（压测/多实例隔离用），默认 data/
  dataDir: process.env.DATA_DIR ? path.resolve(ROOT, process.env.DATA_DIR) : path.join(ROOT, 'data'),
  /** 部署页面/MCP 的对外基址：本机回环即可用；上公网只需改这一个环境变量 */
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${env('SERVER_PORT', '8902')}`).replace(/\/$/, ''),
  /** 跨端协同（§九）：request_remote_help / wait_help_result 单次阻塞等待的默认秒数 */
  collabHelpTimeoutSec: Number(env('COLLAB_HELP_TIMEOUT_SEC', '600')),
  outDir: path.join(ROOT, 'out'), // 渲染产物（cwd 相对：out/xxx.png）
  workspacesDir: WORKSPACES_DIR,
  /** 展示用的相对路径（写进私信、任务书、沙箱说明），跟实际目录保持一致 */
  workspacesRel: path.relative(ROOT, WORKSPACES_DIR),
  personasDir: path.join(ROOT, 'personas'),
  promptsDir: path.join(ROOT, 'prompts'),
  templatesDir: path.join(ROOT, 'templates'),
};

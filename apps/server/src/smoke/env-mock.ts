// 必须在任何业务模块之前 import：强制 mock 模式 + 隔离数据目录
// （教训：此前只切 CHAT_ADAPTER 没切 DATA_DIR，每跑一次 smoke 就往 live 库塞一条测试任务）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CHAT_ADAPTER = 'mock';
process.env.DATA_DIR = process.env.DATA_DIR || 'data-smoke';
// 冒烟自己的端口（live 实例占 8901/8902，压测占 8931）——MCP/部署页断言要真的起 HTTP
process.env.SERVER_PORT = process.env.SMOKE_SERVER_PORT || '8962';
process.env.ADMIN_PORT = process.env.SMOKE_ADMIN_PORT || '8961';

// 每次冒烟从干净库开始（断言依赖初始状态）
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
fs.rmSync(path.join(root, process.env.DATA_DIR), { recursive: true, force: true });

// 假 OpenCode 引擎：不连模型，但走真实 MCP HTTP 通道交付（覆盖新需求 1/2/3 链路）
process.env.OPENCODE_BIN = process.env.SMOKE_OPENCODE_BIN || path.join(root, 'scripts/fake-opencode.mjs');
process.env.AGENT_CHAT_TIMEOUT_SEC = '60';

export {};

// 跨端协同冒烟的环境预设：必须在任何业务模块之前 import
// mock 模式 + 独立数据目录 + 独立端口（8971/8972，避开 live/smoke/stress 实例）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CHAT_ADAPTER = 'mock';
process.env.DATA_DIR = process.env.DATA_DIR || 'data-collab-smoke';
process.env.SERVER_PORT = process.env.COLLAB_SMOKE_SERVER_PORT || '8972';
process.env.ADMIN_PORT = process.env.COLLAB_SMOKE_ADMIN_PORT || '8971';
// 不跑真模型；协同链路不经过 LLM，给假值防 config 报缺
process.env.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'http://127.0.0.1:1/v1';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-fake';
process.env.MODEL = process.env.MODEL || 'fake-model';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
fs.rmSync(path.join(root, process.env.DATA_DIR), { recursive: true, force: true });
fs.rmSync(path.join(root, `${process.env.DATA_DIR}-workspaces`), { recursive: true, force: true });

export {};

// 真实 Codex 求助验证的环境预设：必须最先 import（ESM import 提升，模块体赋值来不及）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CHAT_ADAPTER = 'mock';
process.env.DATA_DIR = process.env.DATA_DIR || 'data-codexhelp';
process.env.SERVER_PORT = '8973';
process.env.ADMIN_PORT = '8970';
process.env.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'http://127.0.0.1:1/v1';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-fake';
process.env.MODEL = process.env.MODEL || 'fake-model';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
fs.rmSync(path.join(root, process.env.DATA_DIR), { recursive: true, force: true });
fs.rmSync(path.join(root, `${process.env.DATA_DIR}-workspaces`), { recursive: true, force: true });

export {};

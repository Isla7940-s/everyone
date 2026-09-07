import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import * as larkDocs from '../lark/docs.js';

/**
 * 产出文档抽象：
 * - live：真飞书文档（创建 / overwrite 同一篇，FR-C4/C5）
 * - mock：本地文件 + 模拟群聊里的文档页（/simulator.html#/doc/<taskId>）
 * - live 下 docx 无权限时自动降级 mock 行为（FR-I2 由上层捕获）
 */
export interface DocRef {
  token: string;
  url: string;
}

const mockDocDir = () => path.join(config.dataDir, 'docs');

export async function createTaskDoc(taskId: string, title: string, markdown: string): Promise<DocRef> {
  if (config.chatAdapter === 'lark') {
    const doc = await larkDocs.createDoc(title, markdown);
    return { token: doc.doc_token, url: doc.url };
  }
  fs.mkdirSync(mockDocDir(), { recursive: true });
  fs.writeFileSync(path.join(mockDocDir(), `${taskId}.md`), markdown);
  // 卡片按钮在模拟群聊里点开，链接落在模拟器入口而不是产品前端
  return { token: `mockdoc-${taskId}`, url: `/simulator.html#/doc/${taskId}` };
}

export async function overwriteTaskDoc(taskId: string, docToken: string, markdown: string): Promise<void> {
  if (config.chatAdapter === 'lark' && !docToken.startsWith('mockdoc-')) {
    await larkDocs.overwriteDoc(docToken, markdown);
    return;
  }
  fs.mkdirSync(mockDocDir(), { recursive: true });
  fs.writeFileSync(path.join(mockDocDir(), `${taskId}.md`), markdown);
}

export function readMockDoc(taskId: string): string | null {
  try {
    return fs.readFileSync(path.join(mockDocDir(), `${taskId}.md`), 'utf-8');
  } catch {
    return null;
  }
}

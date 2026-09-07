import { larkExec } from './exec.js';

export interface CreatedDoc {
  doc_token: string;
  url: string;
}

/** 创建飞书文档（markdown 内容走 stdin，FR-C4） */
export async function createDoc(title: string, markdown: string): Promise<CreatedDoc> {
  const data = await larkExec<any>(
    ['docs', '+create', '--as', 'user', '--doc-format', 'markdown', '--title', title, '--content', '-'],
    { stdin: markdown, timeoutMs: 120_000 },
  );
  const token = data?.document?.document_id ?? data?.doc_token ?? data?.document_id ?? '';
  const url = data?.document?.url ?? data?.url ?? (token ? `https://feishu.cn/docx/${token}` : '');
  return { doc_token: token, url };
}

/** 覆盖更新同一篇文档（FR-C5 迭代不新建） */
export async function overwriteDoc(docToken: string, markdown: string): Promise<void> {
  await larkExec<any>(
    ['docs', '+update', '--as', 'user', '--doc', docToken, '--command', 'overwrite', '--doc-format', 'markdown', '--content', '-'],
    { stdin: markdown, timeoutMs: 120_000 },
  );
}

/** 读取文档为 markdown（FR-D2 评审用） */
export async function fetchDoc(urlOrToken: string): Promise<string> {
  const data = await larkExec<any>(
    ['docs', '+fetch', '--as', 'user', '--doc', urlOrToken, '--doc-format', 'markdown'],
    { timeoutMs: 120_000 },
  );
  return data?.content ?? data?.markdown ?? '';
}

/**
 * 需求④探针：记忆引擎在线时，recall 命中必须带原始时间（ts 或如实标注）。
 * 运行：DATA_DIR=data-uicheck SERVER_PORT=8977 ADMIN_PORT=8976 CHAT_ADAPTER=mock npx tsx src/tmp-probe/recall-ts-check.ts
 */
process.env.CHAT_ADAPTER = process.env.CHAT_ADAPTER || 'mock';
process.env.DATA_DIR = process.env.DATA_DIR || 'data-uicheck';
process.env.SERVER_PORT = process.env.SERVER_PORT || '8977';
process.env.ADMIN_PORT = process.env.ADMIN_PORT || '8976';

import * as engine from '../memory/engine.js';
import { recallLine, type RecallHit } from '../memory/index.js';

async function main() {
  const up = await engine.ping();
  console.log(`记忆引擎在线：${up}`);
  if (!up) process.exit(2);

  // 灌一条带时间的事件 → 立刻召回，验证 ts 解析与展示行
  await engine.capture({
    personId: 'laowang',
    chatId: 'probe-chat',
    content: '老王：压测结论确认过了，QPS 峰值 8200，瓶颈在网关连接池',
    sourceLink: 'https://example.feishu.cn/msg/demo',
    kind: 'chat',
  });
  await new Promise((r) => setTimeout(r, 1500));

  const hits: RecallHit[] = await engine.recall('laowang', '压测 QPS 峰值', 5);
  console.log(`\n召回 ${hits.length} 条：`);
  for (const h of hits) console.log(recallLine(h), `\n    → ts=${h.ts ?? '（无）'}`);

  const withTs = hits.filter((h) => h.ts).length;
  console.log(`\n带原始时间：${withTs}/${hits.length}`);
  process.exit(hits.length > 0 && withTs > 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

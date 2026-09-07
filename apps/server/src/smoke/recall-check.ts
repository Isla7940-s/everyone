/**
 * 记忆召回实测（发起人验收点：系统能不能从真实群聊中提取关键记忆）。
 * 直连 live 数据与记忆引擎，对今晚真实群聊内容做召回，打印命中与出处。
 * 运行：pnpm --filter @everyone/server exec tsx src/smoke/recall-check.ts
 */
import { initMemory, recall, memoryEngineUp } from '../memory/index.js';

const QUERIES: Array<{ personId: string; q: string; expect: string }> = [
  { personId: 'u_87b42c82', q: '卡片按钮点不了的问题', expect: '发起人今晚在群里的抱怨' },
  { personId: 'u_87b42c82', q: '前端开发的承诺', expect: '「我明天完成前端开发」' },
  { personId: 'u_87b42c82', q: '演示视频 截止', expect: '黑客松演示视频任务' },
  { personId: 'xiaoming', q: '星航 DAU 是多少', expect: '预置画像 12 万' },
];

async function main() {
  await initMemory();
  console.log(`记忆引擎状态：${memoryEngineUp() ? '在线（四层引擎）' : '降级（SQLite 检索）'}\n`);
  let hitCount = 0;
  for (const { personId, q, expect } of QUERIES) {
    const hits = await recall(personId, q, 3);
    console.log(`【${personId}】查询「${q}」（预期：${expect}）→ ${hits.length} 条命中`);
    for (const h of hits) {
      console.log(`   · ${h.content.slice(0, 90).replace(/\n/g, ' ')}`);
      console.log(`     出处：${h.source.slice(0, 90)}`);
    }
    if (hits.length) hitCount += 1;
    console.log();
  }
  console.log(`=== 召回结果：${hitCount}/${QUERIES.length} 个查询有命中 ===`);
  process.exit(hitCount >= 3 ? 0 : 1);
}

main();

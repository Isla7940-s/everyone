/**
 * 意图分类回归评测（保护 prompts/intent_classify.md 不被改坏）。
 * 23 条带标注语料覆盖七类（含 agent 动手活）+ 易混淆边界（图片描述/指令词/闲聊里的时间词）。
 * 通过线：≥ 85% 且承诺类不漏检。运行：pnpm eval:intent
 */
import { chatJson } from '../llm/client.js';
import { prompt } from '../prompts.js';
import { timeVars } from '../time.js';

const MEMBERS = 'xiaoming: 小明\nxiaohong: 小红\nlaowang: 老王';

const CASES: Array<{ sender: string; text: string; expect: string }> = [
  { sender: '小明', text: '周五前我把竞品分析报告发到群里', expect: 'commitment' },
  { sender: '小红', text: '我明天把新版设计稿走查完', expect: 'commitment' },
  { sender: '老王', text: '这周内我把接口压测数据整理出来发大家', expect: 'commitment' },
  { sender: '小明', text: '@小红 麻烦你周四前把登录页的视觉稿改一版', expect: 'mention_assign' },
  { sender: '老王', text: '@小明 新用户引导的实验方案交给你来写', expect: 'mention_assign' },
  { sender: '小红', text: '#会议 增长周会：1. 下周一灰度实验，老王负责；2. 小明周三前出数据方案；3. Q4 预算冻结', expect: 'meeting' },
  { sender: '小明', text: '登录后的空白页真的很影响体验，两周了还没修', expect: 'opinion' },
  { sender: '老王', text: '日报的排版有点乱，重点完全看不出来', expect: 'opinion' },
  { sender: '小红', text: '[图片] 一张 App 崩溃报错截图：NullPointerException，页面显示「加载失败请重试」', expect: 'opinion' },
  { sender: '小明', text: '上次说的活动预算口径是多少来着？', expect: 'question' },
  { sender: '小红', text: '新用户引导实验是哪天上线？谁记得', expect: 'question' },
  { sender: '老王', text: '设计规范里主色号是多少？', expect: 'question' },
  { sender: '小明', text: '哈哈哈哈笑死我了', expect: 'none' },
  { sender: '小红', text: '中午吃什么，有人拼奶茶吗', expect: 'none' },
  { sender: '老王', text: '收到，辛苦了', expect: 'none' },
  { sender: '小明', text: '@Everyone 四象限', expect: 'none' },
  { sender: '小红', text: '明天见，我先下了', expect: 'none' },
  { sender: '老王', text: '[图片] 一张周末爬山的风景照片，蓝天白云', expect: 'none' },
  { sender: '小明', text: '下周三的评审会别忘了', expect: 'none' },
  { sender: '小红', text: '这个表情包太好笑了', expect: 'none' },
  // agent（新需求 2a）：让助理本体动手做产出型工作——区别于指派人（mention_assign）和一句话能答的（question）
  { sender: '小明', text: '@Everyone 把这周的埋点数据整理成一个网页看板', expect: 'agent' },
  { sender: '老王', text: '@Everyone 帮我做一个能设置分钟数的倒计时小工具', expect: 'agent' },
  { sender: '小红', text: '@Everyone 调研下最近三个月 AI 助手产品的动态，整理成一篇报告发我', expect: 'agent' },
  // agent · 心跳任务（七项需求 7）：定时/例行服务由助理创建心跳任务
  { sender: '小明', text: '@Everyone 每天早上 9 点推送我昨天新接的需求和今天要完成的任务', expect: 'agent' },
  { sender: '老王', text: '@Everyone 每周五下午 5 点提醒我整理本周的接口压测周报', expect: 'agent' },
];

async function main() {
  let hit = 0;
  let missedCommitment = 0;
  const wrong: string[] = [];
  for (const c of CASES) {
    let got = 'ERR';
    try {
      const res = await chatJson<{ type: string; confidence: number }>(
        '你是意图分类器，只输出 JSON。',
        prompt('intent_classify', {
          ...timeVars(),
          members: MEMBERS,
          sender: c.sender,
          text: c.text,
        }),
        { fast: true, temperature: 0 },
      );
      got = res.type;
    } catch { /* got=ERR */ }
    const ok = got === c.expect;
    if (ok) hit += 1;
    else {
      wrong.push(`「${c.text.slice(0, 30)}」预期 ${c.expect} 实际 ${got}`);
      if (c.expect === 'commitment') missedCommitment += 1;
    }
    console.log(`${ok ? '✅' : '❌'} [${c.expect} → ${got}] ${c.text.slice(0, 40)}`);
  }
  const acc = hit / CASES.length;
  console.log(`\n=== 意图评测：${hit}/${CASES.length}（${(acc * 100).toFixed(0)}%）｜承诺漏检 ${missedCommitment} ===`);
  if (wrong.length) console.log('错误明细：\n' + wrong.join('\n'));
  process.exit(acc >= 0.85 && missedCommitment === 0 ? 0 : 1);
}

main();

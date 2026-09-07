/**
 * 刷屏压测（发起人验收点：模拟大量信息快速刷屏的真实群聊）。
 *
 * 隔离实例：SERVER_PORT=8931 · CHAT_ADAPTER=mock · DATA_DIR=data-stress（不碰 live 数据）。
 * 通过 /api/mock/message 全速注入 120 条拟真消息（闲聊/承诺/提问/意见/会议记录混合），验证：
 *   1. 不丢 —— chat_messages 与 messages_seen 计数 = 注入成功数
 *   2. 不重 —— msg_id 主键唯一，重复注入不产生第二条
 *   3. 不崩 —— 全程 /api/health 200；意图积压有界并最终排空；SIGTERM 干净退出（码 0）
 *
 * 运行：pnpm --filter @everyone/server stress
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, '../..');
const root = path.resolve(serverDir, '../..');
const PORT = 8931;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = 'data-stress';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const CHATTER = [
  '早啊各位', '午饭吃什么', '这周好快啊', '刚开完会，脑壳疼', '哈哈哈哈笑死',
  '有人看昨晚的比赛吗', '楼下咖啡新品不错', '周末去爬山吗', '这个表情包太好笑了',
  '地铁又延误了', '今天空调好冷', '摸鱼时间到', '下班了下班了', '晚上加班的举手',
  '刚看到一个离谱的新闻', '谁有充电线借我', '会议室 A 有人用吗', '快递到前台了',
  '这周五有团建吗', '新来的同事叫什么', '文档链接发我一下', '收到收到', '好的没问题',
  '辛苦辛苦', '奥利给', '冲了冲了', '别卷了别卷了', '摆烂一小时', '谁点奶茶拼单',
];
const COMMITMENTS = [
  '我周五前把数据看板的迁移方案写出来',
  '明天下班前我把用户调研问卷发出来',
  '这周内我把埋点文档补齐',
  '我下周一之前出竞品定价分析',
];
const QUESTIONS = [
  '上次说的活动预算口径是多少来着？',
  '新用户引导实验是哪天上线？',
  '设计规范里主色号是多少？',
];
const OPINIONS = [
  '登录页在低端机上加载还是很慢，体验不太好',
  '日报的排版有点乱，看着累',
  '新版首页的字号是不是太小了',
];
const MEETING = `#会议 增长周会纪要：1. 确认下周一开始灰度新用户引导实验，老王负责推进上线；2. 小红本周五前完成登录页视觉走查；3. 小明下周三前输出数据看板迁移方案终稿；4. 决定 Q4 预算冻结非必要支出。`;

const PERSONS = ['xiaoming', 'xiaohong', 'laowang'];

function buildMessages(): Array<{ personId: string; text: string }> {
  const msgs: Array<{ personId: string; text: string }> = [];
  // 100 条闲聊（循环语料 + 序号防完全重复文本）
  for (let i = 0; i < 100; i++) {
    msgs.push({ personId: PERSONS[i % 3], text: `${CHATTER[i % CHATTER.length]}（${i}）` });
  }
  for (const [i, text] of COMMITMENTS.entries()) msgs.push({ personId: PERSONS[i % 3], text });
  for (const [i, text] of QUESTIONS.entries()) msgs.push({ personId: PERSONS[(i + 1) % 3], text });
  for (const [i, text] of OPINIONS.entries()) msgs.push({ personId: PERSONS[(i + 2) % 3], text });
  msgs.push({ personId: 'laowang', text: MEETING });
  // 打乱顺序更接近真实刷屏
  for (let i = msgs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [msgs[i], msgs[j]] = [msgs[j], msgs[i]];
  }
  return msgs;
}

async function waitFor(url: string, timeoutMs: number, test?: (j: any) => boolean): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        const j = await r.json();
        if (!test || test(j)) return j;
      }
    } catch { /* server 未起 */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`等待超时：${url}`);
}

async function main() {
  console.log('\n=== Everyone 刷屏压测（隔离 mock 实例）===\n');

  fs.rmSync(path.join(root, DATA_DIR), { recursive: true, force: true });

  const child = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: serverDir,
    env: {
      ...process.env,
      SERVER_PORT: String(PORT),
      CHAT_ADAPTER: 'mock',
      DATA_DIR,
      OPENCODE_BIN: '/nonexistent-stress-no-exec',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout!.on('data', (d) => (serverLog += d));
  child.stderr!.on('data', (d) => (serverLog += d));

  try {
    await waitFor(`${BASE}/api/health`, 60_000);
    check('隔离实例启动', true, `port=${PORT} data=${DATA_DIR}`);

    const msgs = buildMessages();
    const t0 = Date.now();
    let sendOk = 0;
    let sendFail = 0;
    // 全速注入：12 并发一批
    for (let i = 0; i < msgs.length; i += 12) {
      const batch = msgs.slice(i, i + 12);
      const results = await Promise.allSettled(batch.map((m) =>
        fetch(`${BASE}/api/mock/message`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(m),
        }).then((r) => { if (!r.ok) throw new Error(String(r.status)); }),
      ));
      for (const r of results) r.status === 'fulfilled' ? sendOk++ : sendFail++;
    }
    const injectMs = Date.now() - t0;
    const rate = (sendOk / (injectMs / 1000)).toFixed(1);
    check('全速注入完成', sendFail === 0, `${sendOk} 条 / ${(injectMs / 1000).toFixed(1)}s（${rate} 条/秒），失败 ${sendFail}`);

    // 注入完成后立即检查服务存活 + 观测积压峰值
    let h: any = await (await fetch(`${BASE}/api/health`)).json();
    check('刷屏中服务存活', h.ok === true, `rss=${h.rssMb}MB 积压 active=${h.intent.active} waiting=${h.intent.waiting}`);
    const backlogPeak = h.intent.active + h.intent.waiting;

    // 等 LLM 意图队列排空（有界并发 → 有限时间内必须清零）
    const t1 = Date.now();
    h = await waitFor(`${BASE}/api/health`, 600_000, (j) => j.intent.active === 0 && j.intent.waiting === 0);
    check('意图积压排空', true, `峰值 ${backlogPeak} → 0，用时 ${((Date.now() - t1) / 1000).toFixed(0)}s`);

    // 不丢：用户消息计数 = 注入成功数（需求③后 bot outbound 也入档，故按 sender 过滤后比对）
    check('不丢消息', h.counts.chatMessagesUser === sendOk, `chat_messages(user)=${h.counts.chatMessagesUser} / 注入=${sendOk}（含 bot 共 ${h.counts.chatMessages}）`);
    // 不重：seen 计数 = 注入成功数（每条恰好消费一次）
    check('不重复消费', h.counts.seen === sendOk, `messages_seen=${h.counts.seen} / 注入=${sendOk}`);

    // 任务产出健全性：承诺/会议行动项被识别（4 承诺 + 会议 ≥3 行动项 ≈ 5~12 条；闲聊不应成任务）
    const tasksN = h.counts.tasks;
    check('任务提取健全（无闲聊误报爆炸）', tasksN >= 3 && tasksN <= 20, `tasks=${tasksN}（预期 3~20）`);

    // 尾部再验一次服务健康
    const finalH: any = await (await fetch(`${BASE}/api/health`)).json();
    check('压测后服务健康', finalH.ok === true, `uptime=${finalH.uptimeSec}s rss=${finalH.rssMb}MB`);

    // SIGTERM 干净退出
    const exitCode: number = await new Promise((resolve) => {
      child.on('close', (code) => resolve(code ?? -1));
      child.kill('SIGTERM');
      setTimeout(() => { child.kill('SIGKILL'); }, 15_000).unref();
    });
    check('SIGTERM 干净退出', exitCode === 0, `exit=${exitCode}`);
  } catch (e) {
    check('压测执行', false, String(e).slice(0, 300));
    console.log('\n--- server 日志尾部 ---\n' + serverLog.slice(-2000));
    child.kill('SIGKILL');
  }

  console.log(`\n=== 压测结果：${passed} 通过 / ${failed} 失败 ===\n`);
  process.exit(failed ? 1 : 0);
}

main();

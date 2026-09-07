/**
 * pnpm smoke（FR-H5）：不连飞书，跑通「模拟消息 → 识别 → 台账 → 四象限渲染 → task-brief 生成」全链路。
 * 需要 OPENAI_* 环境变量（意图识别与抽取要用 LLM）。
 */
import './env-mock.js';
import '../store/db.js';
import { onCardAction } from '../actions.js';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from '@everyone/shared';
import { bus } from '../bus.js';
import { config } from '../config.js';
import { setAdapter } from '../context.js';
import { generateAndSendPersonalDigests } from '../digest/index.js';
import { buildTaskBrief } from '../executor/brief.js';
import { ensureCalendar } from '../lark/calendar.js';
import { MockAdapter } from '../lark/mock.js';
import { sweepNudges } from '../ledger/nudge.js';
import { renderQuadrant } from '../render/quadrant.js';
import { onMessage } from '../ingest/pipeline.js';
import { initMemory } from '../memory/index.js';
import { handleMemberJoined } from '../presence/onboard.js';
import { seedPersons } from '../seed.js';
import { persons, tasks } from '../store/repo.js';

const results: Array<{ step: string; ok: boolean; detail: string }> = [];
function record(step: string, ok: boolean, detail = '') {
  results.push({ step, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${step}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  console.log('\n=== Everyone smoke（mock 模式全链路）===\n');

  await initMemory();
  await seedPersons();
  const mock = new MockAdapter();
  setAdapter(mock);
  mock.onMessage((m) => onMessage(m).catch((e) => console.error('pipeline error', e)));
  mock.onCardAction((a) => onCardAction(a).catch((e) => console.error('card error', e)));
  mock.onMemberJoined((e) => handleMemberJoined(e).catch((err) => console.error('join error', err)));
  await mock.start();
  await ensureCalendar();

  // 1) 模拟消息 → 意图识别 → 确认卡
  const msg = mock.injectUserMessage({
    personId: 'xiaoming', personName: '小明',
    text: '周五前我把竞品分析报告发到群里',
  });
  record('注入模拟承诺消息', true, msg.msgId);

  // 等确认卡出现（LLM 识别 + 抽取，两次串行调用；网关高峰单次可达 40s+，给 90s）
  const cardMsg = await waitFor(() => mock.history.find((m) => m.kind === 'card' && m.senderIsBot), 90_000);
  record('意图识别 → 群内确认卡', !!cardMsg, cardMsg ? '确认卡已发出' : '超时未出卡');
  if (!cardMsg) return finish(1);

  const pending = tasks.all({ ownerId: 'xiaoming', statuses: ['pending_confirm'] });
  record('任务入台账（待确认）', pending.length > 0, pending[0]?.title ?? '');
  if (!pending.length) return finish(1);
  const task = pending[0];

  // 2) 模拟点「确认」
  mock.injectCardClick({ msgId: cardMsg.msgId, operatorId: 'xiaoming', value: { action: 'task_confirm', task_id: task.id } });
  const confirmed = await waitFor(() => tasks.byId(task.id)?.status !== 'pending_confirm', 30_000);
  record('卡片确认 → 状态流转', !!confirmed, `status=${tasks.byId(task.id)?.status}`);

  // 3) 四象限渲染（确认后应自动回图；这里再显式渲染断言 PNG 生成）
  const png = renderQuadrant('小明', tasks.openTasksOf('xiaoming'), task.id);
  const pngAbs = path.join(config.root, png);
  record('四象限 SVG→PNG 渲染', fs.existsSync(pngAbs) && fs.statSync(pngAbs).size > 10_000, `${png}（${fs.existsSync(pngAbs) ? fs.statSync(pngAbs).size : 0} bytes）`);

  const quadrantSent = await waitFor(() => mock.history.some((m) => m.kind === 'image'), 20_000);
  record('确认后群里收到四象限图', !!quadrantSent);

  // 4) 任务书生成（不实际跑 OpenCode）：必须落在本任务自己的目录里
  const briefAbs = await buildTaskBrief(tasks.byId(task.id)!, ['第一版语气再正式一点']);
  const brief = fs.readFileSync(briefAbs, 'utf-8');
  const briefOk = ['任务描述', '群上下文', '记忆要点', '可用 skills', '产出要求'].every((k) => brief.includes(k));
  record('任务书五段结构生成', briefOk, briefAbs);
  record(
    '任务书按任务隔离（tasks/<id>/brief.md）',
    briefAbs.endsWith(path.join('tasks', task.id, 'brief.md')) && brief.includes(`tasks/${task.id}/draft.md`),
    path.relative(config.root, briefAbs),
  );

  // 5) 幂等：同一 msgId 再注入不重复建任务
  const before = tasks.all().length;
  await onMessage(msg); // 直接重放同一条
  record('消息幂等（重放不重复建任务）', tasks.all().length === before);

  // 6) 卡片永不静默：点一张任务已不存在的卡，必须收到失效提示（D30）
  const feedbackBase = mock.history.length;
  mock.injectCardClick({ msgId: cardMsg.msgId, operatorId: 'xiaoming', value: { action: 'task_confirm', task_id: 't-ghost-404' } });
  const staleFeedback = await waitFor(
    () => mock.history.slice(feedbackBase).find((m) => m.senderIsBot && (m.text ?? '').includes('已失效')),
    15_000,
  );
  record('卡片永不静默（失效卡点击有反馈）', !!staleFeedback);

  // 7) @机器人兜底对话：没命中任何任务也要回话（D34）
  const chatBase = mock.history.length;
  mock.injectUserMessage({ personId: 'laowang', personName: '老王', text: '@Everyone 在吗，随便聊聊，今晚过得如何' });
  const fallbackReply = await waitFor(
    () => mock.history.slice(chatBase).find((m) => m.senderIsBot && m.kind !== 'card' && (m.text ?? '').length > 4),
    60_000,
  );
  record('@机器人兜底对话（未命中任务也回话）', !!fallbackReply, (fallbackReply?.text ?? '').slice(0, 40));

  // ===== 新功能四连测（入群指引 / 日程同步 / 进度确认 / 个人日报）=====

  // 8) 日程同步（新功能 4）：确认一个未来截止的任务 → calendarEventId 落库 + 私信告知
  // due 放在 +6h：既是未来时刻（可建日程），又落在进度确认的 24h 窗口内（第 9 步复用）
  const due = new Date(Date.now() + 6 * 3600_000).toISOString();
  const calTask = tasks.create({
    ownerId: 'xiaoming', creatorId: 'laowang', title: '给老王准备季度数据底稿',
    source: 'mention', important: true, urgent: true, dueAt: due,
    status: 'pending_confirm', confidence: 0.95, chatId: mock.demoChatId,
  });
  const { confirmTask } = await import('../ledger/tasks.js');
  await confirmTask(calTask.id);
  const calSynced = await waitFor(() => !!tasks.byId(calTask.id)?.calendarEventId, 15_000);
  const calNotice = await waitFor(
    () => mock.history.find((m) => m.chatId === 'mock-p2p-xiaoming' && (m.text ?? '').includes('飞书日程')),
    10_000,
  );
  record('任务确认 → 同步飞书日程（含私信告知）', !!calSynced && !!calNotice, `event=${tasks.byId(calTask.id)?.calendarEventId}`);

  // 9) 主动进度确认（新功能 3）：到期前扫描 → owner 收卡 → 点「有风险」→ 发起人收到通报 → 补原因转达
  await sweepNudges();
  const nudgeCard = await waitFor(
    () => mock.history.find((m) =>
      m.chatId === 'mock-p2p-xiaoming' && m.kind === 'card'
      && cardTitle(m.card).includes('进度') && JSON.stringify(m.card).includes(calTask.id)),
    15_000,
  );
  record('到期前进度确认卡私信 owner', !!nudgeCard, cardTitle(nudgeCard?.card));
  if (nudgeCard) {
    mock.injectCardClick({ msgId: nudgeCard.msgId, operatorId: 'xiaoming', value: { action: 'nudge_risk', task_id: calTask.id } });
    const creatorNotified = await waitFor(
      () => mock.history.find((m) => m.chatId === 'mock-p2p-laowang' && (m.text ?? '').includes('有风险')),
      15_000,
    );
    record('owner 报「有风险」→ 发起人被通报', !!creatorNotified, (creatorNotified?.text ?? '').slice(0, 50));
    mock.injectUserMessage({ personId: 'xiaoming', personName: '小明', text: '数据源接口这两天在迁移，可能要延到下周一', chatKind: 'p2p' });
    const reasonRelayed = await waitFor(
      () => mock.history.find((m) => m.chatId === 'mock-p2p-laowang' && (m.text ?? '').includes('数据源接口')),
      15_000,
    );
    record('风险原因转达发起人', !!reasonRelayed, (reasonRelayed?.text ?? '').slice(0, 50));
  } else {
    record('owner 报「有风险」→ 发起人被通报', false, '进度卡未出现，跳过');
    record('风险原因转达发起人', false, '进度卡未出现，跳过');
  }

  // 10) 入群快速指引（新功能 1）：拉新人进群 → 私聊收到项目指引卡（LLM 失败自动降级模板，也算通过）
  persons.upsert({
    id: 'm_smoke1', feishuOpenId: null, name: '新来的小李',
    workspaceDir: `${config.workspacesRel}/m_smoke1`, avatarColor: '#FF8800', isBot: false,
  });
  const { ensureWorkspace } = await import('../executor/workspace.js');
  ensureWorkspace('m_smoke1', '新来的小李');
  mock.injectMemberJoin({ personId: 'm_smoke1', personName: '新来的小李' });
  const onboardMsg = await waitFor(
    () => mock.history.find((m) => m.chatId === 'mock-p2p-m_smoke1' && m.kind === 'card' && cardTitle(m.card).includes('快速指引')),
    60_000,
  );
  record('新人入群 → 私信项目快速指引', !!onboardMsg, cardTitle(onboardMsg?.card));

  // 11) 日报分层（新功能 2）：个人日报私信（当日已有任务/日程动作，xiaoming 必有内容）
  const pd = await generateAndSendPersonalDigests();
  const personalCard = await waitFor(
    () => mock.history.find((m) => m.chatId === 'mock-p2p-xiaoming' && m.kind === 'card' && cardTitle(m.card).includes('分身战报')),
    10_000,
  );
  record('个人日报私信（群总报之外的分层）', pd.sent >= 1 && !!personalCard, `发送 ${pd.sent} 份`);

  // ===== 新需求四连（1 MCP 封装 / 2 Agent 模式 / 3 部署页 / 4 忙闲感知）=====
  // OPENCODE_BIN 已在 env-mock 指到 scripts/fake-opencode.mjs：不烧模型，但走真实 MCP HTTP 通道交付

  // 12) 起 HTTP 服务（/mcp 与 /p/:id 挂在同一 Hono 上）+ 鉴权防线
  const { startAdminApi } = await import('../admin-api/index.js');
  startAdminApi();
  await new Promise((r) => setTimeout(r, 600));
  const mcpUrl = `http://127.0.0.1:${config.serverPort}/mcp`;
  const unauth = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer bad-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  record('MCP 无效 token 拒绝（401）', unauth.status === 401);

  // 13) Agent 对话模式全链路：假引擎经真实 MCP 交付 HTML → 自动部署 → 链接卡片（新需求 2+3）
  const { runChatAgent } = await import('../agent/run.js');
  const agentBase = mock.history.length;
  const agentReq: IncomingMessage = {
    msgId: 'smoke-agent-req', chatId: mock.demoChatId, chatKind: 'group',
    senderOpenId: 'laowang', senderName: '老王',
    text: '@Everyone 把这周的接口压测数据做成网页看板', msgType: 'text',
    mentionedBot: true, ts: new Date().toISOString(),
  };
  await runChatAgent(agentReq, persons.byId('laowang'), '老王');
  const agentSlice = () => mock.history.slice(agentBase);
  // 需求①（2026-08-29）：ack 不再发「收到」消息，改为给原消息附加表情回应（Get / 排队 OneSecond）
  const reacts = mock.reactions.get('smoke-agent-req') ?? [];
  record('Agent 模式表情回应替代「收到」消息', reacts.includes('Get') || reacts.includes('OneSecond'), reacts.join(','));
  const ackMsg = agentSlice().find((m) => m.senderIsBot && (m.text ?? '').includes('动手做'));
  record('Agent 模式不再发「收到」文本', !ackMsg, ackMsg ? (ackMsg.text ?? '').slice(0, 40) : '无 ack 消息');
  const pageCard = agentSlice().find((m) => m.kind === 'card' && JSON.stringify(m.card ?? {}).includes('/p/'));
  record('HTML 附件 → 自动部署 → 链接卡片', !!pageCard, cardTitle(pageCard?.card));

  let pageHref = '';
  let pageServed = false;
  if (pageCard) {
    pageHref = JSON.stringify(pageCard.card).match(/"url":"(http[^"]+\/p\/[0-9a-f]+)"/)?.[1] ?? '';
    if (pageHref) {
      const res = await fetch(pageHref);
      pageServed = res.status === 200 && (await res.text()).includes('冒烟数据看板');
    }
  }
  record('部署页回环可访问（200 + 内容命中）', pageServed, pageHref);

  // 过期语义：把 expires_at 拨到过去 → 410（24h 失效的可测等价物）
  let expiredOk = false;
  if (pageHref) {
    const { db } = await import('../store/db.js');
    db.prepare('UPDATE pages SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), pageHref.split('/p/')[1]);
    expiredOk = (await fetch(pageHref)).status === 410;
  }
  record('部署页过期即 410（24h 失效语义）', expiredOk);

  // 14) MCP 附件类型闸门：不支持的类型报错回传（isError），Agent 可据此重交（新需求 2c）
  const { createAgentSession, closeAgentSession } = await import('../agent/session.js');
  const { ensureAgentSandbox } = await import('../agent/run.js');
  const sandbox = ensureAgentSandbox();
  fs.writeFileSync(path.join(sandbox.dir, 'evil.exe'), 'MZ');
  const probe = createAgentSession({ mode: 'chat', chatId: mock.demoChatId, workspaceDir: sandbox.dir, label: 'smoke 探针' });
  const badAttach = await mcpToolCall(mcpUrl, probe.token, 'reply', { text: '', attachment_path: 'evil.exe' });
  record(
    'MCP 拒绝不支持的附件类型（错误回传给 Agent）',
    badAttach.isError === true && badAttach.text.includes('不支持的附件类型'),
    badAttach.text.slice(0, 60),
  );

  // 图片附件分支（2c 第三类）：1x1 PNG → 直接发图
  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(path.join(sandbox.dir, 'probe.png'), pngBytes);
  const imgBase = mock.history.length;
  const imgReply = await mcpToolCall(mcpUrl, probe.token, 'reply', { text: '看这张图', attachment_path: 'probe.png' });
  const imgSent = mock.history.slice(imgBase).some((m) => m.kind === 'image');
  record('MCP 图片附件直接发图', !imgReply.isError && imgReply.text.includes('图片已发出') && imgSent, imgReply.text.slice(0, 40));

  // send_card 工具（2d）：合法卡片发出；缺 elements 的报错回传
  const cardBase = mock.history.length;
  const cardOk = await mcpToolCall(mcpUrl, probe.token, 'send_card', {
    card: { header: { template: 'blue', title: { tag: 'plain_text', content: '冒烟信息卡' } }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**要点**：探针卡片' } }] },
  });
  const cardSent = mock.history.slice(cardBase).some((m) => m.kind === 'card' && cardTitle(m.card).includes('冒烟信息卡'));
  const cardBad = await mcpToolCall(mcpUrl, probe.token, 'send_card', { card: { header: {} } });
  record(
    'MCP send_card（合法发出 + 缺 elements 报错）',
    !cardOk.isError && cardSent && cardBad.isError === true && cardBad.text.includes('elements'),
    cardBad.text.slice(0, 50),
  );

  // 15) 忙闲感知（新需求 4）：mock 注入「会议中」→ check_busy 工具报忙 + 结束时间；恢复空闲后报空闲
  const busyInject = await fetch(`http://127.0.0.1:${config.serverPort}/api/mock/busy`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ personId: 'laowang', minutes: 45 }),
  });
  const busyAns = await mcpToolCall(mcpUrl, probe.token, 'check_busy', { person_id: 'laowang' });
  record('忙闲感知：会议中 → 报忙 + 结束时间', busyInject.ok && busyAns.text.includes('正在开会'), busyAns.text.slice(0, 60));
  await fetch(`http://127.0.0.1:${config.serverPort}/api/mock/busy`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ personId: 'laowang', minutes: 0 }),
  });
  const freeAns = await mcpToolCall(mcpUrl, probe.token, 'check_busy', { person_id: 'laowang' });
  record('忙闲感知：空闲 → 明确报空闲', freeAns.text.includes('空闲'), freeAns.text.slice(0, 60));

  // 16) MCP 建日程（新需求 2e）：虚拟成员参与人在 mock 下直接进日程（真实模式跳过并提示）
  const tmr = new Date(Date.now() + 24 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const dstr = `${tmr.getFullYear()}-${pad(tmr.getMonth() + 1)}-${pad(tmr.getDate())}`;
  const calAns = await mcpToolCall(mcpUrl, probe.token, 'create_calendar_event', {
    title: '冒烟对齐会', start: `${dstr} 14:00`, end: `${dstr} 15:00`, attendee_person_ids: ['xiaoming'],
  });
  record('MCP 创建日程', !calAns.isError && calAns.text.includes('日程已创建'), calAns.text.slice(0, 60));
  closeAgentSession(probe);

  // 17) 任务流 MCP 交付（D-N4）：帮我干任务 → 假引擎写 draft.md → feishu_reply 附件 → 云文档私信 + 迭代卡
  const mcpTask = tasks.create({
    ownerId: 'xiaoming', creatorId: 'laowang', title: '整理一份冒烟测试交付报告',
    source: 'mention', important: false, urgent: false, dueAt: null,
    status: 'todo', confidence: 0.99, chatId: mock.demoChatId,
  });
  tasks.update(mcpTask.id, { canDo: true, taskKind: 'doc' });
  const { startRun } = await import('../executor/runner.js');
  await startRun(tasks.byId(mcpTask.id)!);
  const afterRun = tasks.byId(mcpTask.id)!;
  const docDm = mock.history.find((m) => m.chatId === 'mock-p2p-xiaoming' && (m.text ?? '').includes('📄') && (m.text ?? '').includes('假引擎成稿'));
  const iterCard = mock.history.find((m) =>
    m.chatId === 'mock-p2p-xiaoming' && m.kind === 'card' && JSON.stringify(m.card ?? {}).includes(mcpTask.id));
  record(
    '任务流经 MCP 交付（md → 云文档私信 + 状态 reviewing）',
    afterRun.status === 'reviewing' && !!afterRun.docUrl && !!docDm,
    `status=${afterRun.status} doc=${afterRun.docUrl ?? '无'}`,
  );
  record('任务交付后迭代卡送达 owner', !!iterCard, cardTitle(iterCard?.card));

  // ===== 七项需求探针（1 时间 / 2·3 运行登记与轨迹 / 4 零交付抢救 / 6 消息落库检索 / 7 心跳）=====
  const { agentRuns, chats, chatLog, heartbeats } = await import('../store/repo.js');
  const { tracePath } = await import('../executor/opencode.js');

  // 18) 运行登记 + 轨迹文件（需求 2/3）：#13 的 chat 运行与 #17 的 task 运行都应留痕
  const chatRun = agentRuns.all(50).find((r) => r.mode === 'chat');
  const taskRun = agentRuns.all(50).find((r) => r.mode === 'task' && r.taskId === mcpTask.id);
  const chatTraceOk = !!chatRun && fs.existsSync(tracePath(chatRun.id))
    && fs.readFileSync(tracePath(chatRun.id), 'utf-8').includes('# trace');
  record(
    'Agent 运行登记（chat/task 两模式 + 状态与交付数）',
    !!chatRun && chatRun.status === 'succeeded' && chatRun.deliveries > 0 && !!taskRun && taskRun.status === 'succeeded',
    `chat=${chatRun?.status}/${chatRun?.deliveries}交付 task=${taskRun?.status}`,
  );
  record('OpenCode 原始轨迹落盘（data/traces/<id>.log）', chatTraceOk, chatRun ? tracePath(chatRun.id) : '无 chat 运行');

  // 任务书时间概念（需求 1）：上下文行带 [MM-DD HH:mm] 时间戳 + 任务书带当前时间
  let chatBrief = '';
  try {
    chatBrief = chatRun
      ? fs.readFileSync(path.join(config.workspacesDir, chatRun.workspaceDir.replace(/^.*_agent\//, '_agent/'), 'brief.md'), 'utf-8')
      : '';
  } catch { /* 读不到按失败记 */ }
  record(
    'Agent 任务书带时间（当前时间 + 上下文时间戳）',
    /当前时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(chatBrief) && /\[\d{2}-\d{2} \d{2}:\d{2}\]/.test(chatBrief),
    chatBrief.match(/当前时间：[^（]+/)?.[0] ?? '未命中',
  );

  // 19) 历史消息检索 MCP（需求 6）：命中带时间戳；probe 会话复用沙箱
  const probe2 = createAgentSession({ mode: 'chat', chatId: mock.demoChatId, personId: 'laowang', workspaceDir: sandbox.dir, label: 'smoke 探针2' });
  const searchAns = await mcpToolCall(mcpUrl, probe2.token, 'search_messages', { query: '竞品分析', limit: 5 });
  record(
    'MCP 检索历史消息（命中 + 带时间戳）',
    !searchAns.isError && searchAns.text.includes('命中') && /\[\d{2}-\d{2} \d{2}:\d{2}\]/.test(searchAns.text),
    searchAns.text.split('\n')[1]?.slice(0, 60) ?? searchAns.text.slice(0, 60),
  );
  const recentAns = await mcpToolCall(mcpUrl, probe2.token, 'recent_messages', { limit: 5 });
  record(
    'MCP 翻看最近消息（时间顺序 + 时间戳）',
    !recentAns.isError && /\[\d{2}-\d{2} \d{2}:\d{2}\]/.test(recentAns.text),
    recentAns.text.split('\n')[1]?.slice(0, 60) ?? '',
  );

  // 20) 消息采集按群启停（需求 6）：禁用后消息不落库，重新启用恢复
  const demoChat = chats.byId(mock.demoChatId);
  record('群聊自动注册（默认启用采集）', !!demoChat && demoChat.collectEnabled, `${demoChat?.chatId} · 已存 ${demoChat?.msgCount} 条`);
  // 只数成员消息（机器人 outbound 也会入档且受同一开关控制，但异步回复会晚到，计数只看确定性的部分）
  const userMsgCount = () => chatLog.recent(mock.demoChatId, 500).filter((r) => !(r.senderName ?? '').startsWith('Everyone（')).length;
  const cntBefore = userMsgCount();
  chats.setCollect(mock.demoChatId, false);
  mock.injectUserMessage({ personId: 'xiaohong', personName: '小红', text: '这条消息不应该被存档（采集已禁用）' });
  await new Promise((r) => setTimeout(r, 800));
  const cntDisabled = userMsgCount();
  chats.setCollect(mock.demoChatId, true);
  mock.injectUserMessage({ personId: 'xiaohong', personName: '小红', text: '这条消息应该被存档（采集已恢复）' });
  await new Promise((r) => setTimeout(r, 800));
  const cntEnabled = userMsgCount();
  record(
    '采集禁用不落库 / 启用恢复落库',
    cntDisabled === cntBefore && cntEnabled === cntBefore + 1,
    `before=${cntBefore} disabled=${cntDisabled} enabled=${cntEnabled}`,
  );

  // 21) 心跳任务全链路（需求 7）：MCP 标准传参创建 → 确认卡 → 本人确认 → 到点触发 → 独立沙箱执行 → 私信创建人
  const tmr2 = new Date(Date.now() + 30 * 60_000);
  const hbAns = await mcpToolCall(mcpUrl, probe2.token, 'create_heartbeat_task', {
    requirement: '每天播报：检索群里的压测相关消息，汇总成两句话发我',
    first_trigger_at: `${dstr} ${String(tmr2.getHours()).padStart(2, '0')}:${String(tmr2.getMinutes()).padStart(2, '0')}`,
    interval_minutes: 1440,
    total_runs: 0,
  });
  const hb = heartbeats.all()[0];
  record(
    'MCP 创建心跳任务（标准传参 → 待确认）',
    !hbAns.isError && hbAns.text.includes('待确认') && !!hb && hb.status === 'pending_confirm' && hb.totalRuns === 0 && hb.intervalMin === 1440,
    `${hb?.id} · ${hbAns.text.split('\n')[0]?.slice(0, 50)}`,
  );
  const hbCard = await waitFor(
    () => mock.history.find((m) => m.chatId === 'mock-p2p-laowang' && m.kind === 'card' && cardTitle(m.card).includes('心跳任务')),
    10_000,
  );
  record('心跳确认卡私信创建人', !!hbCard, cardTitle(hbCard?.card));
  let hbRunOk = false;
  let hbDetail = '确认卡未出现';
  if (hbCard && hb) {
    mock.injectCardClick({ msgId: hbCard.msgId, operatorId: 'laowang', value: { action: 'hb_confirm', heartbeat_id: hb.id } });
    const activated = await waitFor(() => heartbeats.byId(hb.id)?.status === 'active', 10_000);
    record('本人确认后启动（active + 排期落库）', !!activated, `next=${heartbeats.byId(hb.id)?.nextRunAt}`);
    // 拨快时钟：到点 → 调度器触发 → 假引擎在心跳沙箱经 MCP 交付
    heartbeats.update(hb.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
    const { sweepHeartbeats } = await import('../agent/heartbeat.js');
    await sweepHeartbeats();
    const hbDm = await waitFor(
      () => mock.history.find((m) => m.chatId === 'mock-p2p-laowang' && (m.text ?? '').includes('假引擎心跳')),
      30_000,
    );
    const hbAfter = heartbeats.byId(hb.id)!;
    const hbRun = agentRuns.all(50).find((r) => r.mode === 'heartbeat' && r.heartbeatId === hb.id);
    const hbSandboxOk = fs.existsSync(path.join(config.workspacesDir, '_heartbeat', hb.id, 'brief.md'));
    hbRunOk = !!hbDm && hbAfter.runsDone === 1 && hbAfter.status === 'active' && !!hbAfter.nextRunAt
      && !!hbRun && hbRun.status === 'succeeded' && hbSandboxOk;
    hbDetail = `runsDone=${hbAfter.runsDone} next=${hbAfter.nextRunAt?.slice(0, 16)} run=${hbRun?.status} sandbox=${hbSandboxOk}`;
  } else {
    record('本人确认后启动（active + 排期落库）', false, '前置失败，跳过');
  }
  record('心跳到点触发 → 独立沙箱执行 → 私信创建人 + 排期推进', hbRunOk, hbDetail);
  closeAgentSession(probe2);

  // 22) 零交付抢救（需求 4）：引擎只输出文本没走 MCP → 系统代发最终文本，用户不空手
  process.env.FAKE_OPENCODE_SILENT = '1';
  const salvageBase = mock.history.length;
  const salvageReq: IncomingMessage = {
    msgId: 'smoke-salvage-req', chatId: mock.demoChatId, chatKind: 'group',
    senderOpenId: 'xiaoming', senderName: '小明',
    text: '@Everyone 调研一下 AI 加无穷大赛的奖品有哪些', msgType: 'text',
    mentionedBot: true, ts: new Date().toISOString(),
  };
  await runChatAgent(salvageReq, persons.byId('xiaoming'), '小明');
  delete process.env.FAKE_OPENCODE_SILENT;
  const salvaged = mock.history.slice(salvageBase).find((m) => m.senderIsBot && (m.text ?? '').includes('DGX Spark'));
  const salvageRun = agentRuns.all(10).find((r) => r.request.includes('AI 加无穷'));
  record(
    '零交付抢救（模型只说话没交付 → 最终文本代发给用户）',
    !!salvaged && salvageRun?.status === 'succeeded' && (salvageRun?.deliverySummary ?? '').includes('抢救代发'),
    (salvaged?.text ?? '').slice(0, 50),
  );

  // 23) 群知识库（2026-08-29 需求⑥）：启用 → 独立沙箱维护（假引擎写 wiki.md → update_wiki）→ 在线文档登记 → get_wiki 取用
  const { runWikiUpdate, readGroupWiki } = await import('../agent/wiki.js');
  chats.setWikiEnabled(mock.demoChatId, true);
  await runWikiUpdate(mock.demoChatId, '冒烟触发');
  const wikiChat = chats.byId(mock.demoChatId)!;
  const wikiMd = readGroupWiki(mock.demoChatId);
  const wikiRun = agentRuns.all(20).find((r) => r.mode === 'wiki');
  record(
    '群知识库维护（独立沙箱 → update_wiki 覆盖在线文档）',
    !!wikiMd && !!wikiChat.wikiDocUrl && !!wikiChat.wikiUpdatedAt && wikiRun?.status === 'succeeded',
    `doc=${wikiChat.wikiDocUrl ?? '无'} · ${wikiMd?.length ?? 0} 字 · run=${wikiRun?.status}`,
  );
  // wiki 维护会话禁言：没有 reply 工具，唯一出口 update_wiki
  const wikiProbe = createAgentSession({ mode: 'wiki', chatId: mock.demoChatId, workspaceDir: sandbox.dir, label: 'smoke wiki 探针' });
  const wikiReplyTry = await mcpToolCall(mcpUrl, wikiProbe.token, 'reply', { text: '不应该发得出去' });
  record('wiki 维护会话禁用回复用户能力', wikiReplyTry.isError, wikiReplyTry.text.slice(0, 60));
  closeAgentSession(wikiProbe);
  // get_wiki：普通会话把知识库以 Markdown 拉进自己的工作区
  const probe3 = createAgentSession({ mode: 'chat', chatId: mock.demoChatId, personId: 'laowang', workspaceDir: sandbox.dir, label: 'smoke 探针3' });
  const gw = await mcpToolCall(mcpUrl, probe3.token, 'get_wiki', {});
  const gwFile = fs.readdirSync(sandbox.dir).find((f) => f.startsWith('group-wiki-'));
  record('get_wiki 把知识库放进 Agent 工作区', !gw.isError && gw.text.includes('group-wiki') && !!gwFile, gwFile ?? gw.text.slice(0, 60));
  closeAgentSession(probe3);

  // 24) 需求③：机器人 outbound 发言进存档，署名区分超级代理/分身（喂 Agent 的上下文由此包含 Everyone 自己的发言）
  const botLines = chatLog.recent(mock.demoChatId, 300).filter((r) => (r.senderName ?? '').startsWith('Everyone（'));
  const hasAvatarLine = botLines.some((r) => (r.senderName ?? '').includes('的分身'));
  const hasAgentLine = botLines.some((r) => (r.senderName ?? '').includes('超级代理'));
  record(
    '机器人发言入上下文存档（超级代理/分身署名可辨）',
    botLines.length > 0 && hasAgentLine,
    `${botLines.length} 条 · 分身署名=${hasAvatarLine} · 例：${botLines.slice(-1).map((r) => r.senderName).join('')}`,
  );

  finish(results.every((r) => r.ok) ? 0 : 1);
}

/** 走真实 HTTP 的 MCP tools/call（无状态模式：单发即可，无需 initialize 握手） */
async function mcpToolCall(url: string, token: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    const line = body.split('\n').filter((l) => l.startsWith('data:')).pop();
    if (line) parsed = JSON.parse(line.slice(5));
  }
  const result = parsed?.result;
  const text = (result?.content ?? []).map((c: any) => c?.text ?? '').join('\n') || JSON.stringify(parsed?.error ?? body).slice(0, 200);
  return { isError: result?.isError === true || !!parsed?.error, text };
}

function cardTitle(card: unknown): string {
  return String((card as any)?.header?.title?.content ?? '');
}

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs: number): Promise<T | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

function finish(code: number) {
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== smoke 结果：${pass}/${results.length} 通过 ===\n`);
  process.exit(code);
}

main().catch((e) => {
  console.error('smoke 崩溃：', e);
  process.exit(1);
});

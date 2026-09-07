// 海报视觉预览（开发工具）：假数据渲染一张日报海报到 out/
import { renderDigestPoster } from '../render/poster.js';

const png = renderDigestPoster({
  title: '预算口径定了，报告也交了',
  key_decisions: ['Q3 活动预算口径定为单场 5 万封顶（含物料）', '报表平台 10 月底完成新数仓迁移'],
  new_commitments: ['小明：周五交竞品分析报告（已入台账）', '老王：周六 15:00 前出预算测算（分身进行中）', '小红：周四改完登录页视觉稿（待确认）'],
  avatar_done: ['小明：竞品分析报告已发布（3 轮迭代）', '老王：star-utils 日期 bug 已修复（测试转绿）'],
  unanswered_mentions: ['@小红 的设计走查清单还没回音'],
  due_tomorrow: ['老王：整理用户调研问卷并发布（8/29 15:00）'],
  fun_moments: ['服务器和我一样稳定，不信你看 P95 —— 老王（14:32）', '这个 bug 不修我睡不着，修完发现是我写的 —— 小明（16:05）'],
  stats: { messages: 87, newTasks: 4, avatarDone: 2 },
}, '4/12（33%）');
console.log('PNG:', png);

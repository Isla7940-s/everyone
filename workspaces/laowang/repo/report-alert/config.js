// 周报报警配置（改这里，不改 trigger.js）
module.exports = {
  // 周报截止：每周日 20:00（本地时区）
  deadline: { weekday: 0, hour: 20 },
  // 升级提醒：周一 09:00 仍未交 → 抄送直属主管
  escalate: { weekday: 1, hour: 9 },
  // 连续未交阈值：连续 2 周未交 → 群内通报
  maxConsecutiveMiss: 2,
  // 豁免名单：休假 / 实习生首周（由 HR 系统同步，人工可临时增补）
  exempt: ['user_on_leave'],
  // 静默窗口：每天 23:00 ~ 次日 08:00 不发任何提醒（累积到窗口结束后合并发送）
  quietHours: { start: 23, end: 8 },
  // 提醒渠道优先级：先飞书私信，10 分钟未读则升级为飞书加急
  channels: ['feishu_dm', 'feishu_urgent'],
};

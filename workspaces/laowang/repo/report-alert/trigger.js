// 周报报警触发逻辑（调度器每 10 分钟调用一次 evaluate()）
const config = require('./config');

/**
 * 报警分四级，逐级升级、每级只发一次（幂等键 = 用户 + 周次 + 级别）：
 *
 * L1 到期提醒：周日 20:00（deadline）仍未提交 → 飞书私信本人
 * L2 加急提醒：L1 发出后 10 分钟未读 → 同内容改用飞书加急（channels 顺序）
 * L3 升级主管：周一 09:00（escalate）仍未提交 → 私信本人 + 抄送直属主管
 * L4 群内通报：连续 maxConsecutiveMiss（默认 2）周未交 → 周会群发通报卡片
 *
 * 全局约束：
 * - 豁免名单（exempt）内的人任何级别都不触发
 * - 静默窗口（quietHours，默认 23:00~08:00）内不发送，攒到窗口结束合并发
 * - 已提交后 5 分钟内撤回重编辑不重新触发（视为仍在编辑）
 */
async function evaluate(now, members, submissions) {
  const alerts = [];
  for (const m of members) {
    if (config.exempt.includes(m.id)) continue;
    const sub = submissions.get(m.id);

    if (isAfter(now, config.deadline) && !sub) {
      alerts.push(fire('L1', m, '周报到期未提交，请尽快补交'));
    }
    if (unreadFor(m, 'L1') >= 10 * 60 * 1000) {
      alerts.push(fire('L2', m, '周报提醒未读，升级加急'));
    }
    if (isAfter(now, config.escalate) && !sub) {
      alerts.push(fire('L3', m, '周报逾期，已抄送主管', { cc: m.managerId }));
    }
    if (consecutiveMiss(m) >= config.maxConsecutiveMiss) {
      alerts.push(fire('L4', m, `连续 ${consecutiveMiss(m)} 周未交周报，群内通报`));
    }
  }
  return withinQuietHours(now, config.quietHours) ? defer(alerts) : send(alerts);
}

/** 幂等：同一人同一周同一级别只发一次 */
function fire(level, member, text, extra = {}) {
  return { key: `${member.id}:${weekOf(Date.now())}:${level}`, level, member: member.id, text, ...extra };
}

module.exports = { evaluate };

/**
 * star-utils · 日期工具（星航 App 前端公用）
 */

/** 格式化为 YYYY-MM-DD（用于活动页倒计时与报表表头） */
function formatDate(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  // getMonth() 是 0 起始（0=1 月），需 +1 才是真实月份
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 距离目标日还有几天（负数=已过期） */
function daysUntil(target, now = new Date()) {
  const ms = new Date(target).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0);
  return Math.round(ms / 86400000);
}

module.exports = { formatDate, daysUntil };

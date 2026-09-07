const assert = require('node:assert');
const { formatDate, daysUntil } = require('./date-utils.js');

let failed = 0;
function t(name, fn) {
  try { fn(); console.log(`ok - ${name}`); }
  catch (e) { failed += 1; console.log(`FAIL - ${name}: ${e.message}`); }
}

t('formatDate 正确输出月份', () => {
  assert.strictEqual(formatDate('2026-08-28T10:00:00+08:00'), '2026-08-28');
});
t('formatDate 跨年边界', () => {
  assert.strictEqual(formatDate('2026-01-05T00:00:00+08:00'), '2026-01-05');
});
t('daysUntil 同日为 0', () => {
  assert.strictEqual(daysUntil('2026-08-28', new Date('2026-08-28T15:00:00')), 0);
});

process.exit(failed ? 1 : 0);

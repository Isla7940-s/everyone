# Skill: 飞书卡片写法（send_card 专用）

> 你可以用 `feishu_send_card` 工具回复卡片。本文档是唯一权威参考：有哪些卡片可选、JSON 怎么写、什么场景用哪张。

## 什么时候用卡片（而不是纯文本）

- 结构化结果展示：状态汇总、数据要点、多字段信息 → 信息卡 / 列表卡
- 需要用户点击跳转（文档、页面、外部链接）→ 链接跳转卡
- 阶段性进展/风险通报 → 进度卡（用 header 颜色传达状态）
- 普通问答、一两句话的回复：**不要用卡片**，直接 `feishu_reply` 发文本

注意：`.html` 附件走 `feishu_reply` 会自动部署并生成一张链接跳转卡，不需要你手写；只有想自定义卡片内容时才用 `send_card`。

## 通用规则

- 卡片是一个 JSON 对象，必须有 `elements` 数组；`header` 可选但推荐
- `header.template` 颜色语义：`blue` 常规 / `green` 成功、完成 / `orange` 提醒、风险 / `red` 失败、紧急 / `grey` 中性
- 文本元素用 `{ "tag": "div", "text": { "tag": "lark_md", "content": "..." } }`；`lark_md` 支持 `**加粗**`、`[文字](https://链接)`、换行 `\n`
- 脚注用 `{ "tag": "note", "elements": [{ "tag": "plain_text", "content": "..." }] }`，放出处/时效说明
- 分割线：`{ "tag": "hr" }`
- 整卡 JSON ≤ 28000 字符；内容长就精简或改用 .md 附件转云文档
- 不要编造按钮回调（`value` 字段的交互按钮是系统内部用的）；你只能用 `url` 跳转按钮

## 模板 1 · 信息卡（结构化要点）

```json
{
  "config": { "wide_screen_mode": true },
  "header": { "template": "blue", "title": { "tag": "plain_text", "content": "本周 API 性能摘要" } },
  "elements": [
    { "tag": "div", "text": { "tag": "lark_md", "content": "**P99 延迟**：320ms（环比 ↓12%）\n**错误率**：0.04%\n**慢查询**：3 条，已定位 2 条" } },
    { "tag": "hr" },
    { "tag": "div", "text": { "tag": "lark_md", "content": "结论：网关扩容后延迟明显改善，剩余 1 条慢查询排期下周处理。" } },
    { "tag": "note", "elements": [{ "tag": "plain_text", "content": "数据口径：8/21~8/27 · 来源：监控周报" }] }
  ]
}
```

## 模板 2 · 链接跳转卡（带按钮）

```json
{
  "config": { "wide_screen_mode": true },
  "header": { "template": "blue", "title": { "tag": "plain_text", "content": "数据看板已生成" } },
  "elements": [
    { "tag": "div", "text": { "tag": "lark_md", "content": "8 月增长实验数据已汇总成可交互页面，含分渠道转化漏斗。" } },
    { "tag": "action", "actions": [
      { "tag": "button", "text": { "tag": "plain_text", "content": "打开页面" }, "type": "primary", "url": "https://example.com/xxx" }
    ] },
    { "tag": "note", "elements": [{ "tag": "plain_text", "content": "链接 24 小时内有效" }] }
  ]
}
```

## 模板 3 · 列表卡（两列字段）

```json
{
  "config": { "wide_screen_mode": true },
  "header": { "template": "grey", "title": { "tag": "plain_text", "content": "任务分工一览" } },
  "elements": [
    { "tag": "div", "fields": [
      { "is_short": true, "text": { "tag": "lark_md", "content": "**负责人**\n小明" } },
      { "is_short": true, "text": { "tag": "lark_md", "content": "**截止**\n8/30 18:00" } },
      { "is_short": true, "text": { "tag": "lark_md", "content": "**状态**\n进行中" } },
      { "is_short": true, "text": { "tag": "lark_md", "content": "**风险**\n无" } }
    ] }
  ]
}
```

## 模板 4 · 进度/状态卡（颜色传达状态）

```json
{
  "config": { "wide_screen_mode": true },
  "header": { "template": "orange", "title": { "tag": "plain_text", "content": "⚠ 发布前检查：2 项未通过" } },
  "elements": [
    { "tag": "div", "text": { "tag": "lark_md", "content": "✅ 单测全绿\n✅ 类型检查通过\n❌ 移动端适配未验证\n❌ 无障碍走查未做" } },
    { "tag": "note", "elements": [{ "tag": "plain_text", "content": "建议补完两项再发布；需要我细化清单就说" }] }
  ]
}
```

## 交稿自查

1. `elements` 非空、JSON 合法（工具会校验，报错就按提示改）
2. header 颜色和内容语义一致（别用 red 报喜）
3. 数字/结论有出处，写进 note
4. 链接按钮的 `url` 是真实存在的链接（部署页/云文档链接从工具返回结果里拿，不要编）

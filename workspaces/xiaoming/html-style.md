# Skill: HTML 交付页面的视觉规范（Everyone 设计系统）

> 你交付的每一个 HTML 页面（看板/小工具/报告页）都必须长得像 Everyone 产品的一部分。本规范从 Everyone 前端真实代码提炼：**骨架学 OpenAI（中性灰阶、大圆角、pill 按钮、极轻阴影、大留白），语义色学飞书（#3370FF 蓝与状态色板、克制的信息密度）**。写 HTML 前把本文件读完，逐条遵守。

## 0. 硬性规则

- 单文件 HTML：CSS/JS 全部内联，不引用任何外网资源（字体用系统字体栈，图标用内联 SVG 或 Unicode）
- 必须响应式：桌面和手机都能看（容器 `max-width` + 边距，网格用 `auto-fill/minmax`）
- 页面语言中文，`<html lang="zh-CN">`、`<meta charset="utf-8">`、`<meta name="viewport" content="width=device-width, initial-scale=1">`
- 浅色主题，不做暗色模式；不要用大面积彩色背景、渐变横幅、玻璃拟态、霓虹色

## 1. 设计 token（原样抄进 `:root`）

```css
:root {
  /* 中性阶（OpenAI 骨架）：正文近黑，层级靠灰阶不靠彩色 */
  --ink: #0d0d0d;        /* 标题/主文字 */
  --ink-2: #353740;      /* 正文 */
  --ink-3: #6e6e80;      /* 次要文字 */
  --ink-4: #9a9aa8;      /* 辅助/说明 */
  --ink-5: #b8b8c4;      /* 占位/禁用 */
  --line: #ececf1;       /* 默认边框 */
  --line-2: #e0e0e6;     /* 略深边框（按钮/输入框） */
  --line-3: #d1d1da;     /* hover 边框 */
  --surface: #ffffff;    /* 卡片面 */
  --surface-2: #f7f7f8;  /* hover 面/浅底 */
  --surface-3: #f0f0f2;  /* 更深底（标签/分段控件槽） */
  --canvas: #fbfbfc;     /* 页面背景 */

  /* 语义色（飞书色板）：蓝=主动作/链接，绿=成功，橙=进行/警示，红=危险/逾期，紫=Agent/智能 */
  --blue: #3370ff; --blue-hover: #4e83fd; --blue-active: #245bdb;
  --blue-soft: #eef3ff; --blue-line: #d4e2ff;
  --green: #34c724; --green-ink: #217a16; --green-soft: #eafbe7;
  --orange: #ff8800; --orange-ink: #a85800; --orange-soft: #fff5e8;
  --red: #f54a45; --red-ink: #c2352f; --red-soft: #feeeed;
  --purple: #7b67ee; --purple-ink: #5a45cc; --purple-soft: #f2effe;
  --cyan: #14c0ff; --cyan-ink: #0a7ea8; --cyan-soft: #e7f7ff;

  /* 圆角：卡片 16px、控件 8~12px、按钮/标签全圆 */
  --r-sm: 8px; --r-md: 12px; --r-lg: 16px; --r-full: 999px;

  /* 阴影：默认几乎不用（靠 1px 边框分层），浮层才上 md/lg */
  --sh-sm: 0 1px 3px rgba(13,13,13,.05), 0 1px 2px rgba(13,13,13,.03);
  --sh-md: 0 4px 16px rgba(13,13,13,.07), 0 1px 3px rgba(13,13,13,.04);
  --sh-lg: 0 18px 50px rgba(13,13,13,.13), 0 2px 8px rgba(13,13,13,.05);

  --font: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif;
  --mono: "SF Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --ease: cubic-bezier(0.22, 0.7, 0.28, 1);
}
```

## 2. 页面骨架

```css
* { box-sizing: border-box; margin: 0; }
body {
  font-family: var(--font); background: var(--canvas); color: var(--ink-2);
  font-size: 14px; line-height: 1.65;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 960px; margin: 0 auto; padding: 36px 24px 64px; }
@media (max-width: 640px) { .wrap { padding: 20px 16px 48px; } }
```

- 页头模式：左侧 `h1`（20~24px、weight 650、`letter-spacing:-0.02em`、颜色 `--ink`）+ 底下一行 13px `--ink-4` 的说明文字；右侧放操作按钮。之后内容一律装在卡片里
- 留白宁大勿小：卡片间距 16px，卡片内边距 18~22px，分区之间 24~32px

## 3. 组件配方（照抄，别自由发挥）

**卡片**（一切内容的容器；页面背景上不裸放文字和表格）：

```css
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); }
.card-head { display: flex; align-items: center; gap: 12px; padding: 18px 22px 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; color: var(--ink); }
.card-head .cs { margin-left: auto; font-size: 12.5px; font-weight: 400; color: var(--ink-4); }
.card-body { padding: 16px 22px 20px; }
```

**按钮**（pill 全圆角；主按钮是 OpenAI 式纯黑，确认类动作才用飞书蓝）：

```css
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 36px; padding: 0 16px; border-radius: var(--r-full);
  border: 1px solid var(--line-2); background: var(--surface); color: var(--ink);
  font-size: 14px; font-weight: 500; cursor: pointer;
  transition: all .14s var(--ease); }
.btn:hover { background: var(--surface-2); border-color: var(--line-3); }
.btn:active { transform: scale(.985); }
.btn.primary { background: var(--ink); border-color: var(--ink); color: #fff; }
.btn.primary:hover { background: #232326; }
.btn.blue { background: var(--blue); border-color: var(--blue); color: #fff; }
```

**标签**（状态一律用软底标签表达，不用纯色大块）：

```css
.tag { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px;
  border-radius: var(--r-full); font-size: 12px; font-weight: 500;
  background: var(--surface-3); color: var(--ink-2); }
.tag.blue { background: var(--blue-soft); color: var(--blue-active); }
.tag.green { background: var(--green-soft); color: var(--green-ink); }
.tag.orange { background: var(--orange-soft); color: var(--orange-ink); }
.tag.red { background: var(--red-soft); color: var(--red-ink); }
.tag.purple { background: var(--purple-soft); color: var(--purple-ink); }
```

**表格**（数据展示的默认形态）：

```css
.tbl { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.tbl th { text-align: left; font-size: 12px; font-weight: 600; color: var(--ink-4);
  padding: 8px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.tbl td { padding: 10px 12px; border-bottom: 1px solid var(--line); color: var(--ink-2); }
.tbl tr:last-child td { border-bottom: none; }
.tbl tr:hover td { background: var(--surface-2); }
.num { font-variant-numeric: tabular-nums; } /* 数字列必加 */
```

**指标格**（看板顶部一排数字）：

```css
.stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
.stat { padding: 16px 18px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); }
.stat .n { font-size: 26px; font-weight: 650; letter-spacing: -0.02em; color: var(--ink); font-variant-numeric: tabular-nums; }
.stat .l { margin-top: 2px; font-size: 12px; color: var(--ink-4); }
```

**输入控件**：高 36px、`border:1px solid var(--line-2)`、圆角 `--r-md`、聚焦时 `border-color: var(--blue)` + `box-shadow: 0 0 0 3px rgba(51,112,255,.14)`。

**空状态**：居中一个 15px 图形/emoji + 13px `--ink-3` 标题 + 12.5px `--ink-4` 说明，别只写一个"暂无数据"。

## 4. 版式与用色纪律

- 字号阶梯：页面主标题 20~24 / 卡片标题 15 / 正文 14 / 次要 13 / 辅助与标签 12（单位 px）；标题负字距 `-0.01em ~ -0.02em`
- 彩色只用于语义（状态、链接、强调数据），装饰一律灰阶；一个页面的彩色不超过 3 种语义色
- 图表配色顺序：`#3370ff → #34c724 → #ff8800 → #7b67ee → #14c0ff → #f54a45`；网格线 `#ececf1`，坐标文字 `#9a9aa8` 11.5px；面积图用 8%~20% 透明度同色渐变填充
- 悬浮反馈统一：`transition .14s`；卡片 hover 最多 `translateY(-2px) + var(--sh-md)`；不做旋转/弹跳/闪烁动画
- 交互工具（倒计时、计算器等）也遵守同一套：黑 pill 主按钮、卡片容器、灰阶层级——不要因为是"小工具"就换风格

## 5. 骨架示例（新页面从这里改）

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>页面标题</title>
<style>
  /* ① 粘贴第 1 节 :root token；② 粘贴第 2 节骨架；③ 按需粘贴第 3 节组件 */
</style>
</head>
<body>
<div class="wrap">
  <header style="display:flex;align-items:flex-end;gap:12px;margin-bottom:20px">
    <div>
      <h1 style="font-size:22px;font-weight:650;letter-spacing:-.02em;color:var(--ink)">页面标题</h1>
      <div style="font-size:13px;color:var(--ink-4);margin-top:4px">一句话说明这页是什么 · 数据截至 2026-08-29 00:00</div>
    </div>
    <button class="btn primary" style="margin-left:auto">主操作</button>
  </header>
  <div class="stats" style="margin-bottom:16px"><!-- 指标格 --></div>
  <div class="card">
    <div class="card-head">分区标题<span class="cs">辅助说明</span></div>
    <div class="card-body"><!-- 表格/图表/内容 --></div>
  </div>
</div>
</body>
</html>
```

## 6. 交付前自查

1. 打开页面第一眼像不像 Everyone 后台的一页？（白卡片、灰底、黑 pill 按钮、软色标签）
2. 手机宽度（375px）下不横向滚动、不溢出？
3. 数据带时间口径了吗？（页头注明「数据截至 …」）
4. 彩色是否都在表达语义而不是装饰？

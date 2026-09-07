# 模板资产（FR-H3）

## 可视化模板（D14：服务端渲染）

四象限图与排期图的 SVG 生成器位于 `apps/server/src/render/`（`quadrant.ts` / `schedule.ts`），
以参数化 TS 模板实现（布局常量、配色、槽位在文件头部集中定义），比静态 `.svg` 占位文件更能表达动态行数。
调整视觉只需改这两个文件；渲染管线：SVG 字符串 → `@resvg/resvg-js` → PNG → `out/` → lark-cli 发送。

配色约定（与管理后台一致）：

| 语义 | 色值 |
| --- | --- |
| 品牌蓝 / Q2 重要不紧急 | `#3370FF` |
| Q1 重要紧急 | `#F54A45` |
| Q3 紧急不重要 | `#FF8800` |
| Q4 不重要不紧急 | `#8F959E` |
| 进行中 | `#7B67EE` |
| 已发布 | `#34C724` |

## 人设模板

新建评审人设：复制 `persona-template/` 到 `personas/<你的人设名>/`，改两个文件即可。
内置三人设见 `personas/laok`（数据严谨）、`personas/xiaolu`（用户视角）、`personas/jinshu`（风控敏感）。

## Skill 模板

给某个成员新增技能：复制 `skill-template.md` 到 `workspaces/<person>/skills/<技能名>.md`，
或直接在管理后台「工作空间 → Skills → 新建」里编辑（即时生效）。

## Bitable 台账模板

首次以 live 模式启动时自动创建（字段 schema 见 `apps/server/src/ledger/bitable.ts` 的 `FIELDS`），
无需手工建表；台账链接启动后打印在管理后台顶栏。

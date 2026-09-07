---
name: everyone-collab-sandbox
description: Everyone 远程求助沙箱专用 Skill：完成任务书要求的工作，并用沙箱内 CLI 提交文字回复与附件。
---

# Everyone 远程求助沙箱（精简 Skill）

你在一个**远程求助沙箱**里工作：Everyone 云端的 Agent 缺少上下文，指名请这台机器上的你协助。沙箱由本地客户端创建，内容都在当前目录：

| 路径 | 内容 |
| --- | --- |
| `HELP.md` | 任务书：背景、求助问题、期望产出、回复要求（**先读它**） |
| `session/` | 被求助的完整原始工作会话（云端只有总结，原文只在这里） |
| `workspace/` | 原工作目录的文件快照（可读可改，改动不会影响原目录） |
| `output/` | 你的产出文件放这里 |
| `everyone.mjs` | 沙箱专用 Everyone CLI |

## 工作流程

1. 读 `HELP.md`，明确要回答什么/做什么；
2. 读 `session/` 里的原始会话，结合 `workspace/` 快照还原当时的上下文；
3. 完成求助要求的工作（回答问题、补文件、改代码、整理数据……），产出写进 `output/`；
4. 提交结果（唯一出口，不提交 = 云端 Agent 永远等不到）：

```bash
# 有产出文件先上传附件（可多次），附件会同步进云端 Agent 的沙箱
node everyone.mjs help attach output/结论.md output/patch.diff

# 最后提交文字回复（求助就此完成，只能提交一次）
node everyone.mjs help reply --file output/回复.md --note "已完成：xxx"
# 或短回复：node everyone.mjs help reply --text "结论是……" --note "已完成"

# 确实做不了时如实报告失败
node everyone.mjs help reply --failed --error "会话中引用的仓库已不存在，无法复现"
```

## 约束

- 沙箱内 CLI **只有**「提交回复」「上传附件」两项能力，没有任务/时间/总结命令；
- 文字回复是云端 Agent 阻塞等待的返回值：直接给结论与依据，不要寒暄；
- 不要往沙箱外写任何文件；秘密信息（密钥/token）不要写进回复与附件。

# Everyone

> **每个人的分身，替每个人做事。**
> 装进飞书群里的个人分身：帮你记、替你做、帮你审、帮你收、帮你答——人只负责拍板。

飞书 AI 绝活大会黑客松作品。产品完整定义见 [everyone-PRD.md](./everyone-PRD.md)，飞书接入细节见 [LARK-CLI.md](./LARK-CLI.md)。

## 它做什么

| 能力 | 一句话 | 场景 |
| --- | --- | --- |
| 帮你记 | 群里的承诺、@ 指派、会议行动项自动入台账（四象限 + 排期，图片实时渲染） | 「周五前我把报告发出来」→ 确认卡 → 台账 + 四象限图 |
| 替你做 | 分身在你的沙箱工作区（记忆 + 技能 + 代码仓）里替你干活：写报告、改代码、整理数据，私信迭代，你拍板发布 | 「我把日期 bug 修了」→ 分身改代码 + 跑测试 + 变更报告私信你 |
| 会聊天 | @它没命中任何任务也会正常回话（带群记忆上下文）；发图片它能看懂 | 「@Everyone 上周说的口径是多少」→ 带出处回答 |
| 帮你审 | 报告发群后，三个人设评审（老 K / 小鹿 / 谨叔）逐条引用原文评论 | 交付前先过一轮多视角预评审 |
| 帮你收 | 群里的意见自动判定责任人，记入 TA 的记忆并私信 TA | 「空白页很影响体验」→ 私信负责人，一键转任务 |
| 帮你答 | 有人提问且你的记忆答得了，分身署名代答（必带出处，可撤回） | 「预算口径多少？」→ 「（老王的分身）答：… 出处：8/20 会议纪要」 |
| 日报导读 | 每天定时把群里发生的事浓缩成 ≤300 字的导读 | 不在场也不错过 |

**核心设计**：
- 四层记忆（L0 原文 → L1 事实 → L2 场景 → L3 画像），群聊、会议、文档全量入库，召回必带出处
- 一人一分身：每人独立的 `memory.md` + `skills/` + 产物仓
- 人工确认铁律：一切对外输出要么事前确认，要么强制署名 + 可撤回
- 全栈可换：模型只要 OpenAI 兼容就能接，数据全部落在自己机器上

## 15 分钟装进你的群

### 0. 前置

- Node ≥ 20.12（推荐 22+；建议用 nvm 装版本管理器：`nvm install 22 && nvm use 22`，避免系统自带旧版 node 启动挂住）
- pnpm（没有的话 `corepack enable` 即可）
- Docker（记忆引擎用，没有也能跑——自动降级）
- 一个飞书账号（个人版即可）

### 1. 装飞书 CLI 并授权（约 5 分钟）

```bash
npx @larksuite/cli@latest install     # 安装官方 lark-cli
lark-cli config init --new           # 浏览器里一键建应用
lark-cli auth login --recommend      # 浏览器里授权（免审批权限包）
lark-cli doctor                      # 自检，全 pass 才继续
```

在[开放平台后台](https://open.feishu.cn)你的应用里做两件事（各 30 秒）：
1. **事件与回调 → 回调配置**：开启 `card.action.trigger`（卡片按钮回调）
2. **权限管理**：开通 `im:message.group_at_msg:readonly` 与 `im:message.p2p_msg:readonly`（实时收消息；不开也能跑，走轮询降级，延迟 ≤5s）

### 2. 配置项目（约 2 分钟）

```bash
git clone https://github.com/Isla7940-s/everyone.git && cd everyone
cp .env.example .env
# 编辑 .env：填 OPENAI_BASE_URL / OPENAI_API_KEY / MODEL（任意 OpenAI 兼容服务）
pnpm install
```

### 3. 建 demo 群（1 分钟）

```bash
# 机器人建群并把你拉进去（把 ou_xxx 换成你的 open_id，用 lark-cli contact +get-user --as user 查）
lark-cli im +chat-create --as bot --name "Everyone Demo 群" --users <你的open_id> --set-bot-manager
# 把返回的 chat_id（oc_ 开头）填进 .env 的 DEMO_CHAT_ID
```

### 4. 可选组件（记忆引擎 + 执行引擎，共 3 分钟）

**记忆引擎**（四层记忆的向量召回；不装自动降级 SQLite 全文检索）：

```bash
docker run -d --name everyone-memory --restart unless-stopped -p 8420:8420 \
  -v everyone-memory-data:/opt/data \
  -e MODEL_API_KEY="<你的LLM_KEY>" -e MODEL_BASE_URL="<你的LLM_BASE_URL>" \
  -e MODEL_NAME="<模型名>" -e MODEL_PROVIDER="custom" \
  agentmemory/hermes-memory:1.0.0-beta
# 把容器生成的 key 填进 .env 的 TDAI_GATEWAY_API_KEY：
docker exec everyone-memory sh -c 'grep TDAI_MEMORY_API_KEY /opt/data/.env'
```

> 不装 Docker 也能跑：记忆自动降级为 memory.md 直读 + SQLite 全文检索，主链路不受影响（帮你答会停用）。

**OpenCode 执行引擎**（分身「替你做」代码任务用的 headless Agent；不装也能跑——文档类任务自动降级内置引擎，代码类任务诚实报错）：

```bash
npm i -g opencode-ai      # 或 brew install sst/tap/opencode，见 https://opencode.ai
opencode --version        # 确认在 PATH 里；路径不对可在 .env 里改 OPENCODE_BIN
```

### 5. 启动

```bash
pnpm dev          # server（连真实飞书）
pnpm dev:admin    # 前端开发模式（热更新）
```

两个入口：

| 地址 | 是什么 |
| --- | --- |
| http://localhost:8901 | **产品前端**。进来先选身份（演示环境不校验），两种视角二选一 |
| http://localhost:8901/simulator.html | **模拟群聊**（开发工具）。用浏览器替代飞书群，产品前端不链接到这里 |

登录页两种身份，看到的东西不一样：

| 身份 | 能看到 | 看不到 |
| --- | --- | --- |
| **团队成员**（选人进） | 我的工作台（含全员排期，只读）、我的任务、我的分身（记忆 / 技能 / 产出 / 代收代答 / 沙箱文件） | 团队页、别人的任务明细、全局实时动态、评审与日报开关 |
| **管理员** | 全局视图（全员四象限 + 可改截止日的排期 + 实时活动流）、全员任务台账（批量操作）、团队近期任务、评审与日报 | 「我的分身」——管理员没有分身，越权路由自动回全局视图 |

> 生产/长跑模式：`pnpm --filter @everyone/admin build && ./scripts/start-server.sh`——server 直接托管前端构建产物，单进程访问 http://localhost:8902 与 http://localhost:8902/simulator.html。

在群里说一句「周五前我把 XX 报告发出来」，看确认卡出现。🎉

### 没有飞书？先玩模拟模式

```bash
CHAT_ADAPTER=mock pnpm dev
pnpm dev:admin    # 打开 http://localhost:8901/simulator.html
```

模拟群聊与真实飞书走**同一套业务代码**，只是消息进出走浏览器界面——开发、演示、体验三用。

## 自测

```bash
pnpm smoke        # 不连飞书（11 项）：识别 → 台账 → 渲染 → 任务书按任务隔离 → 幂等 → 卡片永不静默 → 兜底对话
pnpm smoke:live   # 连飞书：doctor、scope 断言、发文本/图片/私信
pnpm smoke:collab # 跨端协同全链路（36 项，零模型成本）：CLI → 总结上传 → MCP 查询 → 阻塞式远程求助 → Python 客户端沙箱执行 → 时间穿透 → 任务完成确认流
pnpm stress       # 刷屏压测（隔离实例）：111 条混合消息全速注入，验证不丢/不重/不崩
pnpm eval:intent  # 意图分类回归评测（20 条标注语料，门槛 ≥85% 且承诺零漏检）
pnpm verify       # 以上除 live 外全部串行跑一遍（提交前的总门禁）
./scripts/demo.sh # §10 演示剧本八幕串演（含代码任务幕）；对干净 mock 实例运行，见脚本头注释
node scripts/collab-ui-check.mjs  # 时间穿透/跨端协同页 UI 自检（需先起 server，Playwright 截图）
```

## 架构

```
飞书开放平台
  ▲ 写：lark-cli +shortcut 子进程（发消息/卡片/图片/文档/多维表格）
  │ 读：lark-cli event consume 常驻（消息 + 卡片回调）+ user 轮询兜底
  ▼
apps/server（Node + TS 超级代理）
  ├─ lark/     适配层（live 真飞书 / mock 模拟群聊，同一业务接口）
  ├─ ingest/   意图识别（承诺/@ 指派/会议/意见/提问）
  ├─ memory/   四层记忆（TencentDB Agent Memory，BM25 免向量，SQLite）
  ├─ ledger/   任务台账（SQLite 事实源 ←→ 飞书多维表格镜像）
  ├─ executor/ 分身执行（OpenCode headless，失败降级内置 executor）
  ├─ reviewer/ 评审团（三个人设，回复式评论）
  ├─ presence/ 帮你收 + 帮你答
  ├─ digest/   日报导读
  ├─ render/   四象限图 / 排期图（SVG → PNG 服务端渲染）
  └─ admin-api REST + SSE
apps/admin（Vite + React，两个入口）
  ├─ index.html      产品前端：选身份 → 成员视角（我的工作台 / 我的分身）或管理员视角（全局视图 / 台账 / 评审）
  └─ simulator.html  模拟群聊（开发工具，与产品前端物理分离）
workspaces/<person>/  memory.md + skills/ + repo/ + tasks/<taskId>/{brief.md, draft.md, notes/}
personas/             评审人设（老 K / 小鹿 / 谨叔）
prompts/              全部提示词（文件化，可改）
cli/everyone.mjs      Everyone CLI（跨端协同，只装用户本地；求助沙箱内自动降为「回复+附件」两项能力）
clients/              本地 Python 客户端（单文件）：接云端远程求助 → 还原会话 → 建沙箱 → 跑本地 Codex → 回传
skills/everyone-collab/  标准 Skill（Codex/Cursor/Claude Code 可装）+ 沙箱精简 Skill + install.sh
```

## 跨端协同（本地 Agent 工作记录 + 云端远程协作）

完整设计见 [跨端协同.md](./跨端协同.md)。一句话：**本地 Agent 在授权范围内识别工作、上传总结（原文永远留在本地）；任务完成与时间去向先草稿、经本人确认后经 CLI 正式上传；云端 Agent 通过 MCP 查这些总结，缺上下文时经阻塞式远程求助唤起用户本地客户端，还原原始会话、建沙箱、跑本地 Codex，把回复与附件带回云端。**

- **接入**：后台「跨端协同」页生成个人 token → `curl -fsSL <server>/api/collab/kit/install | BASE_URL=<server> bash` 装 Skill+CLI → `python3 everyone_local_client.py init && run` 起本地客户端（三份分发件都可从 `/api/collab/kit/*` 拉取）
- **云端 MCP**（沙箱 Agent 自动注入最近 5 条总结）：`collab_list/search_work_summaries`、`collab_get_work_session_detail`、`collab_get_related_work_sessions`、阻塞式 `collab_request_remote_help`、`collab_wait_help_result` / `collab_get_help_result`
- **时间穿透**：管理员看团队、成员看自己，周视图柱状按大需求分层，逐级下钻到子任务 → 工作会话（25 字 / 100 字总结）

## 沙箱与隔离

分身「替你做」时在哪里动手、能动什么，全部有边界、全部可围观：

| 层 | 隔离方式 | 用户怎么看 |
| --- | --- | --- |
| 文件 | 一人一个 `workspaces/<person>/`，OpenCode 子进程 cwd 锁死在该目录，改不到别人的工作区与主项目；**一任务一目录** `tasks/<taskId>/`（brief.md 任务书、draft.md 成稿、notes/ 过程笔记），任务之间互不覆盖 | 「我的分身 → 沙箱文件」访达式目录浏览（目录树 + 面包屑 + 文件预览，任务 id 显示为任务标题）；任务抽屉里 brief / draft 一键预览 |
| 执行 | 每次执行 = 一个独立 OpenCode headless 子进程，超时强杀（`OPENCODE_TIMEOUT_SEC`）；代码任务执行前后做全仓哈希快照，变更清单自动核对并附进报告（不存在「偷偷改了没说」） | 分身开工时私信告知沙箱路径；活动流实时显示「+新增 ~修改 -删除」 |
| 数据 | 每个实例独立 `DATA_DIR`（SQLite）；压测/测试永远跑在 `data-stress/` 等隔离目录，不碰真实数据 | `/api/health` 暴露实例数据计数 |
| 记忆 | 记忆引擎按 `person:<id>` / `group:<chatId>` session 隔离；画像文件（memory.md）本人可在工作空间直接编辑 | 工作空间「记忆」编辑器，保存即生效 |
| 对外 | 一切对外发送经人工确认或强制署名可撤回（§6.0 铁律）；文档以本人（user）身份创建，归本人名下 | 每张卡片可点、可用文字指令等价操作 |

## 第三方依赖与协议

- [@larksuite/cli](https://github.com/larksuite/cli)（MIT）— 飞书官方 CLI，唯一的飞书通道
- [OpenCode](https://opencode.ai)（MIT）— headless 执行引擎（可缺省，自动降级）
- [TencentDB Agent Memory](https://www.npmjs.com/package/@tencentdb-agent-memory/memory-tencentdb)（MIT）— 四层记忆引擎（可缺省，自动降级）
- OpenAI 兼容 LLM 服务 — 自备（`OPENAI_BASE_URL`/`OPENAI_API_KEY`/`MODEL` 三个环境变量）

## 安全与隐私

- 飞书凭证由 lark-cli 存 OS 钥匙串，仓库与 `.env` 不含任何 App Secret
- LLM 密钥只走环境变量，`.env` 已 gitignore
- demo 数据全部为虚构人物；对外发送动作全部有人工确认（或强制署名 + 可撤回）

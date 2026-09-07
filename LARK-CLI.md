# Everyone · 飞书接入总纲(lark-cli)

> 本文是 PRD §7.4–§7.6 的展开版,面向**装机的人**和**写代码的 AI 执行者**。
> PRD 是唯一事实源;本文与 PRD 冲突时以 PRD 为准,与**实测**冲突时以实测为准(并回写决策日志)。

| 项 | 内容 |
| --- | --- |
| 工具 | 飞书官方 CLI,npm 包 `@larksuite/cli`,命令名 `lark-cli`,Go 实现 + npm 分发,MIT |
| 实测版本 | `1.0.90`(2026-08-27,macOS) |
| 为什么用它 | 免写 SDK 胶水与鉴权、免公网回调、命令即文档、缺口有 `api` 兜底(2500+ 端点);同时它本身就是「飞书 + AI」这条评分线的直接体现 |
| 决策依据 | PRD D15 / D16 / D17 |

---

## 1. 装机(一次性,约 5 分钟)

```bash
# 0) 前置:Node ≥ 20.12 —— CLI 的 npm 包装脚本用到 node:util 的 styleText,Node 18 会直接报错
node -v

# 1) 安装(官方一键脚本,内部做 npm install -g + 下载 Go 二进制)
npx @larksuite/cli@latest install

# 2) 安装官方 Skills(给 AI 执行者看的用法手册,26 个)
npx -y skills add https://open.feishu.cn --skill -y

# 3) 建应用:命令会阻塞并打印一个链接,人在浏览器里完成
lark-cli config init --new

# 4) 授权:同样打印链接,人在浏览器里确认
lark-cli auth login --recommend

# 5) 自检:全 pass 才算装好
lark-cli doctor
```

### 装机踩过的坑(实测)

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `The requested module 'node:util' does not provide an export named 'styleText'` | Node < 20.12 | 切到 Node ≥ 20.12(nvm) |
| 一键脚本走到最后报 `Failed to install globally` | npm 11 默认拦截 postinstall 脚本,而下载 Go 二进制正是在 postinstall | `npm install -g --allow-scripts=@larksuite/cli @larksuite/cli`,或按提示手动重跑 |
| 装完在别的终端里 `lark-cli: command not found` | 全局包只落在当时那个 Node 版本的 `bin` 下 | 把真实二进制软链到常驻 PATH:`ln -sf "$(npm root -g)/@larksuite/cli/bin/lark-cli" ~/.local/bin/lark-cli` |
| `config init` 一直不返回 | **这是设计如此**,它在等浏览器完成 | 后台运行、从输出里取链接给人,超时上限约 10 分钟 |

---

## 2. 三层调用,优先级从上到下

| 层 | 形态 | 何时用 |
| --- | --- | --- |
| **Shortcut** | `lark-cli im +messages-send ...` | **默认**。智能默认值、结构化输出、`--dry-run`,为 Agent 调优过 |
| API 命令 | `lark-cli mail user_mailbox.messages list ...` | 与平台端点 1:1,shortcut 覆盖不到时 |
| Raw API | `lark-cli api POST /open-apis/im/v1/messages ...` | 逃生口,覆盖 2500+ 端点 |

写调用前先自省,**不要凭记忆写参数**:

```bash
lark-cli <domain> --help                 # 域内所有 shortcut 与资源
lark-cli <domain> +<shortcut> --help     # 单个命令的全部 flag
lark-cli schema im.messages.delete       # 参数、类型、scope、支持的身份
lark-cli skills read lark-im             # 域指南(概念、选型、约定)
lark-cli event schema <EventKey>         # 事件字段口径(见 §4)
```

---

## 3. 本项目用到的命令清单

以下每条都对应 PRD 里的一个 FR。**这是速查,不是替代 `--help`**。

### 消息与卡片

```bash
# 发群消息 / 私信(--chat-id 与 --user-id 二选一)
lark-cli im +messages-send --as bot --chat-id oc_xxx --text "..." --idempotency-key "<task-id>"

# 发图片:直接给本地路径,CLI 自动上传 + 发送(FR-B5/B6)
#   ⚠️ 只收 cwd 相对路径,绝对路径和 .. 会被拒
lark-cli im +messages-send --as bot --chat-id oc_xxx --image out/quadrant-xiaoming.png

# 发交互卡片(FR-B3 确认卡、FR-C5 私信迭代卡)
lark-cli im +messages-send --as bot --chat-id oc_xxx --msg-type interactive --content @card.json

# 在源消息下回复(S1 回四象限图、FR-D4 人设评论)
lark-cli im +messages-reply --as bot --message-id om_xxx --text "..."

# 更新已发出的卡片(点完按钮把卡片改成「已确认」)
#   token 来自 card.action.trigger 事件,30 分钟内有效,最多改 2 次
lark-cli api POST /open-apis/interactive/v1/card/update --data @update.json

# 降级路径:轮询补齐群消息(§7.6)
lark-cli im +chat-messages-list --as user --chat-id oc_xxx --order desc --page-all
```

### 文档(FR-C4 / FR-C5)

```bash
# 建文档:多行内容一律用 @file 或 stdin,别拼进命令行
lark-cli docs +create --as bot --doc-format markdown --title "竞品报告" --content @outbox/t-001/draft.md

# 迭代:覆盖同一篇,不新建
lark-cli docs +update --as bot --doc <doc-token> --command overwrite \
  --doc-format markdown --content @outbox/t-001/draft-v2.md

# 读文档(FR-D2 评审外部文档)
lark-cli docs +fetch --doc <url-or-token>
```

### 多维表格台账(FR-B1 / B2 / B4)

坐标是 `--base-token` + `--table-id`(注意**不是** `--app-token`;`--table-id` 也接受表名)。

```bash
lark-cli base +table-create   --base-token <t> ...                    # 建表 + 字段 schema + 视图
lark-cli base +view-set-group --base-token <t> --table-id tbl_xxx ... # 四象限:按象限分组的看板视图
lark-cli base +record-upsert  --base-token <t> --table-id tbl_xxx ... # 入账 / 状态流转
lark-cli base +record-search  --base-token <t> --table-id tbl_xxx ... # 大屏与日报取数
lark-cli base +url-resolve --url "<多维表格链接>"                      # 从链接反解出可用坐标
```

### 通讯录(open_id ↔ 姓名)

事件里的 `sender_id` 只有 open_id,姓名要另查。**`+search-user` 只支持 `--as user`**(这是本项目里少数必须用 user 身份的读操作),而群成员列表 bot 也能读——建议启动时用后者一次性建好 `open_id → 姓名` 映射进 SQLite,运行期不再逐条查。

```bash
lark-cli im +chat-members-list --as bot --chat-id oc_xxx --page-all   # 建映射表(首选)
lark-cli contact +search-user --as user --query "小明"                 # 兜底,单个补查
lark-cli contact +get-user --as user                                   # 拿自己的 open_id
```

---

## 4. 事件消费:常驻子进程契约

**这是整个接入层最容易写错的地方,逐条照做。**

```bash
lark-cli event list                          # 全部可订阅 EventKey
lark-cli event schema im.message.receive_v1  # 字段口径(写 jq 之前必读)
lark-cli event consume im.message.receive_v1 --as bot
```

本项目常驻两个进程(**一个 EventKey 一个进程,不支持多 key**,底层共享一个 bus daemon,开销很小):

| 进程 | EventKey | 用途 |
| --- | --- | --- |
| A | `im.message.receive_v1` | 群消息 + 私信(FR-A1) |
| B | `card.action.trigger` | 卡片按钮回调(FR-B3 / FR-C5) |

### 六条硬约束

1. **等 ready 再读**:stderr 会打一行 `[event] ready event_key=<key>`,父进程阻塞读 stderr 直到看见它,再开始读 stdout。**不要用 `sleep` 兜底。**
2. **别关 stdin**:无界运行时 stdin EOF 被当作优雅退出信号。Node 里 `spawn` 的 `stdio` 必须保留可写 stdin,写成 `'ignore'` 或 `< /dev/null` 会导致进程刚起来就退出(stderr 显示 `reason: signal`)。
3. **停用 SIGTERM,禁止 `kill -9`**:`-9` 会跳过服务端退订,重启时报「订阅已存在」或收到重复投递。
4. **退出码即语义**:`0` = limit / timeout / signal(正常结束);`1` 业务失败;`2` 参数非法;`3` 鉴权失败(带 `missing_scopes`);`4/5` 网络或内部错误。非 0 → 指数退避重启 + 大屏告警。
5. **重启后回捞**:断连期间的消息用 `im +chat-messages-list` 补,靠 `message_id` 幂等去重(FR-A2)。
6. **`--quiet` 禁用**:它会连 ready / exit 标记和丢事件告警一起吞掉。

### 字段口径(最反直觉的一点)

`im.message.receive_v1` 的输出**不是 OAPI 原始报文**——CLI 做了拍平和预渲染:

- 字段在**顶层**(`.chat_id` / `.sender_id` / `.content`),不是 `.event.xxx`;
- `.content` 对 `text` / `post` / `image` / `file` 等**已经是人类可读纯文本**,`@提及`已解析成显示名 → **直接用,不要 `fromjson`**;
- **只有 `interactive`(卡片)** 的 `.content` 是 JSON 字符串,需要 `fromjson`;
- 对非 JSON 内容误用 `fromjson`,jq 会在**每条事件上报错并静默跳过**——进程看着活着却不产出,只有 stderr 一行 WARN。这是最难查的一类故障;
- `sender_id` **只有 open_id**,没有姓名,要姓名得另查通讯录。

```bash
# 只要群里的文本消息
lark-cli event consume im.message.receive_v1 --as bot \
  --jq 'select(.chat_type=="group" and .message_type=="text")
        | {chat: .chat_id, from: .sender_id, msg: .content, mid: .message_id}'
```

> 本项目 server 端**不建议**在 `--jq` 里做业务过滤:原始 NDJSON 全量入库再过滤,便于回放与排障。`--jq` 只在人工调试时用。

### 总线健康与自愈(2026-08-28 实测坑)

- **僵尸总线是真实故障模式**:`event _bus` 进程存在、consumer 进程存在,但 WebSocket 已断——此时 `lark-cli event status --json` 的 `apps[].running=false` 是唯一事实源。消息侧有轮询兜底看不出来;**卡片回调没有任何兜底,此状态下点卡片 100% 失败**。
- 对策(本项目 `lark/health.ts`):45s 周期探测 `event status --json`;连续 2 次不健康 → `event stop --all --force` 清僵尸 → SIGTERM 两个 consumer → 重新 `start()`(consume 会自动拉起新总线)。
- 实测:`kill -9` 总线后 consumer 约 77s 自行检测断连退出(退出码 0),退避重启后订阅恢复;总线「最后一个 consumer 退出 30s 后自动退出」。

### 卡片更新的两个 API(实测结论,别用错)

| API | 生效范围 | 用途 |
| --- | --- | --- |
| `PATCH /open-apis/im/v1/messages/:message_id`(`--data '{"content":"<卡片JSON字符串>"}'`) | **全部成员**,14 天内 | 状态翻转(已确认/已忽略)一律用它 |
| `POST /open-apis/interactive/v1/card/update`(token 来自点击事件,30 分钟/2 次;Card 1.0 必须带 `open_ids`) | **只有 open_ids 里的人** | 仅适合给点击者个人的视图反馈;误当全局更新会导致其他成员永远看到活按钮 |

注意:`lark-cli api` 只接受 `METHOD /path` 原生形式;`lark-cli api im.messages.patch --message-id` 这种 schema 名 + 旗标的写法不存在。

### 记忆引擎相关(TencentDB Agent Memory,顺手记录)

- `writeScenario` 是**更新型**接口,目标文件不存在时 404(`Scenario file not found`)——L2 场景文件只能由引擎管道从对话自动生成,外部想「写画像」应把画像逐行 `addConversation` 进 L0(BM25 可召回)。

---

## 5. 输出契约与错误处理

成功 → **stdout**,退出码 0:

```json
{ "ok": true, "identity": "user", "data": { }, "meta": { "count": 1 } }
```

失败 → **stderr**,退出码非 0:

```json
{ "ok": false, "identity": "user",
  "error": { "type": "authorization", "subtype": "missing_scope",
             "code": 99991679, "message": "...", "hint": "...",
             "missing_scopes": ["calendar:calendar.event:read"] } }
```

铁律:

- 判断成败看 **`ok` 或进程退出码**,**绝不能看 `code == 0`**。成功信封里根本没有 `code`;`code` 只在错误信封里,含义是上游 OAPI 的错误码。
- 分支靠 `error.type` / `error.subtype`,补救靠 `error.hint`,**不要正则匹配 `message` 文本**。
- `missing_scope` 会带 `missing_scopes` 数组 → 直接据此生成补授权命令给用户,不要让人自己猜。

常用 flag:`--format json|pretty|table|ndjson|csv`、`--jq <expr>`、`--page-all`、`--dry-run`(有副作用的命令**先预览**)。

---

## 6. 身份、权限与安全

### 身份

CLI 有 **bot** 与 **user** 两套身份,`--as bot` / `--as user` 显式指定。本项目规矩:

- 一切**面向群和成员的输出**用 `--as bot`(它才是「Everyone」这个角色);
- 只有**读取发起人自己的数据**(如降级轮询群历史)才用 `--as user`;
- **不依赖 `auto`**,避免同一条命令在不同环境下换了身份还没人发现。

### 权限

```bash
lark-cli auth status                 # 当前身份与已授权 scope
lark-cli auth check <scope>          # exit 0 = 有,1 = 缺 —— 用在启动自检里
lark-cli auth scopes                 # 应用可申请的全部 scope

# 补授权(非阻塞式,适合 Agent):先拿链接给人,人确认后再收尾
lark-cli auth login --scope "<scope>" --no-wait --json
lark-cli auth login --device-code <device_code>
```

`--recommend` = 免管理员审批的常用权限包,本项目**除两项外**都在里面(逐项见 PRD §7.4):

- `im:message.group_msg` —— 收群内全部消息,**敏感权限,要管理员批**。没有它机器人只能收到 @ 自己的消息。未获批的降级方案见 PRD §7.6,**主线不受影响**;
- `card.action.trigger` —— 不是 scope 而是**开发者后台的事件开关**,必须手工打开,否则卡片按钮点了没反应。

> 已实测:`--recommend` 拿到的包里**没有**日历权限,也没有上面第一项;但**有** `im:message.group_msg:get_as_user`,这正是降级方案能成立的原因。

### 安全红线(叠加 PRD §9)

- Token 存 OS 钥匙串,**不落仓库**;`.env` 里不再有 App Secret(D17);
- 机器人只进 demo 群,不进真实同事群;
- 所有对外发送前有人工确认(PRD §6.0),`--dry-run` 用于开发期验证;
- 不动 CLI 的默认安全配置(如 `config risk-control`)。

---

## 7. 代码侧封装(`apps/server/src/lark/`)

所有 `lark-cli` 调用**只允许出现在这一层**,业务模块调类型化函数,不许散落 `spawn('lark-cli')`。

```
apps/server/src/lark/
├─ exec.ts        # 一次性命令:spawn → 等退出 → 解析信封 → ok? data : throw LarkCliError
├─ consumer.ts    # 常驻 consumer:ready 握手、NDJSON 行解析、SIGTERM 退出、退避重启
├─ im.ts          # sendText / sendImage / sendCard / reply / listChatMessages
├─ docs.ts        # createDoc / overwriteDoc / fetchDoc
├─ base.ts        # upsertRecord / searchRecords / ...
└─ errors.ts      # LarkCliError:type / subtype / missingScopes / hint
```

`exec.ts` 的最小职责:

1. 固定 `--format json`,`cwd` 固定到项目根(保证 `--image` 的相对路径成立);
2. 退出码非 0 → 解析 stderr 信封 → 抛 `LarkCliError`(带 `missingScopes`),**不吞错**;
3. 写操作统一注入 `--idempotency-key`;
4. 每次调用记一条 audit 日志(命令 + 参数摘要 + 耗时 + ok),喂给大屏活动流(FR-G1)。

`consumer.ts` 的最小职责:按 §4 六条约束实现,对外暴露 `on(event => ...)` 与 `stop()`。

---

## 8. 交付前自检

```bash
lark-cli doctor                                   # 配置 / 双身份 / 连通性
lark-cli auth check im:message                    # 按 PRD §7.4 逐项断言
lark-cli event consume im.message.receive_v1 --as bot --max-events 1 --timeout 30s   # 收一条真实消息
lark-cli im +messages-send --as bot --chat-id "$DEMO_CHAT_ID" --text "ping" --dry-run
```

`pnpm dev` 启动时自动跑前两条,缺什么就把补授权命令打到控制台,不让人去猜。

---

## 9. 参考

- 仓库:<https://github.com/larksuite/cli> · npm:`@larksuite/cli`
- 本机 Skills(26 个,已随装机安装):`lark-cli skills list` / `lark-cli skills read <name>`
- 给 AI 的技巧:任意飞书开放平台文档 URL **加 `.md` 后缀**即可拿到原始 Markdown

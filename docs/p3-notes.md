# P3：去审批 + 两层记忆（2026-11-01）

按方案 v3，把 P1~P2 的审批体系整套拿掉，换成"Agent 直接做事、有记忆、需要你拿主意时发选择卡"。

## 删掉了什么

- 策略引擎（`policy.ts`）、审批（`approvals.ts`）、hook 服务（`hooks.ts`）、worker 里的 `hook.mjs` 和 managed settings。
- 远程 API 的审批 / 核对接口，设备权限范围里的 `approve`，Web 上的工单和"待处理"页，CLI 的 `approvals / approve / deny / action resolve / bot policy`。
- 插件清单里的 `permissions.actions`（旧清单会被明确拒绝）。

## 执行

- 每轮 `claude -p --permission-mode bypassPermissions`，实测 `run.init` 里 `permissionMode=bypassPermissions`。
- 每个 Bot 同一时刻只跑一轮；当前会话 = 最近一条没归档的 Thread。
- 工具调用记录直接取自 stream-json：`tool_use` 记 running，`tool_result` 定成败；`max_actions` 在 runner 里数，超了自动中断。
- 被打断时在途的有副作用操作记 `unknown`，只在时间线上留一行；下一轮开头用 `[系统说明]` 告诉 Agent，让它自己核实。不再弹任何东西给你。
- **新会话**：`POST /api/bots/:name/session`（CLI `pagent session new`、`chat --new`）。旧 Thread 归档，排队消息挪过去，没回答的选择卡作废。Agent 也可以调 `new_session` 工具，这一轮结束后换。

## pagent MCP（pagentd 自带）

挂在每一轮上，HTTP（`pagentd:7701/mcp`），凭据是这一轮的 run token，轮次结束即失效。

| 工具 | 作用 |
|---|---|
| `remember(text, replaces?)` | 写全局记忆（关于你）；更正时带上原条目编号 |
| `ask_user(question, options[], allowCustom)` | 发选择卡，这一轮随即结束；你的任何下一条消息都算回答 |
| `new_session(reason)` | 这一轮结束后换新会话 |

## 记忆

- 全局记忆在库里（`memories` 表），每条记来源 Bot 和 run；单条 ≤500 字，合计 ≤8000 字，超了让 Agent 先合并。
- Agent 记忆是它家里的 `~/.claude/memory/*.md`。每次工具结果回来后 pagentd 扫一遍这个目录，有变化就发 `memory.updated`，所以 Agent 用 Write 还是 Bash 改都能实时看到。
- 关掉了 Claude Code 自带的 auto-memory（`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`）。

### 关键发现：会话的系统提示在第一轮就固定了

实验（同一会话）：第一轮 `--append-system-prompt "宠物叫小黑"`；之后 `--resume` 不带追加 → 答"小黑"；`--resume` 追加"宠物叫大黄" → 仍答"小黑"。
即 `--resume` 会忽略新的系统提示；Claude Code 在会话开头注入的内容（含 auto-memory 说明）也存进了会话记录。

所以记忆的送达改成（`threads.mem_base / mem_delivered`）：
1. 新会话第一轮：人设 + 说明 + 两层记忆写进系统提示；
2. 之后每轮和已送达版本比对，有变化就在消息前补一段 `<pagent-update>`（只写变化）；老会话从没收到过的补发全文 `<pagent-context>`；
3. 收到 `compact_boundary` 时退回系统提示里的版本，下一轮重新补；
4. Agent 自己这一轮写的算已送达。

系统提示整条会话不变，提示缓存不会因为记忆变化而失效。

## 出口

- worker 规则 `*`：放行公网。目标先解析，落在私有 / 回环 / 链路本地 / CGNAT / 组播段就拒绝，连接直接用校验过的 IP。
- **fake-ip**：claude-2 所在网络的路由器劫持了 53 端口（连 223.5.5.5 都返回 198.18.x.x）。198.18/15 不当私网，但用 DoH（`https://1.1.1.1/dns-query`）复查真实地址，真实地址是内网的照样拒（`192.168.0.1.nip.io` 被拒）。
- worker 同时设大小写的 `http_proxy` 等变量（curl 只认小写）。

## Web 控制台

界面从"印章与工单"换成现代简洁风格：浅色侧栏、白色工作区、细分隔线，主按钮墨黑，彩色只用于状态（工作中绿、等你回答琥珀、失败红），跟随系统深色模式。

- 选择卡（点选项 = 发消息）、名单上"在等你回答"的角标。
- 时间线上的记忆变化行、"新会话"分隔线、自动压缩提示、结果不明的说明。
- "它记得什么"面板（查看 / 编辑 / 删除 / 新建记忆文件）和"关于我"页面（全局记忆，带来源和时间，可增删）。

## 已验证

| 场景 | 方式 | 结果 |
|---|---|---|
| 聊天全程不出现审批，直接执行 Bash | e2e + 浏览器 | ✅ |
| tester 用 `remember` 记下"猫叫年糕"，helper 下一轮答出"年糕" | CLI | ✅ |
| 老会话（P2 时代开的）第一次收到全文补发，答出你的称呼和住处 | CLI | ✅ |
| 你在面板里改 MEMORY.md，下一轮 Agent 就知道 | 浏览器 + CLI | ✅ |
| 运维值班用 `replaces` 改写称呼，没有新增 | 浏览器 | ✅ |
| 选择卡：发卡后这一轮结束、状态 asking；点选项后它接着做并写进自己的记忆 | 浏览器 + e2e | ✅ |
| 新会话：新 session id，记得你和猫，不记得上一句 | CLI + e2e | ✅ |
| 打断长命令：interrupted，在途 Bash 记为结果不明 | e2e | ✅ |
| example.com 200；192.168.0.1、192.168.0.1.nip.io 被拒 | Agent 里 curl | ✅ |
| 断线续传不重不漏、撤销设备立即断流 | e2e | ✅ |

单元测试 16/16，e2e 5/5（`PAGENT_E2E_BOT=tester node --test packages/daemon/test/remote.e2e.ts`）。

## 还没做

- 夜间记忆整理 Routine（P5）。
- 插件 web-fetch 的授权快照格式变了，已启用它的 Bot 需要 `pagent plugin enable` 重新启用一次。
- worker 之间在沙箱网络里互相可达（目前 worker 不监听端口；P4 加桌面前要隔开）。

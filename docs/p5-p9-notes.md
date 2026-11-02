# P5~P9 与 Codex 引擎（2026-11-01 ~ 11-02）

接着 [p4-notes](p4-notes.md)：盒子化之后，把 Grok Bot 0.18 剩下的部分补齐，并让每个 Bot 可以选 Claude（`claude -p`）或 Codex（`codex exec`）作为引擎。都在 claude-2 上部署、在 Web 控制台里实测过。

## P5 屏幕

| 部件 | 位置 | 说明 |
|---|---|---|
| 显示器 | `packages/host/src/screens.ts` | 每个 Agent 一块 `:n`（1280×800）：Xvfb + fluxbox + x11vnc（5900+n）+ websockify（6080+n）；空闲回收 |
| Chrome | 同上 | `--remote-debugging-port=19222+n`，带 `--test-type` 去掉 `--no-sandbox` 提示条；网关在 127.0.0.1:9222+n 起一个懒启动的 CDP 代理，Agent 第一次连上时才拉起 Chrome |
| 登录共享 | `packages/host/src/cookies.ts` | 方案 B：每 3 秒经 CDP `Storage.getCookies / setCookies` 把各 Chrome 的 cookie 汇到一个罐子里再分发，所以 A 登录过的网站 B 直接是登录状态 |
| screen MCP | `packages/host/src/screen-mcp.ts`，网关 `/mcp/screen` | `screenshot / open_browser / click / move / type / key / scroll / fill_secret`；按本轮 token 认证，自动绑定到这个 Agent 的显示器 |
| browser MCP | `playwright-mcp --cdp-endpoint http://127.0.0.1:9222+n` | 网页里的事优先用它 |
| 预览 / 接管 | pagentd `/api/screen*`、`/api/vnc/<networkToken>`（WS）、`/novnc/*` | Web 里"屏幕"按钮只看；接管时屏幕工具暂停，交还后恢复。`request_takeover` 工具发一张"请你接管"卡，并推送 |

Bot 状态多了 `computer`（最近一个工具是 screen / browser）。

实测：helper 登录 the-internet.herokuapp.com 时发接管卡，我在 Web 里接管输入账号密码后交还，它确认进了 /secure；tester 随后直接以登录状态访问。

## Codex 引擎

- 盒子镜像里装 `@openai/codex`；所有 Codex Bot 共用 `CODEX_HOME=/home/box/.pagent/codex`（登录一次全体可用），`skills` 也链到共享 skill 目录。
- 登录：设置 → 引擎 → Codex 用设备码登录（网关 `/api/codex/login` 起 `codex login --device-auth`，把链接和码给 Web）。**没有把 Mac 上的 `~/.codex/auth.json` 拷过来**：refresh token 会轮换，两边同时用会把一边挤掉。
- 每轮：`codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C /workspace -c mcp_servers.*=… [-m 模型] resume <id> -`（新会话不带 `resume`）。pagent / screen / browser MCP 都用 `-c` 挂上。
- pagentd 的 `engines.ts` 把 Codex 的 JSONL（`thread.started`、`item.*`、`turn.completed`）翻译成和 Claude stream-json 一样的形状，下游（时间线、动作记录、记忆、预算）不用分支。
- Codex 没有系统提示参数：新会话第一轮把系统提示放进 `<pagent-context>` 前置到消息里；之后靠 `resume` 延续，记忆变化照旧用 `<pagent-update>` 补发。
- 换引擎会开新会话（两边的会话不通用），记忆保留。

实测：Bot "codex助手" 跑命令、写记忆、用浏览器（共享登录）、跨轮 resume 都正常。

## P6 Routine 与推送

- `routines.ts`：5 段 cron，时区 `PAGENT_TZ`（默认 Asia/Shanghai）；调度器每 20 秒看一次；`webhook=true` 时生成 `/hook/<token>`。
- 触发 = 往 Bot 当前会话排一条带 `meta.routine` 的消息。这一轮回复只有 `NO_NEWS` 就安静收尾（时间线一行灰字），否则发 `notify` 事件并推送。
- Agent 自己可以用 `create_routine / list_routines / delete_routine` 管理；Web 有 Routine 页（开关、现在运行、删除、新建）。
- Web Push：`push.ts` 零依赖实现 VAPID（ES256）+ aes128gcm（RFC 8291，有附录向量单测）。推送 `notify`、选择卡、接管请求；点通知打开 `/#bot=<名字>`。

实测：每 2 分钟的"新闻巡检"第一次有内容（通知）、下一次 NO_NEWS（安静）、加一行新闻后又通知；Web 上停用开关立即生效。

## P7 本机执行与保险箱

- 守护进程 `packages/localexec`：`pagent-local pair <配对码>` 后 `pagent-local run --root <开放目录>`；以 `local` 权限的设备身份连 `/api/local-exec/requests`（SSE）拉任务，结果 POST 回 `/responses`。路径一律 realpath 后限制在开放目录内（符号链接跳不出去）。
- 只有 `local` 权限的设备只能访问 local-exec 路由。
- Agent 工具：`list_machines`、`ExternalShell`（最多等 25 秒，没完返回 jobId）、`AwaitExternalShell`、`ExternalRead`。
- 每台电脑"关闭 / 允许"两档，默认关闭；关掉的瞬间新任务被拒、在途任务取消并通知守护进程杀掉命令。
- 保险箱 `vault.ts`：AES-256-GCM，密钥 `data/vault.key`。每轮整份交给盒子：作为环境变量，以及 `fill_secret` 由网关直接打字进输入框。时间线和事件里出现的值会被遮成 `••••••`。
  - 取舍：Agent 如果 `echo $X`，模型本身能看到明文（只是时间线遮住了）。和 Grok 一样，靠人设约束 + 遮挡，不是硬隔离。

## P8 协作

- `collab.ts`：
  - `list_agents`、`message_agent(to, text, expectReply=true)`：消息排进对方当前会话，并在 `assignments` 表记一条托付（`meta.assignment`）。
  - **等齐了再交回**（借鉴 OpenMausBot 的任务树）：同一轮里托付出去的事是一批。每件做完先记下结果；这一批全部有结果、且发起的那一轮也结束了，才合成一条消息发回发起方（`meta.reply=true`，回复不再要求回复）。总管只醒一次，拿着全部结果汇总，不用轮询。
  - 对方停下来问用户（选择卡、接管）时这件事继续等，用户回答后那一轮的结果才算数。
  - 等超过 60 分钟（`PAGENT_COLLAB_WAIT_MIN`）就先交回已有的结果，迟到的之后单独发。
  - 发起方在等时状态是 `waiting`，网页显示「在等 X、Y 回复」。
  - 环路保护：转发层数 ≤ 4（一轮的层数取触发它的消息里最大的）；每个 Agent 每小时最多发 30 条。
  - `notify_user` 在 P6 已做。
- 群聊：`groups` 表（成员、可选总管）。你在群里说话：@ 到谁就发给谁；没 @ 就交给总管（没有总管就发给所有成员）。总管收到的消息里附带成员名单和"用 message_agent 分派、回来后汇总"的提示。
- 群时间线 `/api/groups/:id/history` = 群里的发言 + 成员之间的消息 + 由群消息触发的那些轮次里 Agent 说的话和用的工具。Web 侧栏有"群聊"分组、建群弹窗、群页面（交接用虚线框显示"A → B"）。

实测（验收）：在群"调研小组"（总管 helper，成员 tester、codex助手）里发一个两部分的调研任务。helper 把浏览器那部分交给 tester（Claude），命令行那部分交给 codex助手（Codex），两边并行做完自动回复，helper 汇总成 5 行发回群里。

## P9 客户端

- 不做原生 App：Web 控制台本身是 PWA（`manifest.webmanifest`、`sw.js`、180/192/512 图标、`apple-mobile-web-app-*`），手机"添加到主屏幕"即可，推送走 Web Push（iOS 16.4+ 需要先添加到主屏幕）。
- "它会的技能"：Bot 设置 → 查看技能，列出共享 skill 和该 Bot 启用的插件带来的 skill（`skills.ts`，读 SKILL.md 的 frontmatter）。
- 实测：manifest、图标、Service Worker（activated）、PushManager 都在；预览浏览器的通知权限是 denied，真实推送需要在手机或桌面浏览器上点"打开通知"验证。

## 其他

- 出口：设置 → 网络 → "走家里线路"，写 `data/egress-upstreams.json` 给 egress 代理按容器选上游；`PAGENT_HOME_PROXY` 从 `data/home-proxy` 读。
- 部署：`rsync` 到 claude-2 后 `npx tsc -p . && ./deploy/dc.sh restart pagentd`；改了 `packages/host` 要 `docker restart pagent-box`。

## 订阅凭据同步（2026-11-02 修复）

Claude CLI 刷新令牌时写新文件再 rename，会把 Agent 配置目录里指向宿主凭据的软链接换成普通文件；刷新令牌是轮换的，其他 Agent 手里的旧令牌随即作废（表现为 `OAuth session expired and could not be refreshed`）。网关的 `syncCred()` 在每轮开始前和每 30 秒做一次：以到期时间最晚的一份为准，原地写回共享文件（宿主 `~/.claude/.credentials.json` 也随之更新），再把各 Agent 的软链接恢复。

剩下的风险：两个 Agent 恰好同时发现令牌过期、同时刷新，后到的那个会失败一轮；如果在 claude-2 宿主上直接用 claude 并触发刷新，宿主那边会 rename 出一个新文件，盒子里的单文件挂载仍指向旧文件，需要 `docker restart pagent-box` 重新挂载。

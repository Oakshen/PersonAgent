# PersonAgent 方案 v4

> **v4 的变化（2026-11-01）**：电脑这一层改为**优先复刻 Grok Bot 0.18 的架构**（依据 [shadown 的逆向拆解](https://shadown.github.io/blog/posts/2026-09-03_grok_bot_how-it-works/) 和官方文档）：
> 1. **整个 PersonAgent 一台"盒子"（box）**，所有 Agent 共用：文件、浏览器登录、命令行凭据、装好的工具和 skill 都共享；每个 Agent 只独占自己的**屏幕**、会话和记忆。取代 v3 的"每个 Agent 一个容器"。
> 2. **Agent 循环跑在盒子里**，由盒子里的常驻网关 `pagent-host`（对应 Grok 的 `host-main.cjs`）启动和管理；pagentd 只做"后端 + 分配盒子"，通过 `ensureBox()` 拿到网关地址和令牌。
> 3. 屏幕照抄 Grok：X11 + noVNC + Chrome，每个 Agent 一个显示器，Chrome 调试端口 `9222 + 显示器编号`，只在盒子内部可达。
> 4. 以后可选：让盒子替你在自己的 Mac 上执行命令（本机执行守护进程），以及保险箱。
>
> **有意不复刻的**：Auto Review 审批（v3 已决定不要审批）；Cursor 的多租户后端（我们是自托管、单用户）。
>
> v3 已完成的部分（去审批、bypass、两层记忆、选择卡、新会话、出口代理、设备认证、Web 控制台）全部保留，见 [p3-notes](p3-notes.md)。

## 1. 产品定义

**一个 Agent = 一个身份 + 盒子上的一块屏幕 + 一条连续的会话 + 它自己的记忆。所有 Agent 共用你的一台盒子。**

你在手机或网页上和它说话，它就去做。它在盒子上拥有全部权限，不会为每个动作来问你。它记得你们之间的事，也记得关于你的事。一个 Agent 留下的文件、登录好的网站、装好的工具，别的 Agent 接着就能用。

| 对象 | 含义 | 作用域 |
|---|---|---|
| **Agent** | 名字、头像、人设、模型 | — |
| **盒子（box）** | 一台常驻的 Linux 电脑：终端、文件、浏览器、桌面 | **账号共享** |
| **屏幕** | 盒子上的一个 X11 显示器 + 它自己的 Chrome | 每个 Agent 一块 |
| **会话** | 每个 Agent 一条 Claude Code session，一直 resume；可以"新会话" | Agent |
| **Agent 记忆** | 它自己的工作记忆，实时写入 | Agent |
| **全局记忆** | 关于你这个人 | 所有 Agent 共享 |
| **Skill / 插件 / MCP** | 可复用的能力 | 装一次，所有 Agent 可用 |
| **Routine** | 定时或事件触发，在该 Agent 的会话里运行 | Agent |
| **群聊** | 多个 Agent 加你，在同一条时间线上协作 | 群 |

## 2. 设计原则

1. **不打断**。界面上没有审批。Agent 只有在它自己判断需要你时，才发一张**选择卡**（第 7 节）。
2. **盒子就是边界**（和 Grok 一致）。
   - 盒子碰不到宿主机和你家的局域网；出网经过出口代理。
   - **Agent 之间不是安全边界**：屏幕只是各自的工作区。不想让所有 Agent 都能用的凭据或文件，就不要放进盒子。
   - 盒子坏了可以重建：持久盘保留，系统层重来。
3. **会话连续，记忆独立于会话**。
4. **一切都在时间线上**。
5. **少即是多**。

## 3. 参考来源与对照

来源：
- [shadown：Grok Bot 0.18 如何工作（逆向拆解）](https://shadown.github.io/blog/posts/2026-09-03_grok_bot_how-it-works/)：**本版架构的主要依据**
- [Parker Rex：0.47 静态拆解](https://parkerrex.com/writing/how-grok-bot-works)：指出 0.47 已不再随客户端附带 `host-main.cjs`，0.18 的结论有约一半已变化。我们复刻的是 0.18 公开可见的结构。
- 官方文档：[Security FAQ](https://docs.x.ai/grok-bot/security-faq)、[Computer and apps](https://docs.x.ai/grok-bot/computer-and-apps)、[Overview](https://docs.x.ai/grok-bot/overview)、[设计文](https://x.ai/news/designing-grok-bot)
- 文档显示 Grok Bot 实际由 Cursor（Anysphere）托管运行：客户端代号 `sand`，后端 `api2.cursor.sh`。

### 3.1 Grok Bot 0.18 组件 → PersonAgent

| Grok Bot 0.18 | 作用 | PersonAgent v4 |
|---|---|---|
| 后端 `api2.cursor.sh`（Connect RPC + 账号 OAuth） | 账号、会话存档、模型调用入口 | **pagentd**：设备认证、Agent、时间线、两层记忆、调度（已有） |
| 盒子分配器 `ensureSandBox()` | 分配或找到用户的盒子，返回 `gatewayUrl / gatewayToken / networkToken / vncUrl / forkVncBaseUrl / terminalsFolder` | **`ensureBox()`**：确保 `pagent-box` 在跑且规格最新，返回同名字段（4.2） |
| 每用户一台 Firecracker 微型虚拟机，持久盘，镜像更新会重建 | 用户之间硬件级隔离 | **一个 `pagent-box` 容器**（claude-2 这台虚拟机本身就是硬件边界）；持久卷 `/home/box`、`/workspace`；镜像更新时重建，系统层装的东西会丢。以后可换 Kata / Firecracker |
| 盒子镜像 `cursorenvironments/universal:sand-box-latest` | 通用开发环境 | **`pagent-box` 镜像**：Debian + Node + Python + git + Chrome + Xvfb + noVNC + Claude Code |
| `host-main.cjs`：盒子内常驻网关，`/health`、`/events`(SSE)、`/api/<method>`、`/local-exec/*`、`/webauthn/*`，令牌鉴权 | 盒子里的总管，Agent 循环跑在这里 | **`pagent-host`**：同样的路由；每轮按 Agent 启动 `claude -p`；工具调用、屏幕、本机执行都经过它（4.3） |
| `/home/box`、`/workspace` | 家目录、持久工作区 | 同名同义 |
| X11 + noVNC + Chrome；`box-chrome` 启动器；CDP 端口 `9222 + 显示器编号`，只在盒内可达 | 每个 Bot 一块屏幕 | **照搬**（第 8 节） |
| `vncUrl` + `x-anyrun-network-token` 头 | 客户端看/接管屏幕 | pagentd 代理 `vncUrl`，用 `x-pagent-network-token` 鉴权 |
| `forkVncBaseUrl` | 文章未说明，推测是按屏幕分出的 VNC 地址 | 每块屏幕一个地址：`{forkVncBaseUrl}/{显示器编号}` |
| `terminalsFolder` | 命令输出落盘的目录，Agent 可以回读 | `/home/box/.pagent/terminals/<agent>/<run>/`，后台命令的输出也放这里 |
| 盒内自动审查分类器 | 决定自动执行还是问你 | **不做**（v3 决定） |
| `refreshMcp`：设置里的 MCP 推送到盒子；Bot 用命令起的 MCP 所有 Bot 可用 | 共享 MCP | pagent MCP（记忆、选择卡、新会话）+ 插件 MCP + 盒内 MCP，全部 Agent 共享 |
| 本机执行守护进程 `local-exec-daemon`（SSE 拉取 `/local-exec/requests`，`ExternalShell / ExternalRead / AwaitExternalShell`） | 让盒子在你的 Mac 上执行命令 | **P7 可选**：同样的拉取协议；权限只有"关闭 / 允许"两档，默认关闭（第 10 节） |
| `setBoxSecrets` + Keychain；Vault / 安全表单"模型看不见值" | 凭据 | **P7 保险箱**：pagentd 加密存放，按需现取或代填，模型不看明文 |
| `sand-webauthn-signer`、1Password 启动器 | 通行密钥、密码管理器 | 暂不做；遇到通行密钥或二步验证就请你接管屏幕 |
| 会话存在后端，不在盒子上（`rm -rf` 删不掉聊天） | 盒子坏了不丢聊天 | 时间线和事件在 pagentd；Claude Code 的 session 文件在盒子的持久卷上 |

### 3.2 继续沿用的 Grok 经验（v3 已落地）

| Grok Bot 的做法 | 用户反馈 | 我们怎么做 |
|---|---|---|
| 侧边栏是 Bot 名单，头像表示状态 | 好评 | 已实现 |
| 一个 Bot 一条长会话，没有清空按钮 | 越聊越贵、越笨 | 一条 session + 自动压缩 + **"新会话"**（已实现） |
| Auto Review 审批 | 抱怨最多 | **不做审批**（已实现） |
| 状态 / 预览 / 接管三档电脑 | 好评 | 照做（P5） |
| Bot 主动发选择卡 | 好评 | `ask_user`（已实现） |
| 记忆冻结在 system prompt 里 | 会忘事 | 两层记忆、实时送达（已实现，见 5.2） |
| 出口是机房 IP | 常被网站拦 | 自托管，可选家里线路 |

## 4. 架构

### 4.1 总览

```
手机 / Web 控制台 / CLI
        │  设备认证（已完成）
        ▼
pagentd（"后端"，SQLite）── 时间线、Agent、两层记忆、调度、设备
  ├─ ensureBox()：确保盒子在跑，返回网关地址和令牌
  ├─ 运行一轮：POST {gatewayUrl}/api/runTurn → 订阅 {gatewayUrl}/events 落库
  ├─ pagent MCP：remember / ask_user / new_session（以后加 message_agent、notify_user）
  └─ 代理屏幕：/vnc/<agent> → 盒子里的 noVNC（带 network token）
        │  沙箱网络（只有 pagentd、盒子、出口代理、插件）
        ▼
pagent-box（整个 PersonAgent 一台，常驻）
  ├─ pagent-host（网关，等同 host-main.cjs）
  │    /health  /events(SSE)  /api/<method>  /local-exec/*  /vnc/*
  ├─ 每个 Agent：
  │    ├─ CLAUDE_CONFIG_DIR=/home/box/.pagent/agents/<id>/claude   会话 + 它自己的记忆
  │    ├─ DISPLAY=:<n>  Xvfb + 一个 Chrome（CDP 9222+n，只在盒内）
  │    └─ 每轮：claude -p --resume <session> --permission-mode bypassPermissions
  ├─ 共享：/workspace、/home/box（命令行凭据、gh/ssh 登录等）、skill、MCP、装好的软件
  └─ Claude 订阅凭据：复用宿主登录（同现在）
egress 出口代理：放行公网，挡局域网 / CGNAT / 元数据；fake-ip 用 DoH 复查（已完成）
插件容器：仍然各自独立、只能访问声明过的目标（第三方代码，信任级别不同）
```

### 4.2 `ensureBox()`

pagentd 在每轮开始前（以及 Web 打开屏幕时）调用：

1. 盒子容器不存在、没在跑、或镜像 / 规格版本变了，就（重新）创建，持久卷原样挂回。
2. 等 `pagent-host` 的 `/health` 通过。
3. 返回：

| 字段 | 含义 |
|---|---|
| `gatewayUrl` | `http://pagent-box:7700`（只在沙箱网络里可达） |
| `gatewayToken` | pagentd 调网关用的令牌，盒子每次启动时新生成，写在 pagentd 一侧 |
| `networkToken` | 浏览器看屏幕时用的短期令牌（经 pagentd 代理，放在 `x-pagent-network-token` 头里） |
| `vncUrl` | 整个盒子的 noVNC 入口 |
| `forkVncBaseUrl` | 按屏幕分的 VNC 地址前缀 |
| `terminalsFolder` | 命令输出目录 |

### 4.3 `pagent-host`（盒子里的网关）

一个零依赖的 Node 进程，盒子的 PID 1 之下常驻。监听沙箱网络地址，每个请求都要 `gatewayToken`。

| 路由 | 作用 |
|---|---|
| `GET /health` | 存活与版本 |
| `POST /api/runTurn` | `{agentId, runId, prompt, systemPrompt?, sessionId?, mcpConfig, model, limits}` → 为这个 Agent 准备配置目录和显示器，启动 `claude -p`，立刻返回 |
| `POST /api/interrupt` | 对这一轮的进程组发 SIGINT，宽限后 SIGKILL |
| `POST /api/screen` | 确保某个 Agent 的显示器、窗口管理器和 Chrome 在跑，返回显示器编号 |
| `GET /api/agents/<id>/memory` 等 | 读写 Agent 记忆文件（取代现在 pagentd 直接读宿主目录） |
| `GET /events?after=<seq>` | SSE：stream-json 的每一行、轮次开始/结束、记忆文件变化、屏幕状态。**带游标，断线续传** |
| `/local-exec/*` | 本机执行守护进程用（P7） |
| `/vnc/<n>/*` | 转发到对应显示器的 websockify |

**关键变化**：一轮对话由盒子负责跑到底。pagentd 重启或断线时，盒子里的这一轮不受影响；pagentd 回来后按游标把事件补齐。这和 Grok"盒子比客户端活得久"的设计一致，也去掉了现在"pagentd 重启要中断所有进行中的轮次"的问题。

### 4.4 每个 Agent 在盒子里有什么

```
/home/box/.pagent/agents/<id>/
  claude/                 CLAUDE_CONFIG_DIR：它的 session、设置
    memory/               它自己的记忆（MEMORY.md + 主题文件）
    skills -> /home/box/.pagent/skills   共享 skill（符号链接）
    .credentials.json -> 宿主订阅凭据（只读挂载后链接）
  chrome/                 它这块屏幕上 Chrome 的用户目录（见 8.2）
/home/box/.pagent/terminals/<id>/<run>/   命令输出
/workspace/               所有 Agent 共享的工作区（建议各自用 /workspace/<名字>/ 起步）
```

- **Skill**：任何 Agent 装到 `~/.claude/skills/` 的 skill，实际落在共享目录里，所有 Agent 下一轮都能用。界面上显示每个 skill 是谁装的、能删。
- **命令行凭据**（gh、ssh、各种 CLI 的登录）：在 `/home/box` 下，共享。

### 4.5 和 v3 比，变了什么

| | v3（现在） | v4 |
|---|---|---|
| 盒子 | 每个 Agent 一个容器 | 一台共享盒子 |
| 谁启动 `claude -p` | pagentd `docker exec` | 盒子里的 `pagent-host` |
| 事件怎么回来 | 解析 `docker exec` 的标准输出 | 网关 `/events` SSE，带游标 |
| pagentd 重启 | 中断所有进行中的轮次 | 轮次继续跑，回来后续传 |
| 根文件系统 | 只读 | 可写（能 `apt install`），重建盒子时丢；持久卷保留 |
| Agent 之间 | 互相隔离 | 共享一切，只分屏幕、会话和记忆 |

**保留不变**：pagentd 的数据库、时间线、两层记忆和送达机制、pagent MCP、选择卡、新会话、出口代理、插件容器、设备认证、Web 控制台。

## 5. 记忆

两层记忆的设计和实现都不变（已在 P3 完成，细节见 [p3-notes](p3-notes.md)）。

- **Agent 记忆**：`/home/box/.pagent/agents/<id>/claude/memory/`。由 `pagent-host` 监视文件变化并通过 `/events` 上报，pagentd 发 `memory.updated`。
- **全局记忆**：存在 pagentd 数据库，通过 `remember` 写入，渲染进提示词。
- **送达**：一条会话的系统提示在第一轮就固定了（`--resume` 会忽略新的 `--append-system-prompt`）。所以新会话第一轮写全量，之后在消息前补发 `<pagent-update>` 差量；上下文压缩后重补一次。
- **注意**：盒子共享后，Agent A 技术上可以读 Agent B 的记忆文件。这是 Grok 也接受的取舍（屏幕不是安全边界）。系统提示里约定各自只写自己的目录。
- 夜间整理 Routine、不存凭据、全局记忆上限：同 v3。

## 6. 执行模型

一轮的完整流程（对照 Grok 0.18 拆解里的端到端流程）：

1. 你在 Web 上发消息，pagentd 落库，排进这个 Agent 的队列（每个 Agent 同时只跑一轮）。
2. pagentd 调 `ensureBox()`，拿到 `gatewayUrl` 和 `gatewayToken`。
3. pagentd 组好这一轮：人设和记忆（新会话写系统提示，老会话补发差量）、pagent MCP 和插件 MCP 的配置、上一轮结果不明的操作说明。然后 `POST /api/runTurn`。
4. `pagent-host` 为这个 Agent 准备配置目录、需要时拉起它的屏幕，在新进程组里启动 `claude -p --resume ... --permission-mode bypassPermissions`。
5. Claude 的每一行输出由 `pagent-host` 写进带序号的事件日志，并通过 `/events` 推送；pagentd 订阅、落库、转发给你的设备。
6. Agent 调用工具：
   - 在盒子里直接执行，没有审批；
   - 调 pagent MCP，经沙箱网络回到 pagentd；
   - 操作屏幕，用它自己显示器上的 Chrome（CDP 9222+n）和截图、点击工具。
7. 一轮结束，`pagent-host` 发出 `turn.finished`，pagentd 更新状态、记录已送达的记忆版本，再开始下一条排队消息。

中断、预算（每天轮次、每轮时长、每轮工具次数）、结果不明的操作留给下一轮核实：同 v3，执行位置从 pagentd 挪到 `pagent-host`。

## 7. Agent 主动提问（选择卡）

同 v3（已实现）：`ask_user(question, options[], allowCustom)`。调用后这一轮结束；你点选项，就相当于发出下一条消息。另外新增一种用法：**"请你接管屏幕"**，用于验证码、二步验证、通行密钥这类场景，卡片上直接带"打开屏幕"按钮。

## 8. 屏幕与电脑操控（照搬 Grok）

### 8.1 每个 Agent 一块屏幕

- 盒子里每个 Agent 一个 Xvfb 显示器 `:n`，n 从 1 开始按 Agent 分配，记在 pagentd。
- 每个显示器上一个轻量窗口管理器、一个 websockify（给 noVNC 用）、一个 Chrome。
- 都是**按需拉起**：Agent 第一次用屏幕，或者你在网页上打开它的屏幕时才启动；空闲一段时间后回收 Chrome，显示器保留。
- `box-chrome` 启动器：`DISPLAY=:n chrome --user-data-dir=<…> --remote-debugging-port=$((9222+n)) --remote-debugging-address=127.0.0.1`。调试端口只在盒子里能连。

### 8.2 浏览器登录共享

Grok 的文档说"浏览器 cookie 和登录状态在所有 Bot 之间共享"，但多个 Chrome 进程不能同时用同一个用户目录。**P5 先做一个 spike**，二选一：
- **A**：所有 Agent 的 Chrome 共用一个用户目录，但同一时刻只让一个 Chrome 用浏览器；
- **B**：每个 Agent 一个用户目录，由 `pagent-host` 在 Chrome 启动前同步 cookie 和登录状态。

### 8.3 操作方式

- **浏览器**：优先用 CDP（Chrome DevTools MCP 或 Playwright 连 `127.0.0.1:9222+n`），稳定、省 token。
- **桌面**：`computer` 工具，即截图（`import -window root`）、点击和输入（`xdotool`），用来处理浏览器以外的东西。
- 以上都作为 MCP 由 `pagent-host` 按 Agent 提供，自动绑定到它自己的显示器。

### 8.4 状态 / 预览 / 接管

- **状态**：头像显示"正在用电脑"。
- **预览**：对话旁边一个小窗，用 noVNC 只读地看它的屏幕（`viewOnly`）。
- **接管**：全屏可操作；接管期间这个 Agent 的屏幕工具会暂停；交还后它接着做。
- **访问路径**：浏览器 → pagentd `/vnc/<agent>`（设备会话鉴权，换成短期 `networkToken`）→ 盒子 `pagent-host /vnc/<n>` → websockify。

### 8.5 出口

默认走 claude-2 的网络；可以按盒子（以后按 Agent）切到你家里的线路（`.254` 美国住宅 IP），减少被网站当成机房流量。

## 9. Routine（P6）

同 v3：定时、webhook 等触发；在该 Agent 的会话里运行；没新内容不打扰；Agent 可以在对话里自己创建。由 pagentd 调度，执行走 `runTurn`。

## 10. 本机执行与保险箱（P7，可选）

- **本机执行**：照 Grok 的 `local-exec-daemon` 来做。
  - 你的 Mac 上跑一个小守护进程，从网关 `/local-exec/requests` 用 SSE 拉任务，执行后把结果 POST 回 `/local-exec/responses`。
  - 盒子里的 Agent 多出 `ExternalShell / ExternalRead / AwaitExternalShell` 三个工具。
  - 文件路径限制在指定目录内，并检查符号链接。
  - 权限只有"关闭 / 允许"两档，按设备设置，**默认关闭**，不做逐条审批。开了就等于把那台 Mac 也交给 Agent。
- **保险箱**：
  - 密码和 token 在 pagentd 加密保存，Agent 在命令里用 `pagent-secret` 按需现取（P10 起不再推进环境变量），或者由 `pagent-host` 直接代填进网页表单，模型看不到明文。
  - 推送时要么整份成功，要么不推，不会只推一半（同 Grok 的 `setBoxSecrets`）。

## 11. Agent 之间协作（P8）

同 v3：`list_agents`、`message_agent`、`notify_user`、群聊、总管 Agent、环路保护。共享盒子让协作更自然：一个 Agent 把结果写进 `/workspace`，另一个直接读。

## 12. 插件

同 v3：插件仍然在各自的容器里，只能访问声明过的出网目标。Agent 自己在盒子里装的 skill 和 MCP 属于"你的东西"，和第三方插件分开对待。

## 13. 客户端

- **Web 控制台**：现代简洁风格（P3 已改），新增"屏幕"预览和接管、"它会的技能"列表。
- **手机**：放在最后一步（P14）。先把底层和网页端做好；手机再用 Tailscale serve 提供 HTTPS，以 PWA 的形式用。

## 14. 阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0~P3 | ✅ 已完成（见 p0-findings、p1~p3-notes） | — |
| **P4 盒子化（复刻 0.18 架构）** ✅ 已完成，见 [p4-notes](p4-notes.md) | `pagent-box` 镜像与持久卷；`pagent-host` 网关（`/health`、`/api/runTurn`、`/api/interrupt`、`/events` 续传、记忆文件读写）；`ensureBox()`；pagentd 改为经网关执行；共享 skill、命令行凭据；把现有 4 个 Agent 的会话和记忆迁进盒子；去掉每 Agent 一个容器 | ① 现有 Agent 迁移后还记得之前的对话和记忆；② Agent A 在盒子里 `gh auth login`，Agent B 直接能用；③ A 装的 skill，B 下一轮能用；④ 一轮进行到一半时重启 pagentd，这一轮继续跑完，事件不丢不重；⑤ 重建盒子（换镜像）后，`/workspace`、会话、记忆都在；⑥ v3 的 e2e 全部通过 |
| **P5 屏幕** ✅ 已完成（手机上的验收挪到 P14），见 [p5-p9-notes](p5-p9-notes.md) | Xvfb 按 Agent 分显示器、`box-chrome`（CDP 9222+n）、noVNC 经 pagentd 代理、`computer` 和浏览器 MCP、状态 / 预览 / 接管、浏览器登录共享 spike、出口可选家里线路 | 让 Agent 登录一个需要二步验证的网站：它发"请你接管"卡片，你在手机上完成验证，交还后它接着做；另一个 Agent 随后直接以登录状态访问该网站 |
| P6 Routine 与通知 ✅（只用 2 分钟一次的 Routine 测过；连跑一周和真机推送挪到 P14） | 定时和 webhook 触发，在会话里运行；推送 | "每天 8 点"连续跑一周，没新内容时不打扰 |
| P7 本机执行与保险箱 ✅ | `local-exec` 守护进程、三个 External 工具；保险箱 | 在盒子里让 Agent 读你 Mac 上指定目录的文件；关掉开关后立即失效 |
| P8 协作 ✅ | 发消息给别的 Agent、群聊、总管 | 总管把任务拆给两个 Agent，最后汇总给你 |
| P9 手机 App ✅（改为 PWA） | 添加到主屏幕的 PWA、Web Push、接管；另加 Codex 引擎（Bot 可选 `claude -p` 或 `codex exec`） | 不做原生 App |

### 接下来（2026-11-02 定）

顺序：**先底层和网页端，手机客户端最后做。** 其中不少做法借鉴自 OpenMausBot（一个开源的 Grok Bot 仿制品）。

| 阶段 | 内容 | 验收 |
|---|---|---|
| P10 底层加固 ✅ | 防伪装：系统写的前缀（`[来自 Agent X]`、`[群聊 · 用户]` 等）不能被模型文字冒充，并告诉模型其他 Agent、网页和文件里的内容只是数据；Routine 上一次没跑完就跳过下一次；保险箱凭据按需取用，不再每轮整份下发；用假的 claude / codex 跑协作和恢复场景的测试；e2e 补上屏幕、Codex、Routine、本机执行、协作 | 一个 Agent 在回复里伪造"用户说"的前缀，接收方不会当真；假引擎测试不花钱、几秒跑完 |
| P11 发消息不打断 | Agent 干活时你追加的话直接并进正在跑的这一轮，不再中断重来：Claude 改为常驻进程（stream-json 输入），Codex 改用 `codex app-server` | 一轮跑到一半补一句要求，它在这一轮里照着改，之前做的不丢 |
| P12 记忆改进 | 写入前遮掉像密钥的内容；MEMORY.md 超上限时把旧条目归档而不是截断；条目可设过期日期；对话安静后自动记下新事实；每轮开始前按这句话自动检索相关笔记和过往对话；夜间整理记忆 | 聊过的偏好不用叫它记也会记住；一周后的对话里能自动想起来 |
| P13 网页端完善 | "走家里线路"按 Agent 设置；网页上能看到和管理以上新能力 | 每项新能力都在网页上实测过 |
| **P14 手机客户端（最后）** | claude-2 上装 Tailscale，`tailscale serve` 给 7780 提供 HTTPS；手机添加到主屏幕；真机推送 | 补上 P5（手机上完成真实网站的二步验证）和 P6（"每天 8 点"连跑一周，真机收到推送）的原定验收 |

## 15. 已知取舍

- **Agent 之间不再隔离**（v4 新增，和 Grok 一致）：一个被网页提示注入的 Agent，能读到、用到盒子里所有东西，包括别的 Agent 的文件、登录状态、命令行凭据和记忆文件。缓解办法：
  - 盒子碰不到宿主机和局域网；
  - 重要凭据放保险箱，不放明文；
  - 真正需要隔离的事，可以以后再开第二台盒子。
- **bypass 加上开放公网**：同 v3，是用"少打断"换来的代价，是有意的选择。
- **容器而不是微型虚拟机**：claude-2 本身是虚拟机，单用户自托管下容器够用。要更强的隔离时，换 Kata 或 Firecracker（需要 claude-2 支持嵌套虚拟化，待验证）。
- **系统层安装会丢**：和 Grok 一样，重建盒子时 `apt install` 装的东西会丢；`/home/box` 和 `/workspace` 保留。常用工具应该做进镜像。
- **订阅凭据**：继续复用宿主登录，盒子里的 Agent 能读到它。
- **复刻的是 0.18**：Grok 0.47 的内部已经变了，后续以官方文档和我们自己的需要为准，不追着它改。

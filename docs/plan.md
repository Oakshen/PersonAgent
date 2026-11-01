# PersonAgent 方案 v2

> v1 经 gpt-6-astra 评审，并参考 Grok Bot 官方设计文（x.ai/news/designing-grok-bot）、0.18 客户端逆向（b-nnett/grok-bot-0.18-reconstructed）、OpenClaw / Hermes / Happy Coder 的社区反馈后重写。
>
> **默认假设（未确认，可改）**：TypeScript + Node LTS；第一版只做**单用户、自有 VPS**，但数据模型按以后产品化设计；"图形化"同时指 agent 操控的远程桌面和人用的 Web 控制台。

## 1. 产品定义

一个人拥有一组常驻在自己 VPS 上的 Bot。每个 Bot 有身份、记忆、定时任务，能干活、能找别的 Bot 协作；人用手机或 Web 指挥、审批、接管。

借鉴 Grok Bot 的对象模型：

| 对象 | 含义 | 作用域 |
|---|---|---|
| **Bot** | 持久角色：persona、Driver、权限、记忆 | — |
| **Chat** | 和一个 Bot 的对话；**Group** 是多个 Bot 加人的群聊 | Bot / Group |
| **Skill** | 可复用的指令（prompt 加脚本） | 账号级共享 |
| **Tool** | MCP 能力、连接器、浏览器、桌面 | 账号级注册，按 Bot 授权 |
| **Routine** | 定时或事件触发的 Prompt | Bot 级 |
| **Memory** | 长期记忆 | Bot 级隔离 |
| **Artifact** | 文档、代码、截图等产出 | 归属于 Run |

界面原则：侧边栏是 **Bot 名单**，不是聊天历史。头像同时表示状态：空闲 / 工作中 / 等待审批 / 卡住 / 完成。跨 Bot 的协调交给一个 **Chief of Staff Bot**，用户不需要自己调度。

## 2. 三条底线（不满足就不发版）

1. **执行隔离**：daemon 掌握状态和策略；agent 跑在受限的 worker 里。agent 碰不到 daemon 的数据库、策略文件，也碰不到其他 Bot 的目录和凭据。
2. **审批是授权协议**：批准绑定到具体操作，有过期时间，只能用一次，执行前重新校验。审批进入第一条可用链路，不往后排。
3. **副作用可恢复**：会话能续上不等于任务能恢复。有副作用的操作单独记账；状态不明时标为 `unknown`，等人核对，绝不盲目重试。

## 3. 架构

```
┌──────────────────────────── VPS ─────────────────────────────┐
│ 控制面 pagentd（Node, 单进程, SQLite）                         │
│   身份/配对 · 策略引擎 · Run/Action/Approval 状态机            │
│   调度(Routine) · 消息总线(Hub) · 预算 · 事件 outbox           │
│        │ 本地 socket（带 worker 身份）                         │
│ 执行面 worker（每 Bot 一个容器 / 独立 uid）                    │
│   官方 CLI：claude / codex（用户自己登录）                     │
│   注入 MCP：hub · memory · browser · desktop（都回调控制面）    │
│   网络出口代理：域名白名单，屏蔽云元数据和内网地址              │
│ 桌面面（可选）：TigerVNC + XFCE + Chrome，每 Bot 一个 display   │
│   和独立 Chrome profile；noVNC 只经由控制面鉴权后转发           │
└───────────────────────────────────────────────────────────────┘
     ▲ Tailscale + 应用层设备认证（WebSocket 加 REST）
  CLI/TUI · Web 控制台 · 手机 App
```

要点：
- **复用现成的 agent 循环**（Claude Code / Codex），不自己写。我们只做编排、策略和状态管理。
- **MCP 只是能力入口，不是权限边界**。真正的边界由三层组成：worker 容器、出口代理、MCP 调用时控制面的策略检查。限不住的通道（比如原生 shell）通过降低 worker 权限来兜底，不在 UI 上谎称"所有危险操作都会审批"。
- 控制面要预留资源（cgroup）。worker 被 OOM 杀掉时不能连带控制面。

## 4. Driver 与订阅合规

| Driver | 首版 | 方式 | 认证 |
|---|---|---|---|
| `claude-code` | ✅ 唯一完整实现 | 在 worker 里**每轮运行一次未修改的官方 `claude -p`**（`--resume` 续上会话，stream-json 输出），审批走 PreToolUse hook，中断时杀进程组。轮中插话（steer）以后用 Agent SDK 作为可选能力补上（见 p0-findings） | 用户自己的订阅或 API Key，凭据只留在 worker 内 |
| `codex` | P4 | `codex app-server` | 同上，用来验证抽象是否成立 |
| 自写 API 循环 | 暂缓 | — | — |

- 合规原则：**我们不收集、不中转用户的订阅令牌**，只负责启动官方客户端。以后要做托管服务或商业化前，按"部署模式 × Driver × 认证方式 × 凭据持有方"重新逐项核对 Anthropic / OpenAI 的条款。
- Driver 接口要声明能力（capability 协商），不要求每个 Driver 都实现全部能力：

```ts
interface Driver {
  capabilities: { resume; interrupt; permissionHook; usage; mcp; compaction };
  start(run): AsyncIterable<DriverEvent>;   // 统一的最小事件 + 带命名空间的厂商扩展
  input(runId, msg, mode: 'queue' | 'steer');
  interrupt(runId): Promise<'requested'>;    // 真正停下以另一个事件为准
}
```
- 不支持跨 Driver 无损 resume。不允许失败后静默切换供应商。

## 5. 数据模型（独立于模型会话）

```
Bot ─┬─ Thread（Chat/Group；映射 driver session id）
     ├─ Routine
     └─ Memory
Run（一次执行：root_run_id / parent_run_id / 预算 / deadline）
 └─ Action（有副作用的操作：幂等键 / 状态）
     └─ Approval（approval_id、tool、参数摘要、目标、策略版本、过期时间、是否已用）
Artifact · Event（全局序号，outbox）
```

- Run 状态：`queued / running / waiting_approval / waiting_child / succeeded / failed / cancelled / unknown`
- 每个 Thread 只有一个写入者：CLI、Web、手机、Hub 的输入都经过同一个队列。
- 记忆分三类：用户确认的事实 / 模型推断 / 系统策略，并记录来源和时间。**模型不能通过写记忆来修改策略**。注入方式借鉴 Grok Bot 的"冻结快照"：同一个压缩周期内 system prompt 前缀逐字不变，以保持 KV cache 命中。
- 工具返回的大结果写进 workspace 文件，上下文里只放路径。

## 6. Bot 间协作（Hub MCP）

- 首版**只做异步**：`delegate(to, task) → run_id`、`send_message`、`list_agents`（只返回调用方被允许看到的 Bot）、`notify_user`。暂不做同步的 `ask`，避免互相等待造成死锁。
- 等待子任务时进入 `waiting_child`，**让出执行槽**，子任务完成后再唤醒父任务。
- 发送者身份由控制面根据 worker 的连接身份来绑定，不信任参数里传的值。
- 消息正文一律视为**不可信数据**。委派不会扩大权限：接收方即使权限更高，执行的动作也受发起方授权范围的约束，超出范围就要用户审批。
- 每个根任务都有上限：消息数、子任务数、并发数、时长、预算。
- Group 群聊：多个 Bot 加人在一个 Thread 里，各自保留自己的记忆，只共享群里的上下文；由 Chief of Staff Bot 负责路由。
- 交接物通过 Artifact 或共享目录传递（只读挂载），不共享工作记忆。

## 7. 审批

- 由策略引擎决定是 `allow / ask / deny`，决策依据包括工具、参数、目标域名或路径、Bot、发起链路。
- 审批记录绑定：`run_id、action_id、tool、规范化参数的哈希、目标资源、策略版本、expires_at、used`。
- 用户批准后，执行前要**重新校验**参数和目标状态，有变化就重新审批。多台设备同时点批准时，只有一次能成功（用 CAS）。超时、断线、重启时一律保持阻断，**绝不自动批准**。
- 结果区分三种：已阻止 / 已请求取消 / 已产生外部副作用。
- Claude Code 的接入点：`--permission-prompt-tool` 指向我们的 MCP，加上 PreToolUse hook。凡是经过它的调用都受策略管控。

## 8. 浏览器与桌面

- **优先做结构化浏览器自动化**（基于 CDP 的 browser MCP：读页面结构、点击元素、填表单）。通用桌面只作为兜底。
- 每个 Bot 有独立的 display 和 **Chrome profile**，下载目录按 Bot 隔离。登录态默认不共享（这一点比 Grok Bot 共用一台云电脑更严格）。
- 租约：一个 display 同一时间只有一个持有者，用递增的 **fencing token**，执行端拒绝旧 token 的请求；租约同时覆盖 GUI 操作和 CDP。
- 人工接管：撤销租约 → 清空动作队列 → 等确认停稳；无法取消的在途动作要显式展示出来。交还后，agent 必须重新截图，丢弃旧坐标和旧元素引用。
- 等待审批时**释放桌面**，避免长期占着屏幕。

## 9. 远程连接与事件

- 网络层走 Tailscale；应用层另做设备认证：配对码短时有效、只能用一次；设备在本地生成密钥对；支持撤销设备、轮换密钥。
- API、WebSocket、看桌面、控制桌面分别校验权限；WebSocket 校验 Origin；token 不放在 URL 里；CDP、VNC、Driver、MCP 的端口一律不对外。
- 事件带全局序号。客户端用游标续传，加上状态快照补齐。事件来自事务性 outbox，状态变更和事件写入同一个事务。慢客户端可以丢弃中间预览帧，但**终态和审批事件绝不丢**。
- Routine：明确时区、错过执行后的补跑策略、上一次未结束时是否允许重叠；webhook 要验签并去重。
- 推送只起提醒作用，审批状态以服务端为准。

## 10. 预算与资源

- 每个 Bot、每个根任务都设预算。订阅制的 Driver 算不出确切费用，就用轮次、时长、工具调用次数、截图数量来兜底。
- 委派子任务前，先从父任务的预算里**预留**一部分。
- 设磁盘水位线、日志轮转、截图保留期限、队列长度上限。
- 最低配置等压测之后再写。不再拍脑袋写 2C4G。

## 11. 插件系统（从 P1 起就是内核的一部分）

目标是建一个开发者能持续贡献的插件社区。原则有三条：**用现成标准、权限显式声明、隔离运行**。

### 11.1 插件类型

| 类型 | 标准 / 格式 | 例子 |
|---|---|---|
| **Skill** | Agent Skills（`SKILL.md` + 脚本），与 Claude Code / Codex 生态兼容 | 写周报、PR review 流程 |
| **Tool** | MCP server（stdio / HTTP） | GitHub、Notion、数据库 |
| **Connector** | 带 OAuth 的 Tool，凭据由控制面托管，插件拿不到原始 token | Gmail、飞书、Google Calendar |
| **Channel** | 消息入口适配器 | Telegram、Discord、飞书机器人 |
| **Trigger** | Routine 的事件源 | RSS、GitHub webhook、邮件到达 |
| **Bot 模板** | persona + 推荐 Skill/Tool + 默认 Routine 的打包 | "研究员""运维值班" |
| **UI 面板**（P5） | 在手机端和 Web 中声明式渲染的卡片 / 小组件 | 股票看板、日程卡片 |

**自举**：hub / memory / browser / desktop 这些内置能力本身也按插件格式实现。插件 API 我们自己天天用，才能保证好用。

### 11.2 清单（`pagent-plugin.json`）

```json
{
  "id": "dev.example.github",
  "version": "1.2.0",
  "engines": { "pagent": "^1.0" },
  "contributes": { "tools": "mcp/server.js", "skills": ["skills/*"] },
  "permissions": {
    "network": ["api.github.com"],
    "secrets": ["github.oauth"],
    "fs": "plugin-data",
    "actions": { "create_issue": "ask", "list_repos": "allow" }
  }
}
```

- 用户安装时看到权限清单，可以逐项授权，再按 Bot 启用（Tool 是账号级注册，按 Bot 授权，和第 1 节一致）。
- 插件升级时如果**权限扩大，必须重新同意**；权限不变的补丁版本可以自动更新（可在设置里关掉）。
- `actions` 给每个工具一个默认的审批级别，最终以用户策略为准，插件只能建议，不能放宽。

### 11.3 隔离运行

- 每个插件跑在自己的沙箱进程里（容器 / 独立 uid），只能访问 `permissions.network` 声明的域名（经出口代理强制执行），只能读写自己的数据目录。
- Connector 的 OAuth token 由控制面持有，插件只能请求"带凭据代发请求"，不接触 token 本身。
- 插件的输出一律视为**不可信内容**进入上下文。这是为了防"插件串联"攻击：清华的 KnotScryer 证明了，不用改插件本身，只靠插件读到的第三方内容就能把几个看起来干净的插件串起来泄密，OpenClaw、Hermes、OpenCode 都中招了。
- **禁止**安装时执行脚本。依赖必须打包在插件内或在清单里声明，不允许 README 让用户手动装"前置依赖"，ClawHavoc 就是靠这一招传播的。

### 11.4 社区与分发（P4 起）

- **Registry**：起步先用 Git 仓库索引 + 构建产物（类似 Homebrew tap），社区跑起来后再做网站。
- **发布流程**：开发者签名 → CI 静态扫描 + 权限 diff → 自动测试 → 上架。高权限插件（shell、全网络、桌面）需要人工审核。
- **信任分级**：官方 / 认证开发者 / 社区 / 本地侧载，在 UI 上明确标出。
- **安装**：锁定版本 + 哈希，可回滚；支持私有 registry 和本地目录（`pagent plugin link ./my-plugin`），方便开发调试。
- **生态兼容**：能直接导入现有的 MCP server 和 Agent Skills（自动生成一份保守的权限清单，由用户确认），开发者第一天就有存量可用。
- **开发者体验**：`pagent plugin init` 生成脚手架，本地热重载，提供测试工具包（模拟 Bot 调用并检查权限）。
- **收入分成 / 付费插件**：先不做，等社区规模起来了再说。

### 11.5 对阶段的影响

- P1：插件清单、加载器、权限模型、沙箱运行，内置能力全部用插件格式实现。
- P3：支持导入 MCP / Agent Skills；`pagent plugin init/link`。
- P4：Registry、签名、扫描、信任分级、升级时的权限 diff。
- P5：UI 面板类插件。

## 12. 技术栈与仓库

- Node LTS + TypeScript，pnpm monorepo；SQLite（WAL 模式，所有写入经由控制面）；worker 用 Docker（禁止 privileged，不挂载 docker.sock）。

```
packages/
  protocol/     事件 / API 类型（手机端共用）
  daemon/       控制面：状态机、策略、调度、Hub、outbox
  worker/       worker 入口 + Driver 适配器
  plugin-sdk/   插件清单 schema、加载器、开发工具
  plugins/      内置插件：hub / memory / browser / desktop
  cli/          pagent CLI + TUI（Ink）
  web/          Web 控制台
deploy/
  control.Dockerfile  worker.Dockerfile  desktop.Dockerfile  compose.yaml
```

## 13. 阶段

| 阶段 | 范围 | 验收 |
|---|---|---|
| **P0 前提验证** ✅ 2026-11-01（docs/p0-findings.md） | 在 worker 容器里跑官方 `claude` 并登录；验证 stream-json、resume、interrupt、permission-prompt-tool、出口代理；验证一个 MCP 插件能在独立沙箱里经代理运行 | 写出一页结论：能控住什么、控不住什么、中断和恢复各是什么表现 |
| **P1 单 Bot 闭环** ✅ 2026-11-01（docs/p1-notes.md） | daemon + CLI；Bot 增删改查；Thread 队列；Run/Action/Approval 状态机；策略引擎；预算；事件 outbox；备份；**插件清单 / 加载器 / 权限 / 沙箱，内置能力插件化** | 杀掉进程后状态能解释清楚；同一个审批不会被用两次；状态不明的副作用不会自动重试 |
| **P2 远程控制** ✅ 2026-11-01（docs/p2-notes.md；Tailscale HTTPS 待接入） | 设备配对 + 最小 Web 控制台：Bot 名单、聊天、审批、事件续传、撤销设备 | 断线重连、多设备抢着审批、过期审批、设备被撤销等场景测试通过 |
| **P3 协作 + 浏览器** | Hub 异步委派、Chief of Staff、Group 群聊；browser MCP + 每 Bot 独立 profile | 用真实任务（比如"研究 Bot 查资料 → 写作 Bot 出稿"）跑通，并记录失败率、人工介入次数和费用 |
| **P4 扩展** | Routine/webhook；Codex Driver；Skill；通用桌面 + 租约 + 接管 | 去重、补跑、配额、租约竞争测试通过 |
| **P5 手机 App** | Expo App、推送、relay（按需） | 后台通知、丢失手机后的恢复流程验证通过 |

**发版前必须通过的故障测试**：执行到一半断电、同一个 webhook 重复投递、使用过期审批、恶意网页诱导 Bot 跨 Bot 越权、人工接管时仍有在途点击、浏览器 OOM 或磁盘写满。

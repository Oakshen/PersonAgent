# PersonAgent 开发说明

给在这个仓库里写代码的 AI Agent（Claude Code、Codex 等）看的。产品介绍见 [README.md](README.md)，完整方案见 [docs/plan.md](docs/plan.md)，各阶段的实现记录见 `docs/p*-notes.md`。

## 不能违反的产品约定

- **没有任何审批**。聊天中途不能出现"允许 / 拒绝"之类要用户确认的机制。Agent 需要用户拿主意时只能发选择卡（`ask_user`）；需要用户亲手操作时发接管卡（`request_takeover`）。
- **所有 Agent 共用一个盒子**（`pagent-box`）：文件、浏览器登录、命令行凭据、skill 都共享，Agent 之间不是安全边界。盒子本身才是边界：出网走 egress 代理，私有地址一律拒绝。
- **用户可见的文字、代码注释、文档都用简体中文**。注释只写代码表达不了的东西：为什么这样做、外部行为（CLI、协议、浏览器）带来的约束、已知风险。

## 命令

运行时是 Node 24，直接跑 TypeScript（类型擦除），**没有构建步骤**。运行时零依赖，`devDependencies` 只有 typescript 和 @types/node。

```sh
npm run typecheck                                          # tsc -p .（只检查，不产出）
npm test                                                   # 全部单测：node --test packages/*/test/*.test.ts
node --test packages/daemon/test/core.test.ts              # 单个文件
node --test --test-name-pattern='协作' packages/daemon/test/core.test.ts   # 单个用例（按名字匹配）
PAGENT_E2E_BOT=tester node --test --test-timeout=560000 packages/daemon/test/remote.e2e.ts
                                                           # 端到端：对着运行中的 pagentd，会真的跑几轮模型，十几分钟
node --test --test-timeout=600000 packages/daemon/test/features.e2e.ts
                                                           # 端到端：保险箱、Routine、本机执行、屏幕、Codex、群聊协作
```

`engine.test.ts` 用假的 claude / codex（`test/fake/`，消息里写 `@@say` / `@@sh` / `@@mcp` 等指挥它）跑真的网关和 pagentd，不调模型，几秒跑完；改了轮次、协作、恢复、封套相关的代码先跑它。

`tsconfig` 开了 `erasableSyntaxOnly` 和 `allowImportingTsExtensions`：不能用 enum、namespace、构造函数参数属性；相对导入要写 `.ts` 后缀。

## 开发和部署

测试和部署都在部署机上做（目前是 claude-2，ssh 别名 `claude-2`，源码在 `~/pagent/src`，数据在 `~/pagent/data`），不在开发机上跑服务。

```sh
rsync -a --delete --exclude node_modules --exclude .git --exclude 'spikes/p0/data' ./ claude-2:pagent/src/
ssh claude-2 'cd ~/pagent/src && npx tsc -p . && ./deploy/dc.sh restart pagentd'
ssh claude-2 'docker restart pagent-box'      # 改了 packages/host（盒子里的网关）才需要；会中断盒子里正在跑的轮次
```

- 第一次部署用 `deploy/up.sh`（构建 `pagent-box` 和 `pagentd` 镜像，起 egress 和 pagentd；盒子由 pagentd 拉起）。环境变量在 `deploy/env.sh`。
- `./deploy/dc.sh` 是 `docker compose` 的包装：`logs -f pagentd`、`ps`、`restart pagentd`。
- 服务器上的命令行：`./bin/pagent …`（走 unix socket `~/pagent/run/api.sock`，不需要认证），用法见 `packages/cli/src/main.ts` 里的 `USAGE`。
- Web 控制台只监听 `127.0.0.1:7780`。浏览器只在 HTTPS 或 localhost 下提供 WebCrypto，所以从别的机器访问要用 SSH 隧道（`ssh -N -L 7780:127.0.0.1:7780 claude-2`），再用 `pagent device pair <名字>` 配对。
- 数据库是 `~/pagent/data/pagent.db`（`node:sqlite`），部署机上没有 sqlite3 命令，查库用 `node -e` 加 `DatabaseSync`。

## 架构

```
浏览器 / 手机 / CLI ──► pagentd（容器）──POST /api/runTurn──► pagent-box（常驻容器）
                         │  ▲                                  pagent-host 网关：起 claude -p / codex exec
                         │  └──────── GET /events（SSE，带游标）◄─┘  每个 Agent 一块 X11 屏幕 + Chrome
                         └─ egress 代理（盒子唯一的出网口）
```

### 包

| 包 | 作用 |
|---|---|
| `packages/daemon` | pagentd：后端。存储、调度轮次、MCP 服务、远程 API、Web 静态文件 |
| `packages/host` | 盒子里的网关（`pagent-host`），只读挂进盒子。启动 Agent 进程、管理屏幕和 Chrome、screen MCP、Codex 登录 |
| `packages/protocol` | 两边共用的类型：事件（`types.ts`）和插件清单（`plugin.ts`） |
| `packages/web` | Web 控制台（PWA）。原生 JS，没有框架和构建；严格 CSP，所有文本经 `textContent` 写入，不拼 HTML |
| `packages/cli` | `pagent` 命令行 |
| `packages/egress` | 出口代理：按来源容器放行目标，拒绝私有地址（含 fake-ip 的 DoH 复查） |
| `packages/localexec` | 跑在用户自己电脑上的本机执行守护进程 |
| `plugins/` | 示例插件；插件跑在各自的容器里，只能访问清单里声明的出网目标 |

### 一轮是怎么跑的（要读好几个文件才能看明白的部分）

1. 用户消息进 `messages` 表排队（`runner.enqueue`），`Runner.kick` 把同一个 Agent 排着的消息合成一轮。
2. runner 组装系统提示（人设 + 两层记忆 + 工作方式说明，见 `memory.ts` 的 `guideFor` / `MemSnap`）和 MCP 配置，`POST /api/runTurn` 给网关。
3. 网关在独立进程组里起 `claude -p --output-format stream-json` 或 `codex exec --json`。每个 Agent 的 `CLAUDE_CONFIG_DIR` 是 `/home/box/.pagent/agents/<id>/claude`；skill 目录、订阅凭据都是指向共享位置的链接。
4. 网关把输出写进带序号的事件日志；pagentd 的 `BoxLink`（`box.ts`）订阅 `/events?after=`，**游标和事件处理在同一个事务里提交**，所以 pagentd 重启不丢不重，盒子里的轮次也不会因此中断（`runner.recover()` 会重新挂上）。
5. `runner.onBoxEvent` 把 stream-json 翻译成我们的事件（Codex 的 JSONL 先经 `engines.ts` 的 `fromCodex` 转成同样的形状），写进 `events` 表。
6. 轮次结束：`runner.finish` 定终态，`afterRun` 处理 Routine（`NO_NEWS` 安静收尾）和协作（`collab.ts` 的 `afterRunCollab`）。

### 存储和事件

- `store.ts`：一个 SQLite 库。**表结构变化只能加列**（`migrate()` 里补列，必须带默认值），不改不删。
- `store.emit` 写 `events` 表并在**事务提交后**才广播（outbox 模式），所以事件和数据库状态一致。Web 和 CLI 都靠 `/api/events?after=<seq>` 续传。
- 新事件类型要先加到 `packages/protocol/src/types.ts` 的 `EventType`。

### Agent 能调的工具

- `mcp.ts`：pagentd 的 MCP 服务（端口 7701，按本轮的 run token 认证），工具有 `remember`、`ask_user`、`request_takeover`、`notify_user`、Routine、本机执行、保险箱、`list_agents` / `message_agent`、`new_session`。
- `packages/host/src/screen-mcp.ts`：屏幕工具（截图、点击、输入、`fill_secret`）；浏览器操作用 `playwright-mcp --cdp-endpoint` 连这个 Agent 自己的 Chrome。
- 加工具要同时改 `TOOLS` 列表和 `callTool`。

### 其他要知道的

- **两层记忆**：全局记忆（关于用户，所有 Agent 共享）在数据库里；Agent 记忆是盒子里它配置目录下的 `memory/` 文件。会话中途的变化通过带密钥的 `<pagent-update>` 补发，不改系统提示（`threads.mem_base` / `mem_delivered`）。
- **引擎**：每个 Bot 选 `claude` 或 `codex`；换引擎会开新会话。Codex 没有系统提示参数，新会话第一轮把系统提示放进 `<pagent-context>`。所有 Codex Bot 共用一个 `CODEX_HOME`（一份登录）。
- **订阅凭据**：Claude 复用宿主的 `~/.claude/.credentials.json`（单文件挂进盒子）。CLI 刷新令牌会把链接换成独立文件，网关的 `syncCred()` 以最新的一份为准写回并恢复链接。
- **消息封套**（`envelope.ts`）：消息表只存正文，来源放在 `messages.meta`；发给 Agent 时 runner 按 meta 写带安装密钥的 `<pagent-msg key from=…>` 块，正文里的 `<pagent-` 一律转义。**不要再往正文里拼 `[来自 …]` 之类的前缀**，加新的消息来源就加 meta 字段和 `render` 分支。
- **保险箱**：凭据不进环境变量。Agent 在命令里用 `$(pagent-secret 名字)` 现取（`packages/host/bin/pagent-secret` → MCP 服务的 `POST /secret`，凭本轮 run token），每次取用记 `secret.used`。
- **协作**：同一轮里 `message_agent` 托付出去的事算一批，全部有结果后合成一条消息交回发起方（`assignments` 表）。
- **远程 API**（`remote.ts`）：设备用 ECDSA 密钥配对和登录，权限分 `chat` / `admin` / `local`；只有 `local` 的设备只能访问本机执行的路由。

## Git

- 只在用户要求时提交或推送。在 `main` 上时先建分支再提交，合并用快进（`git merge --ff-only`）。
- 远端是公开仓库 `github.com/Oakshen/PersonAgent`。

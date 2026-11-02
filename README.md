# PersonAgent

一个自己托管的多 Agent 助手：在手机或网页上像聊天一样给 Agent 交代事情，它们在你家服务器上的一台"盒子"里直接把事做完。

架构参照 Grok Bot 0.18（依据 [shadown 的逆向拆解](https://shadown.github.io/blog/posts/2026-09-03_grok_bot_how-it-works/)），引擎用你已有的订阅：每个 Agent 可以选 **Claude**（`claude -p`，Claude 订阅）或 **Codex**（`codex exec`，ChatGPT 订阅）。

## 它是什么样的

- **一个 Agent = 一个身份 + 一块屏幕 + 一条连续的会话 + 它自己的记忆。** 所有 Agent 共用一台盒子：一个 Agent 留下的文件、登录好的网站、装好的工具和 skill，别的 Agent 接着就能用。
- **不打断你。** 界面上没有任何审批，Agent 在盒子里拥有全部权限，交代的事直接做完。只有它自己判断需要你拿主意时，才发一张选择卡；需要你亲手输验证码、扫码时，发一张"请你接管"卡。
- **记得事情。** 两层记忆：关于你的全局记忆（所有 Agent 共享）和每个 Agent 自己的工作记忆，都是实时写入、下一轮就生效。

## 功能

| 功能 | 说明 |
|---|---|
| 对话 | 每个 Agent 一条会话，一直延续；随时可以开新会话（记忆保留） |
| 屏幕 | 每个 Agent 一块桌面和自己的 Chrome；网页里可以看它在做什么，也可以接管操作。浏览器登录状态在 Agent 之间共享 |
| 两种引擎 | Claude Code 或 Codex CLI，按 Agent 选；Codex 在网页设置里用设备码登录 |
| Routine | 定时（cron）或 webhook 触发，在 Agent 的会话里运行；没有新内容就不打扰你 |
| 通知 | Web Push：Agent 主动通知、等你回答、请你接管时推送到手机 |
| 协作 | Agent 之间互相托付任务，结果自动交回；群聊里有总管 Agent 拆分任务、等大家做完再汇总给你 |
| 本机执行 | 在你自己的电脑上跑一个小守护进程，Agent 就能在你开放的目录里读文件、执行命令；按电脑开关，默认关闭 |
| 保险箱 | 密码和 token 加密保存；Agent 用环境变量引用，网页登录时直接代填，时间线上的值会被遮住 |
| 插件和 skill | skill 装一次所有 Agent 可用；第三方插件跑在各自的容器里，只能访问声明过的网站 |
| 客户端 | Web 控制台（PWA，可以添加到手机主屏幕）和 `pagent` 命令行 |

## 架构

```
浏览器 / 手机 / CLI ──► pagentd ──► pagent-box（常驻容器，所有 Agent 共用）
                         │           网关 pagent-host：起 claude -p / codex exec
                         │           每个 Agent 一块 X11 屏幕 + Chrome，noVNC 预览 / 接管
                         └─ egress 代理（盒子唯一的出网口，拒绝局域网和私有地址）
```

- **pagentd**（`packages/daemon`）：后端。SQLite 存储、调度每一轮、给 Agent 提供工具（MCP）、远程 API 和 Web 控制台。
- **pagent-box**（`deploy/box.Dockerfile` + `packages/host`）：一台常驻的 Linux 电脑，持久盘保留家目录和 `/workspace`。Agent 的进程跑在这里，pagentd 重启也不会中断进行中的任务。
- **盒子是安全边界，Agent 之间不是。** 盒子碰不到宿主机和你家的局域网；不想让所有 Agent 都能用的凭据或文件，就不要放进盒子。

更多设计细节见 [docs/plan.md](docs/plan.md)，各阶段的实现记录见 [docs/](docs/)。

## 部署

需要一台 Linux 服务器：Docker、Node 24，并且已经用 `claude` 登录过 Claude 订阅（盒子直接复用 `~/.claude/.credentials.json`）。

```sh
git clone https://github.com/Oakshen/PersonAgent.git ~/pagent/src
cd ~/pagent/src
./deploy/up.sh                       # 构建镜像，启动 egress 和 pagentd；盒子由 pagentd 拉起
./bin/pagent bot create 助手 --persona "你是我的个人助理，说话简洁"
```

数据默认放在 `~/pagent/data`（可用 `PAGENT_DATA` 改）。常用运维命令：

```sh
./deploy/dc.sh logs -f pagentd       # 看日志
./deploy/dc.sh restart pagentd       # 重启后端（盒子里的任务继续跑）
./bin/pagent backup                  # 备份数据库
```

### 打开 Web 控制台

pagentd 只监听服务器的 `127.0.0.1:7780`。浏览器只在 HTTPS 或 localhost 下允许生成设备密钥，所以：

- 从另一台电脑访问：开 SSH 隧道 `ssh -N -L 7780:127.0.0.1:7780 <服务器>`，再打开 http://localhost:7780 。
- 从手机访问：需要给 7780 配一个 HTTPS 入口（例如 `tailscale serve`）。

第一次打开要配对：在服务器上运行 `./bin/pagent device pair <设备名>`，把打印出的配对码填进网页（5 分钟内有效，只能用一次）。

### 本机执行（可选）

在你自己的电脑上：

```sh
# 先在服务器上：./bin/pagent device pair 我的Mac --scopes local
node packages/localexec/src/main.ts pair <服务器地址> <配对码>
node packages/localexec/src/main.ts run --root ~/要开放的目录
```

然后在网页 设置 → 本机执行 里打开这台电脑。

## 命令行

```sh
./bin/pagent bot ls                          # 所有 Agent
./bin/pagent chat 助手 "帮我查一下明天的天气"   # 发消息并等结果
./bin/pagent memory                          # 关于你的全局记忆
./bin/pagent runs 助手                        # 最近的轮次
./bin/pagent device ls                       # 已配对的设备
```

完整用法运行 `./bin/pagent` 查看。

## 开发

运行时零依赖，Node 24 直接运行 TypeScript，没有构建步骤。

```sh
npm install          # 只装 typescript 和 @types/node，用于类型检查
npm run typecheck
npm test
```

给 AI 编程助手看的开发说明在 [AGENTS.md](AGENTS.md)。

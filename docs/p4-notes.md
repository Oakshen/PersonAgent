# P4：盒子化（2026-11-01）

按方案 v4 复刻 Grok Bot 0.18 的结构：所有 Agent 共用一台常驻的"电脑"（`pagent-box`），每个 Agent 只分自己的会话、记忆（P5 再加屏幕）。

## 结构

```
pagentd ──POST /api/runTurn──▶ pagent-box（容器，常驻）
   ▲                              pagent-host（网关，盒子主进程，packages/host）
   └──── GET /events（SSE，带游标）── claude -p（每个 Agent 一个 CLAUDE_CONFIG_DIR）
```

| 部件 | 位置 | 说明 |
|---|---|---|
| 盒子镜像 | `deploy/box.Dockerfile` | node 24 + Claude Code + git / gh / python / build-essential + Chromium / Xvfb / x11vnc / noVNC（P5 用）。用户 `box`，uid 和宿主部署用户相同，可以 sudo |
| 网关 | `packages/host/src/main.ts` | 零依赖，只读挂进盒子 `/opt/pagent-host` |
| `ensureBox()` | `packages/daemon/src/box.ts` | 盒子不在、停了、规格或镜像变了就重建（镜像变了要等盒子里没有进行中的轮次）；等 `/health` 通过 |
| 事件订阅 | `BoxLink`（同上） | 游标和 boot 存在库里（`kv` 表），和事件处理在同一个事务里提交 |

持久卷（宿主 `$PAGENT_DATA/box/`）：

```
home/                     → /home/box（命令行登录、npm -g / pip --user 装的工具，全部共享）
  .pagent/agents/<id>/claude/   每个 Agent 的 CLAUDE_CONFIG_DIR：会话、memory/
       skills -> /home/box/.pagent/skills（共享）
       .credentials.json -> /opt/pagent-cred/.credentials.json（宿主订阅凭据）
  .pagent/skills/         共享 skill（~/.claude/skills 也指向这里）
workspace/                → /workspace（共享工作区，claude 的工作目录）
gateway.token             pagentd 调网关的令牌（每次新建盒子重新生成）
```

根文件系统可写（`sudo apt install` 可以用），重建盒子时丢。

## 网关

| 路由 | 作用 |
|---|---|
| `GET /health` | 版本、boot、运行时长 |
| `POST /api/runTurn` | `{agentId, runId, prompt, systemPrompt?, sessionId?, mcpConfig, model?, maxTurns, pluginDirs?, maxSeconds}`：准备配置目录，在新进程组里启动 `claude -p … --permission-mode bypassPermissions`，立刻返回 |
| `POST /api/interrupt` | 整组 SIGINT，宽限 8 秒后 SIGKILL（计时在网关，pagentd 重启也不影响） |
| `GET /api/runs` | 这次启动以来的轮次（pagentd 重启对账用） |
| `GET /events?after=&boot=` | SSE：`turn.started` / `turn.line`（stream-json 的每一行）/ `turn.timeout` / `turn.finished`。boot 不同就从头发 |
| `POST /api/ack` | pagentd 确认处理到哪了，之前的事件从内存删掉 |

单轮时长上限也由网关计时（`turn.timeout`），不再依赖 pagentd 活着。

## pagentd 这边变了什么

- `runner.ts` 不再 `docker exec`：组好这一轮后 `POST /api/runTurn`，输出经 `BoxLink → Runner.onBoxEvent` 回来。
- claude 最后那条 `result` 一到就写进 `runs.final`，所以 pagentd 在 result 和进程退出之间重启也不丢。
- **pagentd 退出不再中断进行中的轮次**。重启时 `recover()` 问网关 `/api/runs`：还在的重新挂上，事件按游标补齐；不在的（盒子重启过）记为中断，结果不明的操作照旧留给下一轮核实。
- 盒子重启（boot 变了）时，交给旧盒子的轮次记为"盒子重启了，这一轮没有跑完"。
- Agent 记忆在宿主上是 `$PAGENT_DATA/box/home/.pagent/agents/<id>/claude/memory/`，pagentd 和盒子同机共享这个卷，面板读写、每轮扫描都直接读文件。方案里网关的"记忆文件读写"接口留到盒子跨机部署时再加。

## 工作方式说明也纳入送达

系统提示里"你的记忆 / 沟通方式 / 这台电脑"三段现在合称工作方式说明（`guideFor(name, memDir)`），也存进会话的记忆快照（`MemSnap.guide`）。说明变了（比如搬进盒子后记忆目录从 `~/.claude/memory/` 换到 `$CLAUDE_CONFIG_DIR/memory/`），老会话下一轮会在 `<pagent-update>` 里收到整段新说明。P4 之前的快照没有 `guide`，迁移后的第一轮都会收到一次。

新增的"这台电脑"一段告诉 Agent：它叫什么、`/workspace/<名字>/` 放自己的东西、命令行登录和 skill 共享、只改自己的记忆目录、apt 装的东西重建会丢。

## 迁移

`deploy/migrate-p4.sh`（先停 pagentd，可重复执行）：

1. `bots/<id>/home/.claude` 复制到 `box/home/.pagent/agents/<id>/claude`，去掉旧的凭据挂载点；
2. 自己装的 skill 并进共享目录（股票研究的 5 个）；
3. `projects/-work` 改名 `projects/-workspace`（claude 按工作目录找会话，`--resume` 才接得上）；
4. 删掉 `pagent-bot-*` 容器和它们的出口规则。

旧的 `$PAGENT_DATA/bots` 原样留作备份。

## 已验证（claude-2）

| 验收项 | 方式 | 结果 |
|---|---|---|
| ① 迁移后还记得之前的对话和记忆 | 运维值班答出暗号"青松"，`run.init` 的 session id 和迁移前相同；helper 答出上一条消息"盒子你好" | ✅ |
| ② A 登录过的命令行工具 B 直接能用 | tester 设 `git config --global` 和 `gh config`，helper 读出同样的值（`gh auth login` 需要真实 token，同在 `~/.config/gh` 下） | ✅ |
| ③ A 装的 skill，B 下一轮能用 | tester 写 `~/.claude/skills/box-greeting`，helper 下一轮调用 `Skill box-greeting` | ✅ |
| ④ 一轮进行中重启 pagentd | `sleep 40` 那一轮中途 `dc.sh restart pagentd`：`recover: 1 个轮次在盒子里继续`，这一轮 succeeded，事件序号连续、没有重复 | ✅ |
| ⑤ 重建盒子后数据都在 | `docker rm -f pagent-box` 后下一轮自动重建；换镜像（加一层 label）后空闲时自动换新盒子；`/workspace` 文件、`/home/box` 配置、会话都在 | ✅ |
| ⑥ v3 的 e2e | `PAGENT_E2E_BOT=tester node --test packages/daemon/test/remote.e2e.ts`（配对、签名、权限、跨站、全流程含打断和选择卡） | ✅ 5/5 |

单元测试 16/16。

## 已知取舍

- Agent 之间不再隔离：同一个用户、同一个文件系统，A 能读 B 的记忆文件、能结束 B 的进程，甚至能停掉网关（盒子会自动重启，进行中的轮次记为中断）。和 Grok 一样，屏幕和目录只是分工，不是安全边界。
- 盒子里的 `box` 用户能 sudo，容器保留 Docker 默认的 capability（不再 `cap-drop ALL`、`read-only`）。出网仍然只能经 egress 代理，局域网照旧挡住。
- 网关令牌在盒子里的进程环境里可见（同一用户）。它防的是沙箱网络里的插件容器，不是盒子里的 Agent。

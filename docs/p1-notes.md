# P1：单 Bot 闭环 + 插件系统（2026-11-01 完成）

部署在 fnos 的 claude-2（`~/pagent/src`，数据在 `~/pagent/data`），复用宿主已登录的 claude 订阅。

## 结构

```
CLI (bin/pagent) ──unix socket──► pagentd（容器，SQLite）
                                   ├─ API：/bots /runs /approvals /plugins /events(SSE) /backup
                                   ├─ hook server :7701（只在 sandbox 网络）
                                   └─ docker.sock → 按需创建容器
pagent-bot-<id>（每个 Bot 一个 worker）   每轮 docker exec 一次 `claude -p --resume`
pagent-plg-<id>（每个 MCP 插件一个）      worker 走内网直连，不经代理
egress（出口代理）                        按来源容器套白名单，规则文件由 pagentd 写入
```

| 模块 | 文件 |
|---|---|
| 存储 + 事件 outbox | `packages/daemon/src/store.ts` |
| 策略 | `policy.ts`（Bot 规则 → 插件规则 → 默认规则，第一条命中的生效） |
| 审批 | `approvals.ts`（单次 CAS、过期、整轮取消） |
| hook 处理 | `hooks.ts` + `worker-assets/hook.mjs`、`managed-settings.json` |
| 调度 / 执行 / 对账 | `runner.ts`、`docker.ts` |
| 插件 | `plugins.ts`、`packages/protocol/src/plugin.ts`、示例 `plugins/` |
| 部署 | `deploy/`（`up.sh` 启动，`dc.sh` 包装 compose） |

## 用法

```bash
cd ~/pagent/src && ./deploy/up.sh                 # 启动 / 更新
./bin/pagent bot create helper --persona "…"
./bin/pagent chat helper "你好"                   # 终端里遇到审批会直接问 y/N
./bin/pagent approvals / approve <id> / deny <id>
./bin/pagent interrupt <runId>
./bin/pagent bot set helper --daily-turns 300 --max-seconds 1800 --max-actions 100
./bin/pagent plugin install plugins/web-fetch && ./bin/pagent plugin enable helper dev.pagent.web-fetch
./bin/pagent events -f                            # 实时事件流
./bin/pagent backup
```

## 已验证（全部在 claude-2 实测）

| 场景 | 结果 |
|---|---|
| 对话 + 跨轮 resume | ✅ |
| Bash 默认需要审批；批准后执行；同一审批再次批准返回 409 | ✅ |
| 用户拒绝；写 /work 以外的路径、后台运行由策略直接拒绝 | ✅ |
| **agent 关不掉 hook**：在用户配置和项目配置里写入 `disableAllHooks` + `bypassPermissions` 后，审批照常触发 | ✅（hook 放在只读 managed settings 里） |
| 中断执行中的命令：1 秒内停下、无残留进程、副作用没有发生；该 Action 记为 **unknown** | ✅ |
| **SIGKILL pagentd**：worker 里的命令继续跑；pagentd 重启后对账，Run 和 Action 记 unknown，并清理残留进程 | ✅ |
| 单元测试：策略、outbox 提交 / 回滚、审批 CAS / 过期 / 取消、清单校验、权限比较 | ✅ 10/10 |
| Skill 插件经 `--plugin-dir` 加载并生效 | ✅ |
| MCP 插件：`allowed_hosts` 按清单自动放行、`fetch` 走审批；插件出网只能去声明的站点 | ✅ |
| 清单含 `scripts` 字段 → 拒绝安装；非 TTY 启用插件不加 `--yes` → 取消 | ✅ |
| 插件升级后权限扩大 → 该 Bot 停止加载并发出 `plugin.needs_consent` 事件，重新同意后恢复 | ✅ |
| 单轮工具调用上限 / 单轮超时（超时后在途命令记 unknown）/ 每日轮次预算 | ✅ |
| worker 内存耗尽：cgroup 只杀掉耗内存的进程，worker、pagentd、egress 都不受影响，下一轮正常 | ✅ |
| egress 停掉：worker 完全出不了网，那一轮超时中断；egress 恢复后正常 | ✅ fail-closed |
| 旧数据库自动加列迁移；`VACUUM INTO` 备份 | ✅ |

## 测试中发现并已修复

1. 中断时 claude 会给在途工具回一条"用户拒绝"，导致 Action 被记成 failed。实际上命令已经开始执行，现在对有副作用的工具改记 unknown。
2. 过期审批被"批准"时返回值有误，现在返回 `ok:false, current:'expired'`。
3. `Skill` 工具没在默认放行规则里，导致 Skill 插件一用就卡在审批。现在归为只读、默认放行。
4. API 层拒绝（例如模型的安全机制拦下了请求）时，Run 的 error 是空的，现在会记录拒绝原因。

## 已知缺口（按计划在后续阶段处理）

- **hook token 在 worker 的环境变量里**，agent 能读到，可以伪造 pre-hook 请求。后果只是多出一些 Action 记录和审批请求，没法批准任何东西。之后加限流，或改成由 pagentd 侧按容器身份认证。
- **订阅凭据**与宿主共用，agent 能读到（P0 发现 8）。出口白名单只放行 Anthropic 域名作为缓解。
- **unknown 的 Action 还不能标记"已核对"**。P2 的 Web 控制台加一个"核对"操作。
- 插件：还没有 OAuth / secrets（Connector 类插件）、registry、签名和扫描（P4）。同一个插件容器由所有 Bot 共用。所有已安装插件的 skills 文件以只读方式对每个 worker 可见。
- 每日预算按 UTC 切日。磁盘写满的场景还没测。
- worker 镜像固定 claude-code 2.1.312，升级前要跑一遍上表做回归。
- 远程访问 / 设备认证 / 手机端：P2。

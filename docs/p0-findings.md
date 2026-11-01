# P0 结论：用官方 claude CLI 作 worker 是否可控

测试日期 2026-11-01。代码见 `spikes/p0/`。两轮环境：

1. **网关模式**：本机 Lima Ubuntu VM（aarch64）+ Docker 29.9 + claude-code 2.1.263，模型经用户自建网关。测试完 VM 已删除。
2. **订阅模式**：fnos 上的 claude-2 VM（x86_64，Ubuntu 24.04，4 GB）+ Docker 29.9.2 + claude-code 2.1.312，复用宿主上已登录的 claude.ai 订阅（模型 claude-opus-5-5）。部署在 `claude-2:~/pagent-p0`，启动命令 `sudo docker compose -f compose.yaml -f compose.hostcred.yaml up -d`。

## 一页结论

**可行。** 用 stream-json 双向协议驱动未修改的官方 CLI，对话、权限、中断、恢复、插件都能由控制面掌控。配合容器、出口代理和凭据注入，能把 agent 关在明确的边界里。

| 项 | 结果 | 结论 |
|---|---|---|
| 协议 | `-p --input-format stream-json --output-format stream-json --verbose`，先发 `control_request{subtype:initialize}` | ✅ 能拿到 init（session_id、工具、MCP 状态）、逐条消息和 result（轮数、费用） |
| 权限回调 | `--permission-prompt-tool stdio` → CLI 发 `control_request{subtype:can_use_tool, tool_name, input}`；回 `{behavior:allow, updatedInput}` 或 `{behavior:deny, message}` | ✅ 每次工具调用都会先问控制面；拒绝后模型能看到原因。审批、策略引擎都接在这里 |
| 中断 | `control_request{subtype:interrupt}` | ⚠️ 前台任务：约 0.1 秒内停下，Bash 子进程被杀，副作用没有发生。**后台任务拦不住**，见发现 10 |
| resume | `--resume <id>` | ✅ 换 cwd 也能续上；会话文件在 `CLAUDE_CONFIG_DIR/projects/` |
| MCP 插件 | 插件在独立容器里作为 HTTP MCP 运行，worker 用 `--mcp-config … --strict-mcp-config` 接入 | ✅ 工具名为 `mcp__<server>__<tool>`，同样走 can_use_tool；插件自己的出网由独立白名单控制 |
| 出口控制 | worker 只接入 `internal` 网络，`HTTPS_PROXY` 指向 egress；egress 按来源容器套用白名单 | ✅ 白名单外的域名返回 403；绕过代理时连 DNS 都解析不了；169.254.169.254、内网 SSH 都被拒 |
| 文件和进程 | uid 10001、`cap_drop: ALL`、`no-new-privileges`、根文件系统只读，只有 `/work` 和 home 可写 | ✅ 写 `/usr` 失败，所有 capability 为 0 |
| 凭据（网关） | worker 只拿占位 token，egress 对模型网关注入真 token | ✅ agent 跑 `env` 只能看到占位符，对话照常 |
| 凭据（订阅） | 把宿主的 `~/.claude/.credentials.json` 挂进 worker，worker 用宿主 uid 运行 | ✅ 对话、resume、权限、MCP 全部正常；出口只放行 `api.anthropic.com` 就够用 |
| 两种模式 | 网关 / 订阅 | ✅ 两种模式下所有结论一致（中断除外，见发现 10） |

## 必须写进设计的发现

1. **启动 CLI 时用白名单环境变量。** 从宿主（例如桌面 App）继承的 `CLAUDE_CODE_*` 变量会改变 CLI 的认证行为（报"Not logged in"）。
2. **每个 Bot 独立设置 `CLAUDE_CONFIG_DIR`，并加 `--strict-mcp-config`。** 不这样做会读到宿主用户的 skills、hooks、MCP，会话也会写进宿主的 `~/.claude`。
3. **Bash 一旦放行就等于放行一切。** can_use_tool 只能看到完整的命令字符串。策略要么解析命令（脆弱），要么默认让 Bash 走审批，并靠容器边界兜底。这正好说明底线 1（执行隔离）是必需的，不是可选项。
4. **模型"自觉不绕过"不能当成防线。** 测试里模型被拒后主动表示不会换成 Bash 去绕，这只是它的态度，不是控制。
5. **worker 容器要有 init 进程**（`init: true`），否则被中断的子进程会变成僵尸进程。
6. **CLI 会尝试连 `api.anthropic.com`**（遥测和非必要流量）。拦掉不影响使用。用订阅登录时需要放行 Anthropic 的认证和 API 域名。
7. **费用字段不可信**：经网关调用时模型名不认识，`total_cost_usd` 是估算值。预算要以轮次和 token 为准，不能看美元数。
8. **凭据注入只对 API Key 或网关模式有效。** 用 claude.ai 订阅登录时，OAuth 凭据存在 `CLAUDE_CONFIG_DIR` 里，Bash 和 CLI 是同一个 uid，agent 能读到。缓解办法：出口白名单只放行 Anthropic 的域名，让凭据即使被读到也传不出去；产品上要明确告诉用户这一点。
9. **插件的出网错误不透明**：被拦截时插件看到的是 `Request was cancelled`。插件 SDK 应该把代理返回的 403 转成明确的"权限不足：未声明的域名"。

10. **中断管不到后台任务，CLI 还会自己开新一轮对话。** 2.1.312 下，模型把 `sleep 40` 用 `run_in_background` 放到后台跑，这一轮立刻返回 result。之后发的中断没有效果，后台命令照样跑完、写出了文件。更关键的是：stdin 已经关了，CLI 收到后台任务完成的通知后，**自己又跑了一轮对话**。设计上的结论：
    - 收到 result 不代表 Run 结束。还有后台任务没跑完时，Run 要保持 `running`。
    - 中断要分级：先发 `interrupt`；再停掉所有后台任务；最后对整个进程组发 SIGTERM，必要时 SIGKILL。worker 容器本身就是最后一道边界，停掉容器能保证一切都停。
    - 默认可以禁用 `run_in_background`，或者让它也走审批。
11. **订阅账号会自动带入 claude.ai connector**（这次是 "Claude Docs"，经 `mcp-proxy.anthropic.com` 连接）。加 `--strict-mcp-config` 能屏蔽掉。Bot 必须一直带着这个参数，账号级的 connector 要作为插件显式授权后才能用。
12. **出口代理是单点。** 我们写的代理在拒绝连接后，客户端重置连接，代理因 `ECONNRESET` 崩溃退出。好在它是 fail-closed：代理挂了，worker 就完全出不了网，不会因此漏出流量。已经修复，并加了 `restart: unless-stopped`。产品里代理要有监控、健康检查和崩溃测试。
13. **CLI 的遥测还会连 Datadog**（`http-intake.logs.us5.datadoghq.com`），被拦下，不影响使用。
14. **2.1.312 默认延迟加载 MCP 工具**：模型要先调 ToolSearch 拿到 `tool_reference` 才能调用。行为和 2.1.263 不一样。适配器要跟着 CLI 版本做回归测试，worker 镜像要固定 CLI 版本。

## 还没验证（进 P1 或部署后再做）

- 订阅 token 过期后的自动刷新。两边共用一个文件，测试期间凭据文件的 inode 没变（292498），但这段时间里没有发生刷新，所以"刷新时是原地写文件、两边都能看到"这一点还没测到。
- 让每个 Bot 单独登录、各自持有凭据。这次是共用宿主的凭据。
- 长会话的上下文压缩、`--include-partial-messages` 流式输出、多个 Bot 并发时的资源占用。
- Codex app-server 的同类验证（P4）。

## 补充：直接用 `claude -p` 行不行？（2026-11-01 在 claude-2 实测）

做法：每条消息起一个进程，`claude -p --output-format json|stream-json --resume <id> --settings <hooks>`。审批走 PreToolUse hook，中断靠发信号，续跑靠 `--resume`。脚本见 `spikes/p0/hooks/`。

| 能力 | `claude -p` + hooks | 结果 |
|---|---|---|
| 策略 / 审批 | PreToolUse hook 返回 `permissionDecision: allow/deny`；hook 内部可以阻塞等待审批（`timeout` 可设到 600 秒） | ✅ hook 阻塞 5 秒后放行 Bash；Write 被拒并记入 result 的 `permission_denials`；hook 能拿到 session_id 和完整的工具输入 |
| 中断 | 对进程组发 `kill -INT -<pgid>` | ✅ 1 秒内退出，Bash 子进程（它自己单独一个进程组）被一起清理，副作用没有发生。⚠️ **退出码是 0**，`stop_reason: tool_use`，所以"是否被中断"只能由控制面自己记录 |
| 续跑 | `--resume <id>` | ✅ 中断后续跑，上下文完整 |
| 实时输出 | `--output-format stream-json --verbose --include-partial-messages` | 输出协议和双向模式一样（P0 前面已验证） |
| 轮中插话 | — | ❌ 做不到。只能排队等这一轮结束，或者中断后带上新消息 resume |

另外：2.1.312 会自行拦截前台长时间的 `sleep`，并提示模型"环境不允许"。测长任务要换别的命令。

### 三种接入方式对比

| | A. `claude -p` + hooks | B. 官方 Agent SDK | C. 手写 stdio 控制协议（P0 前半段的做法） |
|---|---|---|---|
| 依赖的接口 | CLI 参数、hooks、输出格式，都是**公开文档写明的** | 官方 SDK，受支持 | SDK 内部协议，**没有文档**，随版本可能变 |
| 进程模型 | 一轮一个进程，**worker 无状态** | 长驻进程 | 长驻进程 |
| 崩溃恢复 | 很简单：重跑这一轮，或者 resume | 要处理长驻进程的状态 | 同 B |
| 审批 | PreToolUse hook | `canUseTool` 回调 | `can_use_tool` |
| 中断 | 发信号（一刀切） | `interrupt()`，比较细 | 同 B |
| 轮中插话 | ❌ | ✅ | ✅ |
| 每轮开销 | 启动约 1 秒，hooks/MCP 每轮重新加载 | 低 | 低 |
| 合规（订阅） | **最清楚**：就是用户在自己机器上无头跑 Claude Code | 第三方产品用订阅登录的条款要逐条核对 | 同 B |

### 结论：可以，而且建议 v1 默认就用 A

- `claude -p` 加 hooks 能满足三条底线：审批在 hook 里阻塞等待；中断靠杀进程组，容器作兜底；每一轮都是一个可以重放的独立单元，崩溃后恢复最简单。
- 用到的全是公开接口，跟着 CLI 升级比较稳。这一点正好对上本文发现 14：这次两个版本之间行为就有变化。
- 唯一的硬缺口是**轮中插话**。v1 的处理是：消息排队；用户点"打断"时，先中断，再把新消息带上 resume。以后在 Driver 能力协商里加一个 `steer` 能力，用 B 来实现。C 只在 spike 里用，不进产品。
- 插件 MCP 本来就跑在独立容器里，以 HTTP 方式提供服务，所以"每轮重新加载"只是重新连一次，插件的状态不会丢。
- hook 每次调用工具都要启动一个进程。产品里改用 HTTP 类型的 hook，或者一个很小的二进制，直接请求控制面。

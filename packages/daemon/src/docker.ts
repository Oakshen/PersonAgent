// worker 容器管理：每个 Bot 一个常驻容器，每轮对话 docker exec 一次 claude -p。
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { type PluginManifest, mcpServerName } from '../../protocol/src/plugin.ts';

const pexec = promisify(execFile);

async function docker(args: string[]): Promise<string> {
  const { stdout } = await pexec('docker', args, { maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

export const containerName = (botId: string) => `pagent-${botId.replace('_', '-')}`;

// worker 容器的规格版本：挂载、环境变量等变了就加一，旧容器会被自动重建（状态都在挂载目录里，容器可丢弃）
const WORKER_SPEC = '2';

/** 按容器名写出口白名单；egress 代理会定时重读这个文件。原子替换，避免读到半个文件。 */
export function allowEgress(name: string, targets: string[]): void {
  let rules: Record<string, string[]> = {};
  try { rules = JSON.parse(readFileSync(config.egressRulesFile, 'utf8')); } catch {}
  rules[name] = targets;
  const tmp = `${config.egressRulesFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(rules, null, 2));
  renameSync(tmp, config.egressRulesFile);
}

export async function ensureWorker(botId: string): Promise<string> {
  const name = containerName(botId);
  const info = await docker(['inspect', '-f', '{{.State.Running}} {{index .Config.Labels "pagent.spec"}}', name]).catch(() => null);
  if (info) {
    const [running, spec] = info.split(' ');
    if (spec === WORKER_SPEC) {
      if (running !== 'true') await docker(['start', name]);
      return name;
    }
    await docker(['rm', '-f', name]);
  }
  const base = join(config.dataDir, 'bots', botId);
  mkdirSync(join(base, 'home', '.claude'), { recursive: true });
  mkdirSync(join(base, 'work'), { recursive: true });
  mkdirSync(join(config.dataDir, 'plugins'), { recursive: true });
  allowEgress(name, config.workerAllow);
  await docker([
    'run', '-d', '--name', name, '--hostname', name, '--network', config.sandboxNet,
    '--init', '--read-only', '--tmpfs', '/tmp', '--user', config.workerUser,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '256', '--memory', config.workerMemory, '--cpus', '2',
    '-v', `${base}/home:/home/agent`,
    '-v', `${base}/work:/work`,
    '-v', `${config.assetsDir}:/opt/pagent:ro`,
    '-v', `${join(config.dataDir, 'plugins')}:/opt/pagent-plugins:ro`,
    // 策略 hook 放在 managed settings：只读、优先级最高，agent 改不了自己的配置来关掉它
    '-v', `${config.assetsDir}/managed-settings.json:/etc/claude-code/managed-settings.json:ro`,
    ...(config.hostCred ? ['-v', `${config.hostCred}:/home/agent/.claude/.credentials.json`] : []),
    '-e', 'HOME=/home/agent',
    '-e', 'CLAUDE_CONFIG_DIR=/home/agent/.claude',
    '-e', 'HTTPS_PROXY=http://egress:3128',
    '-e', 'HTTP_PROXY=http://egress:3128',
    '-e', `NO_PROXY=${config.hookHost},.plugin`,   // MCP 插件走内网直连，不经出口代理
    '-e', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    '--label', `pagent.bot=${botId}`,
    '--label', `pagent.spec=${WORKER_SPEC}`,
    '-w', '/work',
    config.workerImage, 'sleep', 'infinity',
  ]);
  return name;
}

/** 在 worker 里跑一轮。turn.sh 用 setsid 建新进程组并把 pgid 写到 /tmp，供中断时整组发信号。 */
export function execTurn(
  container: string, runId: string, env: Record<string, string>, claudeArgs: string[], prompt: string,
): ChildProcessWithoutNullStreams {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const child = spawn('docker', ['exec', '-i', ...envArgs, container, '/opt/pagent/turn.sh', runId, 'claude', ...claudeArgs]);
  child.stdin.end(prompt);
  return child;
}

/** 先 SIGINT 整个进程组，宽限期后仍在则 SIGKILL。返回取消 SIGKILL 的函数（这一轮正常结束时调用）。 */
export function interruptTurn(container: string, runId: string, graceMs = 8000): () => void {
  const pg = `$(cat /tmp/pagent-run-${runId}.pid 2>/dev/null)`;
  docker(['exec', container, 'sh', '-c', `p=${pg}; [ -n "$p" ] && kill -INT -"$p"`]).catch(() => {});
  const t = setTimeout(() => {
    docker(['exec', container, 'sh', '-c', `p=${pg}; [ -n "$p" ] && kill -0 -"$p" 2>/dev/null && kill -KILL -"$p"`]).catch(() => {});
  }, graceMs);
  return () => clearTimeout(t);
}

/** MCP 插件在沙箱网络里的主机名（worker 的 NO_PROXY 含 .plugin，直连不过代理） */
export const pluginHost = (pluginId: string) => `${mcpServerName(pluginId)}.plugin`;
const pluginContainer = (pluginId: string) => `pagent-plg-${mcpServerName(pluginId)}`;

const RUNTIME_IMAGES: Record<string, string> = { node: 'node:24-slim' };

/** 插件容器：只读挂载插件包，独立 uid、无 capability；出网只放行清单 permissions.network 声明的目标。
 *  插件内容哈希写在 label 上，重装 / 升级后自动重建。 */
export async function ensurePluginContainer(m: PluginManifest, dir: string, hash: string): Promise<void> {
  const name = pluginContainer(m.id);
  const label = hash.slice(0, 16);
  const info = await docker(['inspect', '-f', '{{.State.Running}} {{index .Config.Labels "pagent.hash"}}', name]).catch(() => null);
  allowEgress(name, m.permissions.network ?? []);
  if (info) {
    const [running, h] = info.split(' ');
    if (h === label) {
      if (running !== 'true') await docker(['start', name]);
      return;
    }
    await docker(['rm', '-f', name]);
  }
  const mcp = m.contributes.mcp!;
  await docker([
    'run', '-d', '--name', name, '--network', config.sandboxNet, '--network-alias', pluginHost(m.id),
    '--restart', 'unless-stopped', '--init', '--read-only', '--tmpfs', '/tmp', '--user', '10002:10002',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '256m', '--cpus', '0.5',
    '-v', `${dir}/pkg:/plugin:ro`, '-w', '/plugin',
    '-e', 'HTTPS_PROXY=http://egress:3128', '-e', 'HTTP_PROXY=http://egress:3128', '-e', 'NODE_USE_ENV_PROXY=1',
    '-e', `PORT=${mcp.port ?? 8080}`,
    '--label', `pagent.plugin=${m.id}`, '--label', `pagent.hash=${label}`,
    RUNTIME_IMAGES[mcp.runtime], 'node', mcp.entry,
  ]);
}

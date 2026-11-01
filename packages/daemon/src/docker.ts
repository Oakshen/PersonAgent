// worker 容器管理：每个 Bot 一个常驻容器，每轮对话 docker exec 一次 claude -p。
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';

const pexec = promisify(execFile);

async function docker(args: string[]): Promise<string> {
  const { stdout } = await pexec('docker', args, { maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

export const containerName = (botId: string) => `pagent-${botId.replace('_', '-')}`;

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
  const running = await docker(['inspect', '-f', '{{.State.Running}}', name]).catch(() => null);
  if (running === 'true') return name;
  if (running === 'false') {
    await docker(['start', name]);
    return name;
  }
  const base = join(config.dataDir, 'bots', botId);
  mkdirSync(join(base, 'home', '.claude'), { recursive: true });
  mkdirSync(join(base, 'work'), { recursive: true });
  allowEgress(name, config.workerAllow);
  await docker([
    'run', '-d', '--name', name, '--hostname', name, '--network', config.sandboxNet,
    '--init', '--read-only', '--tmpfs', '/tmp', '--user', config.workerUser,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '256', '--memory', config.workerMemory, '--cpus', '2',
    '-v', `${base}/home:/home/agent`,
    '-v', `${base}/work:/work`,
    '-v', `${config.assetsDir}:/opt/pagent:ro`,
    // 策略 hook 放在 managed settings：只读、优先级最高，agent 改不了自己的配置来关掉它
    '-v', `${config.assetsDir}/managed-settings.json:/etc/claude-code/managed-settings.json:ro`,
    ...(config.hostCred ? ['-v', `${config.hostCred}:/home/agent/.claude/.credentials.json`] : []),
    '-e', 'HOME=/home/agent',
    '-e', 'CLAUDE_CONFIG_DIR=/home/agent/.claude',
    '-e', 'HTTPS_PROXY=http://egress:3128',
    '-e', 'HTTP_PROXY=http://egress:3128',
    '-e', `NO_PROXY=${config.hookHost}`,
    '-e', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    '--label', `pagent.bot=${botId}`,
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

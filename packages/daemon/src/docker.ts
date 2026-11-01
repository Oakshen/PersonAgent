// docker 操作：出口白名单、插件容器。盒子本身见 box.ts。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { config } from './config.ts';
import { type PluginManifest, mcpServerName } from '../../protocol/src/plugin.ts';

const pexec = promisify(execFile);

export async function docker(args: string[]): Promise<string> {
  const { stdout } = await pexec('docker', args, { maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

/** 按容器名写出口白名单；egress 代理会定时重读这个文件。原子替换，避免读到半个文件。 */
export function allowEgress(name: string, targets: string[]): void {
  let rules: Record<string, string[]> = {};
  try { rules = JSON.parse(readFileSync(config.egressRulesFile, 'utf8')); } catch {}
  rules[name] = targets;
  const tmp = `${config.egressRulesFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(rules, null, 2));
  renameSync(tmp, config.egressRulesFile);
}

/** MCP 插件在沙箱网络里的主机名（盒子的 NO_PROXY 含 .plugin，直连不过代理） */
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

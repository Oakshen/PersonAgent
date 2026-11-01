// 插件：安装（校验 + 复制 + 生成只含 skills 的 Claude Code 插件目录）、按 Bot 授权、运行时装配。
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { type Store, now } from './store.ts';
import { config } from './config.ts';
import { ensurePluginContainer, pluginHost } from './docker.ts';
import {
  type PluginManifest, canonicalPermissions, mcpServerName, validateManifest,
} from '../../protocol/src/plugin.ts';

export interface PluginRow { id: string; version: string; manifest: string; dir: string; hash: string; installed_at: string }
export interface BotPluginRow { bot_id: string; plugin_id: string; granted: string; enabled_at: string }

export class PluginError extends Error {}

const pluginsRoot = () => join(config.dataDir, 'plugins');

/** 插件目录内容哈希：锁定安装的确切内容，便于审计和回滚 */
function hashDir(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else h.update(relative(dir, p)).update('\0').update(readFileSync(p)).update('\0');
    }
  };
  walk(dir);
  return h.digest('hex');
}

export function readManifest(dir: string): PluginManifest {
  const file = join(dir, 'pagent-plugin.json');
  if (!existsSync(file)) throw new PluginError(`${dir} 里没有 pagent-plugin.json`);
  let m: unknown;
  try { m = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new PluginError(`清单不是合法 JSON：${(e as Error).message}`); }
  const errs = validateManifest(m);
  if (errs.length) throw new PluginError(`清单校验失败：\n- ${errs.join('\n- ')}`);
  return m as PluginManifest;
}

export function install(store: Store, srcDir: string): PluginRow {
  const src = resolve(srcDir);
  const m = readManifest(src);
  for (const s of m.contributes.skills ?? []) {
    if (!existsSync(join(src, s, 'SKILL.md'))) throw new PluginError(`skills 目录 ${s} 里没有 SKILL.md`);
  }
  if (m.contributes.mcp && !existsSync(join(src, m.contributes.mcp.entry))) throw new PluginError(`找不到 mcp.entry：${m.contributes.mcp.entry}`);

  const dest = join(pluginsRoot(), m.id, m.version);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(src, join(dest, 'pkg'), { recursive: true, dereference: false, verbatimSymlinks: true });
  const hash = hashDir(join(dest, 'pkg'));

  // 生成给 claude --plugin-dir 用的目录：只放 skills，插件自带的 hooks / MCP 配置一概不带
  if (m.contributes.skills?.length) {
    const cc = join(dest, 'cc');
    mkdirSync(join(cc, '.claude-plugin'), { recursive: true });
    writeFileSync(join(cc, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: mcpServerName(m.id), version: m.version, description: m.description ?? m.name ?? m.id,
    }, null, 2));
    for (const s of m.contributes.skills) {
      const name = s.split('/').filter(Boolean).pop()!;
      cpSync(join(dest, 'pkg', s), join(cc, 'skills', name), { recursive: true });
    }
  }

  store.run(
    `INSERT INTO plugins(id, version, manifest, dir, hash, installed_at) VALUES (?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET version = excluded.version, manifest = excluded.manifest, dir = excluded.dir,
       hash = excluded.hash, installed_at = excluded.installed_at`,
    m.id, m.version, JSON.stringify(m), dest, hash, now());
  return store.get<PluginRow>('SELECT * FROM plugins WHERE id = ?', m.id)!;
}

export function enable(store: Store, botId: string, pluginId: string): BotPluginRow {
  const p = store.get<PluginRow>('SELECT * FROM plugins WHERE id = ?', pluginId);
  if (!p) throw new PluginError(`插件 ${pluginId} 未安装`);
  const m = JSON.parse(p.manifest) as PluginManifest;
  // 授权快照：用户此刻同意的权限。以后插件升级权限变了，要重新同意
  store.run(
    `INSERT INTO bot_plugins(bot_id, plugin_id, granted, enabled_at) VALUES (?,?,?,?)
     ON CONFLICT(bot_id, plugin_id) DO UPDATE SET granted = excluded.granted, enabled_at = excluded.enabled_at`,
    botId, pluginId, canonicalPermissions(m.permissions), now());
  return store.get<BotPluginRow>('SELECT * FROM bot_plugins WHERE bot_id = ? AND plugin_id = ?', botId, pluginId)!;
}

export function disable(store: Store, botId: string, pluginId: string): boolean {
  return Number(store.run('DELETE FROM bot_plugins WHERE bot_id = ? AND plugin_id = ?', botId, pluginId).changes) > 0;
}

interface Enabled { plugin: PluginRow; manifest: PluginManifest; granted: ReturnType<typeof JSON.parse> }

/** 本 Bot 已启用、且授权仍然有效的插件；权限变了的单独列出 */
function enabledFor(store: Store, botId: string): { ok: Enabled[]; stale: string[] } {
  const rows = store.all<BotPluginRow & PluginRow>(
    'SELECT bp.*, p.* FROM bot_plugins bp JOIN plugins p ON p.id = bp.plugin_id WHERE bp.bot_id = ?', botId);
  const ok: Enabled[] = [];
  const stale: string[] = [];
  for (const r of rows) {
    const manifest = JSON.parse(r.manifest) as PluginManifest;
    if (canonicalPermissions(manifest.permissions) !== r.granted) stale.push(r.id);
    else ok.push({ plugin: r, manifest, granted: JSON.parse(r.granted) });
  }
  return { ok, stale };
}

export interface RunPlugins { servers: Record<string, unknown>; pluginDirs: string[]; stale: string[] }

/** 每轮开跑前：拉起 MCP 插件容器，组装 --mcp-config 里的插件部分和 --plugin-dir */
export async function prepareRun(store: Store, botId: string): Promise<RunPlugins> {
  const { ok, stale } = enabledFor(store, botId);
  const servers: Record<string, unknown> = {};
  const pluginDirs: string[] = [];
  for (const { plugin, manifest } of ok) {
    const rel = relative(pluginsRoot(), plugin.dir);
    if (manifest.contributes.skills?.length) pluginDirs.push(`/opt/pagent-plugins/${rel}/cc`);
    if (manifest.contributes.mcp) {
      await ensurePluginContainer(manifest, plugin.dir, plugin.hash);
      const mcp = manifest.contributes.mcp;
      servers[mcpServerName(manifest.id)] = { type: 'http', url: `http://${pluginHost(manifest.id)}:${mcp.port ?? 8080}${mcp.path ?? '/mcp'}` };
    }
  }
  return { servers, pluginDirs, stale };
}

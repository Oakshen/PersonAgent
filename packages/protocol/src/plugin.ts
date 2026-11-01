// 插件清单 pagent-plugin.json 的类型与校验。插件只能声明，不能执行安装脚本。
import type { Decision } from './types.ts';

export interface PluginManifest {
  id: string;                      // 反向域名风格：dev.example.web-fetch
  version: string;                 // semver
  name?: string;
  description?: string;
  engines?: { pagent?: string };
  contributes: {
    skills?: string[];             // 相对目录，每个目录含 SKILL.md
    mcp?: { runtime: 'node'; entry: string; port?: number; path?: string };
  };
  permissions: {
    network?: string[];            // host:port，或 *.suffix:port
    actions?: Record<string, Exclude<Decision, 'ask'> | 'ask'>; // MCP 工具名 → 建议的审批级别
  };
}

const ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9a-z.-]+)?$/;
const TARGET_RE = /^(\*\.)?[a-z0-9.-]+:\d{1,5}$/;
const REL_PATH_RE = /^(?!\/)(?!.*\.\.)[\w./-]+$/;
const ALLOWED_TOP = new Set(['id', 'version', 'name', 'description', 'engines', 'contributes', 'permissions']);

/** 返回错误列表；空数组表示合法。 */
export function validateManifest(m: any): string[] {
  const errs: string[] = [];
  if (typeof m !== 'object' || m === null) return ['清单必须是 JSON 对象'];
  for (const k of Object.keys(m)) if (!ALLOWED_TOP.has(k)) errs.push(`不允许的字段 "${k}"（插件不能声明安装脚本等可执行内容）`);
  if (!ID_RE.test(m.id ?? '')) errs.push('id 须为反向域名风格，如 dev.example.my-plugin');
  if (!VERSION_RE.test(m.version ?? '')) errs.push('version 须为 semver，如 1.0.0');
  const c = m.contributes;
  if (!c || (!c.skills && !c.mcp)) errs.push('contributes 至少要有 skills 或 mcp');
  for (const s of c?.skills ?? []) if (!REL_PATH_RE.test(s)) errs.push(`skills 路径不合法：${s}`);
  if (c?.mcp) {
    if (c.mcp.runtime !== 'node') errs.push('mcp.runtime 目前只支持 node');
    if (!REL_PATH_RE.test(c.mcp.entry ?? '')) errs.push('mcp.entry 须为插件内的相对路径');
  }
  const p = m.permissions;
  if (!p || typeof p !== 'object') errs.push('缺少 permissions（没有权限也要写 {}）');
  for (const t of p?.network ?? []) if (!TARGET_RE.test(t)) errs.push(`network 目标不合法：${t}（格式 host:port）`);
  for (const [tool, d] of Object.entries(p?.actions ?? {})) {
    if (!/^[\w-]+$/.test(tool)) errs.push(`actions 工具名不合法：${tool}`);
    if (!['allow', 'ask', 'deny'].includes(d as string)) errs.push(`actions.${tool} 只能是 allow / ask / deny`);
  }
  if (p?.actions && !c?.mcp) errs.push('只有 mcp 插件可以声明 actions');
  return errs;
}

/** MCP server 在 claude 里的名字（工具名为 mcp__<server>__<tool>） */
export const mcpServerName = (pluginId: string) => pluginId.replace(/[^a-z0-9-]/g, '_');

/** 权限的规范化表示，用来比较"升级后权限是否变了" */
export function canonicalPermissions(p: PluginManifest['permissions']): string {
  return JSON.stringify({
    network: [...(p.network ?? [])].sort(),
    actions: Object.fromEntries(Object.entries(p.actions ?? {}).sort(([a], [b]) => a.localeCompare(b))),
  });
}

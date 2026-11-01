// "它会的技能"：盒子里共享的 skill（所有 Agent 都能用，Agent 自己也会往里装）+ 这个 Bot 启用的插件带来的 skill。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './store.ts';
import { boxDir } from './box.ts';
import { pluginSkills } from './plugins.ts';

export interface Skill { name: string; description: string; source: string; updatedAt: string | null }

function readSkill(dir: string, source: string): Skill | null {
  const f = join(dir, 'SKILL.md');
  if (!existsSync(f)) return null;
  const text = readFileSync(f, 'utf8').slice(0, 20_000);
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(fm)?.[1].trim().replace(/^["']|["']$/g, '');
  return {
    name: field('name') ?? dir.split('/').pop()!,
    description: field('description') ?? text.replace(/^---[\s\S]*?---/, '').trim().split('\n').find((l) => l.trim() && !l.startsWith('#'))?.slice(0, 200) ?? '',
    source, updatedAt: statSync(f).mtime.toISOString(),
  };
}

export function listSkills(store: Store, botId: string): Skill[] {
  const shared = join(boxDir(), 'home', '.pagent', 'skills');
  const out: Skill[] = [];
  if (existsSync(shared)) {
    for (const n of readdirSync(shared).sort()) {
      if (n.startsWith('.')) continue;
      const s = readSkill(join(shared, n), '共享');
      if (s) out.push(s);
    }
  }
  for (const p of pluginSkills(store, botId)) {
    const s = readSkill(p.dir, `插件 ${p.plugin}`);
    if (s) out.push(s);
  }
  return out;
}

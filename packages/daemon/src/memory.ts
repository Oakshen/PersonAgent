// 两层记忆。
// - 全局记忆（关于用户）：存在库里，任何 Agent 经 pagent MCP 的 remember 写入，pagentd 串行写并记录来源。
// - Agent 记忆：盒子里它自己配置目录下的 memory/（$CLAUDE_CONFIG_DIR/memory），MEMORY.md 是索引，Agent 用文件工具直接改。
// 一条会话的系统提示在第一轮就固定了（claude --resume 会忽略新的 --append-system-prompt），所以：
// - 新会话第一轮：人设 + 说明 + 两层记忆全文写进系统提示；
// - 之后每轮：和"已经送达的版本"比对，有变化就在用户消息前补发一段更新；
// - 上下文被压缩后，补发过的更新可能丢了，退回到系统提示里的版本重新比对。
// 这样 A 这一轮写的，B 下一轮就能看到；系统提示不变，提示缓存也一直有效。
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type MemoryRow, type Store, newId, now } from './store.ts';
import type { MemoryEntry } from '../../protocol/src/types.ts';

export const GLOBAL_ENTRY_MAX = 500;      // 单条字数上限
export const GLOBAL_TOTAL_MAX = 8000;     // 全部条目合计上限，超了要先整理
const AGENT_INDEX_MAX = 25_000;           // 注入系统提示的 MEMORY.md 上限（和 Claude Code 自带记忆一致）
const AGENT_FILE_MAX = 200_000;

export class MemoryError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// ---- 全局记忆 ----

export function listGlobal(store: Store): MemoryEntry[] {
  return store.all<MemoryRow & { bot_name: string | null }>(
    `SELECT m.*, b.name AS bot_name FROM memories m LEFT JOIN bots b ON b.id = m.source_bot_id
     WHERE m.deleted_at IS NULL ORDER BY m.created_at`)
    .map((r) => ({ id: r.id, text: r.text, sourceBot: r.bot_name, sourceRun: r.source_run_id, createdAt: r.created_at, updatedAt: r.updated_at }));
}

interface Source { botId?: string | null; runId?: string | null; threadId?: string | null; by: string }

/** 新增一条，或用 replaces 改写已有的一条（Agent 更正记忆用） */
export function rememberGlobal(store: Store, text: unknown, src: Source, replaces?: unknown): MemoryEntry {
  const t = String(text ?? '').trim().replace(/\s*\n\s*/g, ' ');
  if (!t) throw new MemoryError(400, '记忆内容不能为空');
  if (t.length > GLOBAL_ENTRY_MAX) throw new MemoryError(400, `单条记忆最多 ${GLOBAL_ENTRY_MAX} 字，请写得更精炼`);
  return store.tx(() => {
    const old = replaces ? store.get<MemoryRow>('SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL', String(replaces)) : undefined;
    if (replaces && !old) throw new MemoryError(404, `没有编号为 ${replaces} 的记忆`);
    const total = store.get<{ n: number }>('SELECT coalesce(sum(length(text)), 0) n FROM memories WHERE deleted_at IS NULL')!.n;
    if (total - (old?.text.length ?? 0) + t.length > GLOBAL_TOTAL_MAX) {
      throw new MemoryError(409, `全局记忆已接近上限（${GLOBAL_TOTAL_MAX} 字），请先合并或删掉过时的条目（用 replaces 改写）`);
    }
    const id = old?.id ?? newId('mem');
    if (old) {
      store.run('UPDATE memories SET text = ?, source_bot_id = ?, source_run_id = ?, updated_at = ? WHERE id = ?',
        t, src.botId ?? null, src.runId ?? null, now(), id);
    } else {
      store.run('INSERT INTO memories(id, text, source_bot_id, source_run_id, created_at, updated_at) VALUES (?,?,?,?,?,?)',
        id, t, src.botId ?? null, src.runId ?? null, now(), now());
    }
    store.emit('memory.updated', { scope: 'global', op: old ? 'update' : 'add', id, text: t, before: old?.text ?? null, by: src.by },
      { botId: src.botId, runId: src.runId, threadId: src.threadId });
    return listGlobal(store).find((m) => m.id === id)!;
  });
}

export function forgetGlobal(store: Store, id: string, by: string): void {
  store.tx(() => {
    const old = store.get<MemoryRow>('SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL', id);
    if (!old) throw new MemoryError(404, `没有编号为 ${id} 的记忆`);
    store.run('UPDATE memories SET deleted_at = ? WHERE id = ?', now(), id);
    store.emit('memory.updated', { scope: 'global', op: 'delete', id, text: null, before: old.text, by });
  });
}

// ---- Agent 记忆（文件） ----

const FILE_RE = /^[\p{L}\p{N}_.-]{1,80}\.md$/u;

export function checkFileName(name: string): string {
  if (!FILE_RE.test(name) || name.startsWith('.')) throw new MemoryError(400, '文件名只能用文字、数字、_ . -，以 .md 结尾');
  return name;
}

/** 目录里的记忆文件（只看第一层的 .md） */
export function readAgentFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    if (!FILE_RE.test(name)) continue;
    const p = join(dir, name);
    try {
      if (!statSync(p).isFile()) continue;
      out.set(name, readFileSync(p, 'utf8').slice(0, AGENT_FILE_MAX));
    } catch {}
  }
  return out;
}

export function writeAgentFile(dir: string, name: string, content: unknown): void {
  const text = String(content ?? '');
  if (text.length > AGENT_FILE_MAX) throw new MemoryError(400, '文件太大');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, checkFileName(name)), text);
}

export function deleteAgentFile(dir: string, name: string): boolean {
  const p = join(dir, checkFileName(name));
  if (!existsSync(p)) return false;
  rmSync(p);
  return true;
}

export interface FileChange { file: string; op: 'write' | 'delete'; added: string[]; removed: number }

/** 两次快照之间变了哪些文件；added 是新出现的非空行（给时间线看个大概） */
export function diffFiles(before: Map<string, string>, after: Map<string, string>): FileChange[] {
  const out: FileChange[] = [];
  for (const [file, text] of after) {
    const old = before.get(file);
    if (old === text) continue;
    const oldLines = new Set((old ?? '').split('\n'));
    const newLines = new Set(text.split('\n'));
    out.push({
      file, op: 'write',
      added: [...newLines].filter((l) => l.trim() && !oldLines.has(l)).slice(0, 5),
      removed: [...oldLines].filter((l) => l.trim() && !newLines.has(l)).length,
    });
  }
  for (const [file, old] of before) {
    if (!after.has(file)) out.push({ file, op: 'delete', added: [], removed: old.split('\n').filter((l) => l.trim()).length });
  }
  return out;
}

// ---- 系统提示 ----

const guide = (memDir: string) => `# 你的记忆

你有两层长期记忆，跨会话保留。对话上下文会被压缩、也可能换成新会话，但记忆不会丢。

什么时候写：一学到以后还用得上的事就**当场**写，不要等这一轮结束。比如用户纠正了你、你们做了决定、用户告诉你偏好或事实、你摸索出了做某件事的方法。

写到哪：
- 关于用户本人的事（称呼、偏好、常用账号和设备、家庭和工作背景、正在推进的大事）→ 调用 \`mcp__pagent__remember\`。这是所有 Agent 共享的全局记忆。更正已有条目时带上它的编号（replaces），不要另写一条互相矛盾的。
- 关于你自己工作的事（负责什么、做过的决定、工作方法、踩过的坑）→ 直接编辑 \`${memDir}/\` 下的文件（也就是 \`$CLAUDE_CONFIG_DIR/memory/\`；注意不是 \`~/.claude/memory/\`）。\`MEMORY.md\` 是索引，每行一条、尽量短；细节放进按主题分的文件（如 \`deploy.md\`），在索引里写一行指向它。

不要写进记忆：密码、token、密钥等凭据；一次性的过程细节。记忆错了就当场改掉或删掉。`;

const CONDUCT = `# 和用户的沟通方式

- 用户把这台电脑交给你，你做任何操作都不需要先征得同意，直接做完再汇报（除非上面的人设里另有要求）。
- 只有缺少关键信息、或者有几条路必须由用户拿主意时，才停下来问。需要用户在几个选项里挑一个时，一律调用 \`mcp__pagent__ask_user\`（用户会看到一张可以直接点的选择卡），不要把选项写在回复正文里。调用之后这一轮就结束，等用户回答，不要接着干。
- 对话已经很长、或者话题彻底换了，可以调用 \`mcp__pagent__new_session\`：下一轮换一条新会话，记忆都还在。`;

const box = (name: string) => `# 这台电脑

你是 Agent「${name}」，和用户的其他 Agent 共用这台 Linux 电脑（用户 box，可以 sudo）。
- \`/workspace\` 是大家共享的工作区，你的东西放在 \`/workspace/${name}/\` 下；\`/home/box\` 里的命令行登录（gh、ssh、各种 CLI）、npm -g / pip --user 装的工具都共享，一个 Agent 登录过，别的 Agent 直接能用。
- skill 装到 \`$CLAUDE_CONFIG_DIR/skills/\`（和 \`~/.claude/skills/\` 是同一个共享目录），所有 Agent 下一轮都能用。
- 只改你自己的记忆目录，不要动其他 Agent 的。
- 用 apt 装的系统软件在电脑重建时会丢，要长期用的工具优先装进 /home/box。`;

/** 工作方式说明（人设之后、记忆之前的固定部分），记忆目录是盒子里的路径 */
export const guideFor = (name: string, memDir: string) => [guide(memDir), CONDUCT, box(name)].join('\n\n');

export function systemPrompt(persona: string, guideText: string, globals: MemoryEntry[], agentIndex: string | null): string {
  const g = globals.length
    ? globals.map((m) => `- [${m.id}] ${m.text}`).join('\n')
    : '（还没有）';
  let idx = agentIndex?.trim() ? agentIndex.trim() : '（还是空的）';
  if (idx.length > AGENT_INDEX_MAX) idx = `${idx.slice(0, AGENT_INDEX_MAX)}\n…（索引太长被截断，请精简 MEMORY.md）`;
  return [
    persona.trim(),
    guideText,
    `## 关于用户（全局记忆）\n${g}`,
    `## 你自己的记忆（MEMORY.md）\n${idx}`,
  ].filter(Boolean).join('\n\n');
}

// ---- 会话内的记忆送达 ----

/** 人设、工作方式说明和记忆在某一时刻的样子。guide 是 P4 加的，更早的快照里没有 */
export interface MemSnap { persona: string; guide?: string; globals: Record<string, string>; index: string }

export const snap = (persona: string, guideText: string, globals: MemoryEntry[], index: string | null): MemSnap => ({
  persona: persona.trim(), guide: guideText, globals: Object.fromEntries(globals.map((m) => [m.id, m.text])), index: (index ?? '').trim(),
});

export const promptOf = (s: MemSnap) =>
  systemPrompt(s.persona, s.guide ?? '', Object.entries(s.globals).map(([id, text]) => ({ id, text }) as MemoryEntry), s.index);

/** 比上次送达的版本多了什么；没变化返回空串。prev 为 null（老会话从没收到过）时补发全文。 */
export function updateBlock(prev: MemSnap | null, cur: MemSnap): string {
  if (!prev) {
    return `<pagent-context>\n以下是你的人设、工作方式和记忆，由系统补发，以此为准。\n\n${promptOf(cur)}\n</pagent-context>\n\n`;
  }
  const parts: string[] = [];
  if (prev.persona !== cur.persona) parts.push(`## 你的人设已更新，现在是：\n${cur.persona || '（空）'}`);
  // 工作方式说明变了（比如搬进共享盒子后记忆目录换了地方）：整段重发，之前的说法作废
  if (prev.guide !== cur.guide) parts.push(`## 工作方式说明有更新，以下面这版为准（之前的说法作废）\n\n${cur.guide}`);
  const g: string[] = [];
  for (const [id, text] of Object.entries(cur.globals)) {
    if (!(id in prev.globals)) g.push(`+ [${id}] ${text}`);
    else if (prev.globals[id] !== text) g.push(`~ [${id}] ${text}（改写，原来是：${prev.globals[id]}）`);
  }
  for (const [id, text] of Object.entries(prev.globals)) if (!(id in cur.globals)) g.push(`- [${id}] 已删除：${text}`);
  if (g.length) parts.push(`## 关于用户（全局记忆）有变化\n${g.join('\n')}`);
  if (prev.index !== cur.index) {
    let idx = cur.index || '（空）';
    if (idx.length > AGENT_INDEX_MAX) idx = `${idx.slice(0, AGENT_INDEX_MAX)}\n…（被截断）`;
    parts.push(`## 你的 MEMORY.md 被改过（可能是用户在面板里改的），当前全文：\n${idx}`);
  }
  if (!parts.length) return '';
  return `<pagent-update>\n自上次以来的变化，以此为准：\n\n${parts.join('\n\n')}\n</pagent-update>\n\n`;
}

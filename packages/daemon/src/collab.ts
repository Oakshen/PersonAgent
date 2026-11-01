// Agent 之间协作：发消息（做完自动回传结果）、群聊、总管。
// - message_agent：消息排进对方当前的会话；对方这一轮结束时，它的回复自动发回给你（回复不再要求回复）。
// - 群聊：你发的消息交给总管（或 @ 到的成员）；群里每个 Agent 因群消息而跑的那一轮，说的话都显示在群的时间线上。
// - 环路保护：转发层数上限、每个 Agent 每小时发消息的次数上限。
import { type BotRow, type Store, newId, now } from './store.ts';
import type { Runner } from './runner.ts';
import { ServiceError, botByName } from './service.ts';

export const MAX_DEPTH = 4;
const MAX_PER_HOUR = 30;

export interface GroupMeta { id: string; name: string }
export interface MsgMeta {
  from?: string; fromBotId?: string; replyTo?: string; reply?: boolean; depth?: number; group?: GroupMeta;
  routine?: unknown;
}

interface GroupRow { id: string; name: string; members: string; manager_id: string | null; created_at: string }

/** 这一轮是由哪些消息触发的：转发层数取最大，群取第一个 */
export function runContext(store: Store, runId: string): { depth: number; group?: GroupMeta } {
  let depth = 0;
  let group: GroupMeta | undefined;
  for (const m of store.all<{ meta: string | null }>('SELECT meta FROM messages WHERE run_id = ?', runId)) {
    const meta = m.meta ? JSON.parse(m.meta) as MsgMeta : {};
    depth = Math.max(depth, meta.depth ?? 0);
    group ??= meta.group;
  }
  return { depth, group };
}

export function listAgents(store: Store, exceptId?: string) {
  return store.all<BotRow>('SELECT * FROM bots ORDER BY created_at').filter((b) => b.id !== exceptId)
    .map((b) => ({ name: b.name, persona: b.persona.slice(0, 200), engine: b.engine }));
}

/** 一个 Agent 给另一个发消息 */
export function messageAgent(store: Store, runner: Runner, from: BotRow, runId: string, to: string, text: string, expectReply = true) {
  const target = botByName(store, String(to ?? '').trim());
  if (target.id === from.id) throw new ServiceError(400, '不能给自己发消息');
  const body = String(text ?? '').trim().slice(0, 8000);
  if (!body) throw new ServiceError(400, '消息不能为空');
  const ctx = runContext(store, runId);
  if (ctx.depth + 1 > MAX_DEPTH) throw new ServiceError(429, `转发层数到上限（${MAX_DEPTH}）了：请直接自己完成，或者把结果告诉用户`);
  const recent = store.get<{ n: number }>(
    "SELECT count(*) n FROM events WHERE type = 'agent.message' AND bot_id = ? AND ts > ?", from.id, new Date(Date.now() - 3600_000).toISOString())!.n;
  if (recent >= MAX_PER_HOUR) throw new ServiceError(429, `这一小时发给其他 Agent 的消息已经 ${recent} 条，到上限了`);
  const meta: MsgMeta = { from: from.name, fromBotId: from.id, replyTo: expectReply ? from.id : undefined, depth: ctx.depth + 1, group: ctx.group };
  const prefix = ctx.group ? `[群聊「${ctx.group.name}」· 来自 ${from.name}]` : `[来自 Agent ${from.name}]`;
  const tail = expectReply ? '\n\n（做完后直接回答结果即可，你这一轮的最后一段回复会自动发回给对方。）' : '';
  store.tx(() => {
    store.emit('agent.message', { to: target.name, text: body, expectReply, ...(ctx.group ? { groupId: ctx.group.id } : {}) }, { botId: from.id, runId });
    runner.enqueue(target.id, `${prefix} ${body}${tail}`, meta as Record<string, unknown>);
  });
  return { ok: true, to: target.name };
}

/** 一轮结束：别的 Agent 托付的事，把最后的回复发回去 */
export function forwardReplies(store: Store, runner: Runner, bot: BotRow, status: string, text: string, metas: MsgMeta[]) {
  const sent = new Set<string>();
  for (const meta of metas) {
    if (!meta.replyTo || meta.reply || sent.has(meta.replyTo)) continue;
    sent.add(meta.replyTo);
    const body = status === 'succeeded' ? (text || '（没有文字回复）') : `（这一轮没完成：${status}）${text ? `\n${text}` : ''}`;
    const prefix = meta.group ? `[群聊「${meta.group.name}」· ${bot.name} 的回复]` : `[${bot.name} 的回复]`;
    runner.enqueue(meta.replyTo, `${prefix} ${body.slice(0, 8000)}`, { from: bot.name, fromBotId: bot.id, reply: true, depth: meta.depth ?? 1, group: meta.group });
  }
}

// ---- 群聊 ----

const toGroup = (store: Store, g: GroupRow) => {
  const bots = new Map(store.all<BotRow>('SELECT id, name FROM bots').map((b) => [b.id, b.name]));
  return {
    id: g.id, name: g.name, members: (JSON.parse(g.members) as string[]).map((id) => bots.get(id)).filter(Boolean) as string[],
    manager: g.manager_id ? bots.get(g.manager_id) ?? null : null, createdAt: g.created_at,
  };
};

export function listGroups(store: Store) {
  return store.all<GroupRow>('SELECT * FROM groups ORDER BY created_at').map((g) => toGroup(store, g));
}

export function createGroup(store: Store, b: { name?: unknown; members?: unknown; manager?: unknown }, by: string) {
  const name = String(b.name ?? '').trim().slice(0, 40);
  if (!name) throw new ServiceError(400, '群名不能为空');
  const members = [...new Set((Array.isArray(b.members) ? b.members : []).map((n) => botByName(store, String(n)).id))];
  if (members.length < 2) throw new ServiceError(400, '群里至少要两个 Agent');
  const manager = b.manager ? botByName(store, String(b.manager)).id : null;
  if (manager && !members.includes(manager)) members.unshift(manager);
  const id = newId('grp');
  store.tx(() => {
    store.run('INSERT INTO groups(id, name, members, manager_id, created_at) VALUES (?,?,?,?,?)', id, name, JSON.stringify(members), manager, now());
    store.emit('group.changed', { op: 'create', groupId: id, name, by });
  });
  return toGroup(store, store.get<GroupRow>('SELECT * FROM groups WHERE id = ?', id)!);
}

export function deleteGroup(store: Store, id: string, by: string) {
  const g = store.get<GroupRow>('SELECT * FROM groups WHERE id = ?', id);
  if (!g) throw new ServiceError(404, '没有这个群');
  store.tx(() => {
    store.run('DELETE FROM groups WHERE id = ?', id);
    store.emit('group.changed', { op: 'delete', groupId: id, name: g.name, by });
  });
  return { ok: true };
}

/** 你在群里发言：@ 到的成员各收一份；没 @ 就交给总管（没有总管就发给所有成员） */
export function postToGroup(store: Store, runner: Runner, groupId: string, text: string, by: string) {
  const row = store.get<GroupRow>('SELECT * FROM groups WHERE id = ?', groupId);
  if (!row) throw new ServiceError(404, '没有这个群');
  const g = toGroup(store, row);
  const body = String(text ?? '').trim().slice(0, 8000);
  if (!body) throw new ServiceError(400, '消息不能为空');
  const mentioned = g.members.filter((n) => body.includes(`@${n}`));
  const targets = mentioned.length ? mentioned : g.manager ? [g.manager] : g.members;
  const roster = g.members.map((n) => (n === g.manager ? `${n}（总管）` : n)).join('、');
  const meta: MsgMeta = { group: { id: g.id, name: g.name }, depth: 0 };
  store.tx(() => {
    store.emit('message.queued', { text: body, by, groupId: g.id, targets }, {});
    for (const t of targets) {
      const isManager = t === g.manager && !mentioned.length;
      const hint = isManager
        ? `你是这个群的总管，成员有：${roster}。需要分工时用 message_agent 把具体任务交给合适的成员（他们做完会自动回复你），都回来后由你汇总给用户。简单的事你自己直接答。`
        : `群成员：${roster}。`;
      runner.enqueue(botByName(store, t).id, `[群聊「${g.name}」· 用户] ${body}\n\n（${hint}）`, meta as Record<string, unknown>);
    }
  });
  return { ok: true, targets };
}

/** 群的时间线：你在群里说的话、成员之间的消息，以及由群消息触发的那些轮次里 Agent 说的话 */
export function groupHistory(store: Store, groupId: string, limit = 400) {
  const runs = store.all<{ run_id: string }>(
    "SELECT DISTINCT run_id FROM messages WHERE run_id IS NOT NULL AND json_extract(meta, '$.group.id') = ?", groupId).map((r) => r.run_id);
  const rows = store.all<{ seq: number }>(
    `SELECT seq FROM events WHERE (json_extract(data, '$.groupId') = ? AND type IN ('message.queued', 'agent.message', 'group.changed'))
       OR (run_id IN (SELECT value FROM json_each(?)) AND type IN ('assistant.text', 'run.started', 'run.finished', 'tool.use'))
     ORDER BY seq DESC LIMIT ?`, groupId, JSON.stringify(runs), limit);
  const seqs = rows.map((r) => r.seq).reverse();
  if (!seqs.length) return [];
  const want = new Set(seqs);
  return store.eventsAfter(seqs[0] - 1, seqs[seqs.length - 1] - seqs[0] + 1).filter((e) => want.has(e.seq));
}

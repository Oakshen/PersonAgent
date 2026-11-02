// Agent 之间协作：发消息、托付任务（等齐了一次交回）、群聊、总管。
// - message_agent：消息排进对方当前的会话，记一条"托付"。同一轮里托付出去的事是一批：
//   每件做完先记下结果，等这一批全部有结果、而且托付它们的那一轮也结束了，才把所有结果合成一条消息发回去，
//   所以总管只醒一次、拿着全部结果汇总。对方停下来问用户时，这件事继续等，用户回答后的那一轮结果才算数。
// - 等太久（默认 60 分钟）就先把已有的结果交回，迟到的结果之后单独发。
// - 环路保护：转发层数上限、每个 Agent 每小时发消息的次数上限。
import { type BotRow, type Store, newId, now } from './store.ts';
import type { Runner } from './runner.ts';
import { ServiceError, botByName } from './service.ts';

export const MAX_DEPTH = 4;
const MAX_PER_HOUR = 30;
const WAIT_MS = Number(process.env.PAGENT_COLLAB_WAIT_MIN ?? 60) * 60_000;

export interface GroupMeta { id: string; name: string }
export interface MsgMeta {
  from?: string; fromBotId?: string; assignment?: string; reply?: boolean; depth?: number; group?: GroupMeta;
  routine?: unknown;
}

interface GroupRow { id: string; name: string; members: string; manager_id: string | null; created_at: string }
type AssignmentStatus = 'queued' | 'asking' | 'done' | 'failed' | 'timeout';
interface AssignmentRow {
  id: string; batch: string; from_bot: string; to_bot: string; status: AssignmentStatus; result: string | null;
  meta: string; created_at: string; settled_at: string | null; delivered_at: string | null;
}

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

/** 一个 Agent 给另一个发消息；expectReply 时记一条托付，批次就是发起的这一轮 */
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
  const assignment = expectReply ? newId('asg') : undefined;
  const meta: MsgMeta = { from: from.name, fromBotId: from.id, assignment, depth: ctx.depth + 1, group: ctx.group };
  const prefix = ctx.group ? `[群聊「${ctx.group.name}」· 来自 ${from.name}]` : `[来自 Agent ${from.name}]`;
  const tail = expectReply ? '\n\n（做完后直接回答结果即可，你这一轮的最后一段回复会自动交给对方。）' : '';
  store.tx(() => {
    if (assignment) {
      store.run('INSERT INTO assignments(id, batch, from_bot, to_bot, status, meta, created_at) VALUES (?,?,?,?,?,?,?)',
        assignment, runId, from.id, target.id, 'queued', JSON.stringify({ depth: ctx.depth + 1, group: ctx.group }), now());
    }
    store.emit('agent.message', { to: target.name, text: body, expectReply, ...(ctx.group ? { groupId: ctx.group.id } : {}) }, { botId: from.id, runId });
    runner.enqueue(target.id, `${prefix} ${body}${tail}`, meta as Record<string, unknown>);
  });
  return { ok: true, to: target.name };
}

/**
 * 一轮结束（在 runner 的收尾事务里调用）：
 * - 这一轮接手的托付、以及之前停下来问用户的托付，记下结果；这一轮又停下来问用户的，继续等；
 * - 发起方的这一轮结束了，看看它托付出去的那一批是不是齐了。
 */
export function afterRunCollab(store: Store, runner: Runner, bot: BotRow, runId: string, status: string, text: string, metas: MsgMeta[]) {
  const ids = new Set(metas.map((m) => m.assignment).filter(Boolean) as string[]);
  for (const a of store.all<AssignmentRow>("SELECT * FROM assignments WHERE to_bot = ? AND status = 'asking'", bot.id)) ids.add(a.id);
  const asking = status === 'succeeded' && !!store.get('SELECT 1 FROM asks WHERE run_id = ? AND answered_at IS NULL', runId);
  const batches = new Set<string>([runId]);
  for (const id of ids) {
    const a = store.get<AssignmentRow>('SELECT * FROM assignments WHERE id = ?', id);
    if (!a || a.to_bot !== bot.id || !['queued', 'asking', 'timeout'].includes(a.status)) continue;
    if (asking) { store.run("UPDATE assignments SET status = 'asking' WHERE id = ?", id); continue; }
    const late = a.status === 'timeout';
    store.run('UPDATE assignments SET status = ?, result = ?, settled_at = ? WHERE id = ?',
      status === 'succeeded' ? 'done' : 'failed', status === 'succeeded' ? (text || '（没有文字回复）') : `（这一轮没完成：${status}）${text ? `\n${text}` : ''}`, now(), id);
    if (late) deliver(store, runner, [{ ...store.get<AssignmentRow>('SELECT * FROM assignments WHERE id = ?', id)! }], '迟到的回复');
    else batches.add(a.batch);
  }
  for (const b of batches) deliverIfComplete(store, runner, b);
}

function deliverIfComplete(store: Store, runner: Runner, batch: string) {
  const rows = store.all<AssignmentRow>('SELECT * FROM assignments WHERE batch = ? AND delivered_at IS NULL ORDER BY created_at', batch);
  if (!rows.length || rows.some((a) => a.status === 'queued' || a.status === 'asking')) return;
  if (store.get("SELECT 1 FROM runs WHERE id = ? AND status = 'running'", batch)) return;   // 发起的那一轮还没结束
  deliver(store, runner, rows);
}

/** 把一批结果合成一条消息发回发起方 */
function deliver(store: Store, runner: Runner, rows: AssignmentRow[], title?: string) {
  const names = new Map(store.all<{ id: string; name: string }>('SELECT id, name FROM bots').map((b) => [b.id, b.name]));
  const meta = JSON.parse(rows[0].meta) as { depth?: number; group?: GroupMeta };
  const label = { done: '完成', failed: '没完成', timeout: '还没回复' } as Record<string, string>;
  const parts = rows.map((a) => {
    const who = names.get(a.to_bot) ?? a.to_bot;
    const body = a.status === 'timeout' ? `已经等了 ${Math.round(WAIT_MS / 60_000)} 分钟还没回复；回复到了会单独发给你。` : (a.result ?? '').slice(0, 8000);
    return `### ${who}（${label[a.status] ?? a.status}）\n${body}`;
  });
  const done = rows.filter((a) => a.status !== 'timeout').map((a) => names.get(a.to_bot) ?? a.to_bot);
  const head = title ?? (rows.length === 1 ? `${done[0] ?? names.get(rows[0].to_bot)} 的回复` : `你托付出去的 ${rows.length} 件事都有结果了`);
  const prefix = meta.group ? `[群聊「${meta.group.name}」· ${head}]` : `[${head}]`;
  const ts = now();
  for (const a of rows) {
    store.run('UPDATE assignments SET delivered_at = ? WHERE id = ?', ts, a.id);
  }
  runner.enqueue(rows[0].from_bot, `${prefix}\n\n${parts.join('\n\n')}`,
    { from: done.join('、') || '成员', reply: true, depth: meta.depth ?? 1, group: meta.group, assignments: rows.map((a) => a.id) });
}

/** 等太久的批次：先把已有的结果交回去 */
export function sweepAssignments(store: Store, runner: Runner, waitMs = WAIT_MS) {
  const cutoff = new Date(Date.now() - waitMs).toISOString();
  const stale = store.all<{ batch: string }>(
    "SELECT DISTINCT batch FROM assignments WHERE status = 'queued' AND delivered_at IS NULL AND created_at < ?", cutoff);
  for (const { batch } of stale) {
    store.tx(() => {
      if (store.get("SELECT 1 FROM runs WHERE id = ? AND status = 'running'", batch)) return;
      store.run("UPDATE assignments SET status = 'timeout' WHERE batch = ? AND status = 'queued' AND delivered_at IS NULL", batch);
      const rows = store.all<AssignmentRow>("SELECT * FROM assignments WHERE batch = ? AND delivered_at IS NULL AND status != 'asking' ORDER BY created_at", batch);
      if (rows.length) deliver(store, runner, rows, '等太久了，先交回已有的结果');
    });
  }
}

/** 某个 Agent 还在等谁 */
export function waitingOn(store: Store, botId: string): string[] {
  return store.all<{ name: string }>(
    `SELECT DISTINCT b.name FROM assignments a JOIN bots b ON b.id = a.to_bot
     WHERE a.from_bot = ? AND a.status IN ('queued', 'asking') AND a.delivered_at IS NULL`, botId).map((r) => r.name);
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

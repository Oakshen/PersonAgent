// 本机 API 与远程 API 共用的操作。
import type http from 'node:http';
import { type ActionRow, type ApprovalRow, type BotRow, type RunRow, type Store, type ThreadRow, bus, newId, now } from './store.ts';
import type { Runner } from './runner.ts';
import type { Approvals } from './approvals.ts';
import type { BotStatus, PagentEvent } from '../../protocol/src/types.ts';

export class ServiceError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// 名字可以用中文；不能有空格和斜杠（要放进 URL 和命令行参数）
export const BOT_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,30}$/u;

export function createBot(store: Store, b: { name?: string; persona?: string; model?: string | null; policy?: unknown; maxTurns?: number }): BotRow {
  const name = String(b?.name ?? '').trim();
  if (!BOT_NAME_RE.test(name)) throw new ServiceError(400, '名字 1~31 个字符，只能用文字、数字、- 和 _，不能有空格');
  if (store.get('SELECT 1 FROM bots WHERE name = ?', name)) throw new ServiceError(409, `已经有叫 ${name} 的 Bot 了`);
  const persona = String(b.persona ?? '').slice(0, 4000);
  const id = newId('bot');
  store.tx(() => {
    store.run('INSERT INTO bots(id, name, persona, model, policy, max_turns, created_at) VALUES (?,?,?,?,?,?,?)',
      id, name, persona, b.model || null, JSON.stringify(b.policy ?? []), b.maxTurns ?? 30, now());
    store.emit('bot.created', { name }, { botId: id });
  });
  return store.get<BotRow>('SELECT * FROM bots WHERE id = ?', id)!;
}

export function botByName(store: Store, name: string): BotRow {
  const b = store.get<BotRow>('SELECT * FROM bots WHERE name = ?', name);
  if (!b) throw new ServiceError(404, `没有名为 ${name} 的 Bot`);
  return b;
}

/** 发消息。interrupt=true 时先打断这个 Thread 正在跑的一轮，新消息排在它后面（"打断并插话"）。 */
export function sendMessage(store: Store, runner: Runner, botName: string, text: string, opts: { newThread?: boolean; interrupt?: boolean } = {}) {
  const bot = botByName(store, botName);
  if (!text?.trim()) throw new ServiceError(400, '消息不能为空');
  let thread = opts.newThread ? undefined
    : store.get<ThreadRow>('SELECT * FROM threads WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1', bot.id);
  if (!thread) {
    const id = newId('thr');
    store.run('INSERT INTO threads(id, bot_id, created_at) VALUES (?,?,?)', id, bot.id, now());
    thread = store.get<ThreadRow>('SELECT * FROM threads WHERE id = ?', id)!;
  }
  let interrupted: string | null = null;
  if (opts.interrupt) {
    const running = store.get<RunRow>("SELECT * FROM runs WHERE thread_id = ? AND status = 'running'", thread.id);
    if (running && runner.interrupt(running.id, '用户打断并插话')) interrupted = running.id;
  }
  return { threadId: thread.id, interrupted, ...runner.enqueue(thread.id, text) };
}

export function decideApproval(approvals: Approvals, id: string, decision: unknown, by: string) {
  const status = decision === 'approve' ? 'approved' : decision === 'deny' ? 'denied' : null;
  if (!status) throw new ServiceError(400, 'decision 必须是 approve 或 deny');
  const r = approvals.settle(id, status, by);
  if (!r.current) throw new ServiceError(404, '审批不存在');
  if (!r.ok) throw new ServiceError(409, `审批已是 ${r.current} 状态，不能再改`);
  return { ok: true, status };
}

/** 人工核对 unknown 的操作：确认它到底发生了没有。只能从 unknown 转出一次。 */
export function reconcileAction(store: Store, actionId: string, outcome: unknown, by: string, note?: string) {
  if (outcome !== 'happened' && outcome !== 'not_happened') throw new ServiceError(400, 'outcome 必须是 happened 或 not_happened');
  return store.tx(() => {
    const a = store.get<ActionRow & { bot_id: string; thread_id: string }>(
      'SELECT a.*, r.bot_id, r.thread_id FROM actions a JOIN runs r ON r.id = a.run_id WHERE a.id = ?', actionId);
    if (!a) throw new ServiceError(404, '操作不存在');
    const reason = `核对：${outcome === 'happened' ? '已发生' : '未发生'}（${by}）${note ? `：${note}` : ''}`;
    const r = store.run("UPDATE actions SET status = ?, reason = ?, updated_at = ? WHERE id = ? AND status = 'unknown'",
      outcome === 'happened' ? 'succeeded' : 'failed', reason, now(), actionId);
    if (r.changes === 0) throw new ServiceError(409, `该操作状态是 ${a.status}，不需要核对`);
    store.emit('action.reconciled', { actionId, outcome, by, note: note ?? null }, { runId: a.run_id, botId: a.bot_id, threadId: a.thread_id });
    return { ok: true };
  });
}

export function botStatus(store: Store, botId: string): BotStatus {
  const has = (sql: string) => !!store.get(sql, botId);
  if (has("SELECT 1 FROM approvals a JOIN runs r ON r.id = a.run_id WHERE r.bot_id = ? AND a.status = 'pending'")) return 'waiting';
  if (has("SELECT 1 FROM runs WHERE bot_id = ? AND status = 'running'")) return 'working';
  if (has("SELECT 1 FROM actions a JOIN runs r ON r.id = a.run_id WHERE r.bot_id = ? AND a.status = 'unknown'")) return 'attention';
  const last = store.get<{ status: string }>('SELECT status FROM runs WHERE bot_id = ? ORDER BY started_at DESC LIMIT 1', botId);
  return last?.status === 'failed' ? 'failed' : 'idle';
}

/** 远程客户端打开时用的快照：名单 + 待审批 + 待核对 + 当前事件游标 */
export function snapshot(store: Store) {
  return {
    bots: store.all<BotRow>('SELECT * FROM bots ORDER BY created_at').map((b) => {
      const last = store.get<{ ts: string; type: string; data: string }>(
        "SELECT ts, type, data FROM events WHERE bot_id = ? AND type IN ('assistant.text', 'message.queued') ORDER BY seq DESC LIMIT 1", b.id);
      return {
        id: b.id, name: b.name, persona: b.persona, model: b.model, createdAt: b.created_at, status: botStatus(store, b.id),
        lastText: last ? String(JSON.parse(last.data).text ?? '').slice(0, 120) : null,
        lastAt: last?.ts ?? null,
      };
    }),
    approvals: store.all<ApprovalRow & { bot_id: string }>(
      "SELECT a.*, r.bot_id FROM approvals a JOIN runs r ON r.id = a.run_id WHERE a.status = 'pending' ORDER BY a.created_at"),
    unknownActions: store.all<ActionRow & { bot_id: string }>(
      "SELECT a.*, r.bot_id FROM actions a JOIN runs r ON r.id = a.run_id WHERE a.status = 'unknown' ORDER BY a.created_at"),
    seq: store.get<{ s: number | null }>('SELECT max(seq) s FROM events')!.s ?? 0,
  };
}

export function botHistory(store: Store, botName: string, limit: number): PagentEvent[] {
  const bot = botByName(store, botName);
  const rows = store.all<{ seq: number }>('SELECT seq FROM events WHERE bot_id = ? ORDER BY seq DESC LIMIT ?', bot.id, Math.min(limit, 1000));
  if (!rows.length) return [];
  const minSeq = rows[rows.length - 1].seq;
  return store.eventsAfter(minSeq - 1, 1000).filter((e) => e.botId === bot.id);
}

export interface EventFilter { threadId?: string | null; runId?: string | null; botId?: string | null }

/** SSE 事件流：先回放 after 之后的事件，再实时推送。回放与订阅在同一个同步片段里，不会漏事件。
 *  返回关闭函数（设备撤销时由调用方强制断开）。 */
export function streamEvents(store: Store, res: http.ServerResponse, after: number, filter: EventFilter = {}): () => void {
  const match = (e: PagentEvent) =>
    (!filter.threadId || e.threadId === filter.threadId) && (!filter.runId || e.runId === filter.runId) && (!filter.botId || e.botId === filter.botId);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
  res.write(': connected\n\n'); // 立刻把响应头发出去，客户端才能马上知道已连上
  const write = (e: PagentEvent) => { if (match(e)) res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`); };
  let cursor = after;
  for (let batch = store.eventsAfter(cursor); batch.length; batch = store.eventsAfter(cursor)) {
    batch.forEach(write);
    cursor = batch[batch.length - 1].seq;
  }
  const onEvent = (e: PagentEvent) => { if (e.seq > cursor) write(e); };
  bus.on('event', onEvent);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  const close = () => {
    bus.off('event', onEvent);
    clearInterval(ping);
    res.end();
  };
  res.on('close', close);
  return close;
}

// 本机 API 与远程 API 共用的操作。
import { waitingOn } from './collab.ts';
import { engineOf } from './engines.ts';
import type http from 'node:http';
import { type AskRow, type BotRow, type RunRow, type Store, bus, newId, now } from './store.ts';
import { type Runner, agentMemoryDir } from './runner.ts';
import { deleteAgentFile, diffFiles, readAgentFiles, writeAgentFile } from './memory.ts';
import type { BotStatus, PagentEvent } from '../../protocol/src/types.ts';

export class ServiceError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// 名字可以用中文；不能有空格和斜杠（要放进 URL 和命令行参数）
export const BOT_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,30}$/u;

export function createBot(store: Store, b: { name?: string; persona?: string; model?: string | null; maxTurns?: number; engine?: string }): BotRow {
  const name = String(b?.name ?? '').trim();
  if (!BOT_NAME_RE.test(name)) throw new ServiceError(400, '名字 1~31 个字符，只能用文字、数字、- 和 _，不能有空格');
  if (store.get('SELECT 1 FROM bots WHERE name = ?', name)) throw new ServiceError(409, `已经有叫 ${name} 的 Bot 了`);
  const persona = String(b.persona ?? '').slice(0, 4000);
  const id = newId('bot');
  store.tx(() => {
    store.run('INSERT INTO bots(id, name, persona, model, max_turns, engine, created_at) VALUES (?,?,?,?,?,?,?)',
      id, name, persona, b.model || null, b.maxTurns ?? 30, engineOf(b.engine), now());
    store.emit('bot.created', { name }, { botId: id });
  });
  return store.get<BotRow>('SELECT * FROM bots WHERE id = ?', id)!;
}

export function botByName(store: Store, name: string): BotRow {
  const b = store.get<BotRow>('SELECT * FROM bots WHERE name = ?', name);
  if (!b) throw new ServiceError(404, `没有名为 ${name} 的 Bot`);
  return b;
}

/** 发消息。interrupt=true 时先打断正在跑的一轮，新消息排在它后面（"打断并发送"）。
 *  这个 Bot 还没回答的选择卡，都以这条消息作为回答。 */
export function sendMessage(store: Store, runner: Runner, botName: string, text: string, opts: { interrupt?: boolean } = {}) {
  const bot = botByName(store, botName);
  if (!text?.trim()) throw new ServiceError(400, '消息不能为空');
  let interrupted: string | null = null;
  if (opts.interrupt) {
    const running = store.get<RunRow>("SELECT * FROM runs WHERE bot_id = ? AND status = 'running'", bot.id);
    if (running && runner.interrupt(running.id, '用户打断并插话')) interrupted = running.id;
  }
  store.tx(() => {
    for (const a of store.all<AskRow>('SELECT * FROM asks WHERE bot_id = ? AND answered_at IS NULL', bot.id)) {
      store.run('UPDATE asks SET answer = ?, answered_at = ? WHERE id = ?', text, now(), a.id);
      store.emit('ask.answered', { askId: a.id, answer: text }, { botId: bot.id, threadId: a.thread_id, runId: a.run_id });
    }
  });
  return { interrupted, ...runner.enqueue(bot.id, text) };
}

/** 新会话：正在跑的一轮先停下，然后换一条新的 Claude Code session。记忆不受影响。 */
export function newSession(store: Store, runner: Runner, botName: string, by: string) {
  const bot = botByName(store, botName);
  const running = store.get<RunRow>("SELECT * FROM runs WHERE bot_id = ? AND status = 'running'", bot.id);
  if (running) runner.interrupt(running.id, '用户开了新会话');
  return runner.newSession(bot.id, by);
}

export function botStatus(store: Store, botId: string): BotStatus {
  const has = (sql: string) => !!store.get(sql, botId);
  const running = store.get<{ id: string }>("SELECT id FROM runs WHERE bot_id = ? AND status = 'running'", botId);
  if (running) {
    // 最近一次工具调用是屏幕 / 浏览器：正在用电脑
    const t = store.get<{ tool: string }>('SELECT tool FROM actions WHERE run_id = ? ORDER BY created_at DESC LIMIT 1', running.id);
    return t && /^mcp__(screen|browser)__/.test(t.tool) ? 'computer' : 'working';
  }
  if (has('SELECT 1 FROM asks WHERE bot_id = ? AND answered_at IS NULL')) return 'asking';
  if (has("SELECT 1 FROM assignments WHERE from_bot = ? AND status IN ('queued', 'asking') AND delivered_at IS NULL")) return 'waiting';
  const last = store.get<{ status: string }>('SELECT status FROM runs WHERE bot_id = ? ORDER BY started_at DESC LIMIT 1', botId);
  return last?.status === 'failed' ? 'failed' : 'idle';
}

/** 远程客户端打开时用的快照：名单 + 当前事件游标 */
export function snapshot(store: Store) {
  return {
    bots: store.all<BotRow>('SELECT * FROM bots ORDER BY created_at').map((b) => {
      const last = store.get<{ ts: string; type: string; data: string }>(
        "SELECT ts, type, data FROM events WHERE bot_id = ? AND type IN ('assistant.text', 'message.queued') ORDER BY seq DESC LIMIT 1", b.id);
      return {
        id: b.id, name: b.name, persona: b.persona, model: b.model, engine: engineOf(b.engine), createdAt: b.created_at, status: botStatus(store, b.id), waitingOn: waitingOn(store, b.id),
        lastText: last ? String(JSON.parse(last.data).text ?? '').slice(0, 120) : null,
        lastAt: last?.ts ?? null,
      };
    }),
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

// ---- Agent 记忆（用户在"它记得什么"面板里查看和修改） ----

export function agentMemory(store: Store, botName: string) {
  const bot = botByName(store, botName);
  return [...readAgentFiles(agentMemoryDir(bot.id))].map(([file, content]) => ({ file, content }));
}

export function editAgentMemory(store: Store, botName: string, file: string, content: string | null, by: string) {
  const bot = botByName(store, botName);
  const dir = agentMemoryDir(bot.id);
  const before = readAgentFiles(dir);
  if (content === null) {
    if (!deleteAgentFile(dir, file)) throw new ServiceError(404, `没有 ${file}`);
  } else {
    writeAgentFile(dir, file, content);
  }
  const changes = diffFiles(before, readAgentFiles(dir));
  store.tx(() => {
    for (const ch of changes) store.emit('memory.updated', { scope: 'agent', ...ch, by }, { botId: bot.id });
  });
  return { ok: true };
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

// SQLite 存储 + 事务性事件 outbox：状态变更与事件在同一事务里写入，提交后才通知订阅者。
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { EventType, PagentEvent } from '../../protocol/src/types.ts';

export const bus = new EventEmitter();
bus.setMaxListeners(0);

export const newId = (prefix: string) => `${prefix}_${randomBytes(6).toString('hex')}`;
export const now = () => new Date().toISOString();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, persona TEXT NOT NULL DEFAULT '',
  model TEXT, policy TEXT NOT NULL DEFAULT '[]', max_turns INTEGER NOT NULL DEFAULT 30,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), session_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL REFERENCES threads(id),
  content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', run_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), bot_id TEXT NOT NULL,
  status TEXT NOT NULL, hook_token TEXT NOT NULL, interrupt_requested INTEGER NOT NULL DEFAULT 0,
  num_turns INTEGER, cost_usd REAL, usage TEXT, result TEXT, error TEXT,
  started_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), tool_use_id TEXT,
  tool TEXT NOT NULL, input TEXT NOT NULL, side_effect INTEGER NOT NULL,
  status TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), action_id TEXT NOT NULL REFERENCES actions(id),
  tool TEXT NOT NULL, input_hash TEXT NOT NULL, summary TEXT NOT NULL, status TEXT NOT NULL,
  expires_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, bot_id TEXT, thread_id TEXT, run_id TEXT,
  type TEXT NOT NULL, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY, version TEXT NOT NULL, manifest TEXT NOT NULL, dir TEXT NOT NULL, hash TEXT NOT NULL,
  installed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_plugins (
  bot_id TEXT NOT NULL REFERENCES bots(id), plugin_id TEXT NOT NULL REFERENCES plugins(id),
  granted TEXT NOT NULL, enabled_at TEXT NOT NULL, PRIMARY KEY (bot_id, plugin_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, status);
CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id, status);
CREATE INDEX IF NOT EXISTS idx_actions_run ON actions(run_id, tool_use_id);
`;

export interface EventRef { botId?: string | null; threadId?: string | null; runId?: string | null }

export class Store {
  readonly db: DatabaseSync;
  private pending: PagentEvent[] = [];
  private inTx = false;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    this.db.exec(SCHEMA);
  }

  /** 同步事务；嵌套调用并入外层事务。事件在提交后才广播。 */
  tx<T>(fn: () => T): T {
    if (this.inTx) return fn();
    this.inTx = true;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      const evs = this.pending;
      this.pending = [];
      this.inTx = false;
      for (const e of evs) bus.emit('event', e);
      return r;
    } catch (err) {
      this.db.exec('ROLLBACK');
      this.pending = [];
      this.inTx = false;
      throw err;
    }
  }

  emit(type: EventType, data: Record<string, unknown>, ref: EventRef = {}): void {
    this.tx(() => {
      const ts = now();
      const r = this.run(
        'INSERT INTO events(ts, bot_id, thread_id, run_id, type, data) VALUES (?,?,?,?,?,?)',
        ts, ref.botId ?? null, ref.threadId ?? null, ref.runId ?? null, type, JSON.stringify(data),
      );
      this.pending.push({
        seq: Number(r.lastInsertRowid), ts, botId: ref.botId ?? null, threadId: ref.threadId ?? null,
        runId: ref.runId ?? null, type, data,
      });
    });
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
  run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }

  eventsAfter(seq: number, limit = 500): PagentEvent[] {
    return this.all<EventRow>('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?', seq, limit).map(toEvent);
  }
}

interface EventRow { seq: number; ts: string; bot_id: string | null; thread_id: string | null; run_id: string | null; type: string; data: string }
const toEvent = (r: EventRow): PagentEvent => ({
  seq: r.seq, ts: r.ts, botId: r.bot_id, threadId: r.thread_id, runId: r.run_id,
  type: r.type as PagentEvent['type'], data: JSON.parse(r.data),
});

// ---- 行类型 ----
export interface BotRow { id: string; name: string; persona: string; model: string | null; policy: string; max_turns: number; created_at: string }
export interface ThreadRow { id: string; bot_id: string; session_id: string | null; created_at: string }
export interface RunRow {
  id: string; thread_id: string; bot_id: string; status: string; hook_token: string; interrupt_requested: number;
  num_turns: number | null; cost_usd: number | null; usage: string | null; result: string | null; error: string | null;
  started_at: string; ended_at: string | null;
}
export interface ActionRow { id: string; run_id: string; tool_use_id: string | null; tool: string; input: string; side_effect: number; status: string; reason: string | null; created_at: string; updated_at: string }
export interface ApprovalRow { id: string; run_id: string; action_id: string; tool: string; input_hash: string; summary: string; status: string; expires_at: string; decided_by: string | null; decided_at: string | null; created_at: string }

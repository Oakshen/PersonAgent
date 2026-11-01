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
  created_at TEXT NOT NULL, archived_at TEXT, mem_base TEXT, mem_delivered TEXT
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
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, text TEXT NOT NULL, source_bot_id TEXT, source_run_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS asks (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), bot_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  question TEXT NOT NULL, options TEXT NOT NULL, allow_custom INTEGER NOT NULL,
  answer TEXT, created_at TEXT NOT NULL, answered_at TEXT
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
CREATE TABLE IF NOT EXISTS pairings (
  code_hash TEXT PRIMARY KEY, name TEXT NOT NULL, scopes TEXT NOT NULL, expires_at TEXT NOT NULL,
  used_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, public_key TEXT NOT NULL, scopes TEXT NOT NULL,
  created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS device_sessions (
  token_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, name TEXT NOT NULL, prompt TEXT NOT NULL,
  schedule TEXT, webhook_token TEXT UNIQUE, enabled INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL,
  created_at TEXT NOT NULL, last_fired_at TEXT, next_at TEXT
);
CREATE TABLE IF NOT EXISTS secrets (
  name TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL, note TEXT,
  updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY, device_id TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, members TEXT NOT NULL, manager_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_bot ON events(bot_id, seq);
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
    this.migrate();
  }

  /** 给旧库补列：只加不改，加列都带默认值 */
  private migrate(): void {
    const add: [string, string, string][] = [
      ['bots', 'daily_turn_budget', 'INTEGER NOT NULL DEFAULT 300'],
      ['bots', 'max_run_seconds', 'INTEGER NOT NULL DEFAULT 1800'],
      ['bots', 'max_actions', 'INTEGER NOT NULL DEFAULT 100'],
      ['threads', 'archived_at', 'TEXT'],
      ['threads', 'mem_base', 'TEXT'],
      ['threads', 'mem_delivered', 'TEXT'],
      ['runs', 'final', 'TEXT'],
      ['messages', 'meta', 'TEXT'],
      ['devices', 'local_exec', "TEXT NOT NULL DEFAULT 'off'"],
      ['devices', 'local_root', 'TEXT'],
      ['bots', 'engine', "TEXT NOT NULL DEFAULT 'claude'"],
      ['asks', 'kind', "TEXT NOT NULL DEFAULT 'choice'"],
    ];
    for (const [table, col, def] of add) {
      const cols = this.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
      if (!cols.includes(col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    }
  }

  /** 一致性快照（WAL 下也安全），不阻塞写入太久 */
  backup(file: string): void {
    this.db.prepare('VACUUM INTO ?').run(file);
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

  getKv(k: string): string | null {
    return this.get<{ v: string }>('SELECT v FROM kv WHERE k = ?', k)?.v ?? null;
  }
  setKv(k: string, v: string): void {
    this.run('INSERT INTO kv(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
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
export interface BotRow {
  id: string; name: string; persona: string; model: string | null; policy: string; max_turns: number; created_at: string;
  daily_turn_budget: number; max_run_seconds: number; max_actions: number;
  engine: string;   // claude | codex
}
// mem_base：会话第一轮写进系统提示的人设和记忆（会话期间不会再变）；mem_delivered：在此基础上又补发过的更新。都是 MemSnap JSON
export interface ThreadRow {
  id: string; bot_id: string; session_id: string | null; created_at: string; archived_at: string | null;
  mem_base: string | null; mem_delivered: string | null;
}
export interface RunRow {
  // hook_token：沿用旧列名，现在是这一轮访问 pagent MCP 的凭据
  id: string; thread_id: string; bot_id: string; status: string; hook_token: string; interrupt_requested: number;
  num_turns: number | null; cost_usd: number | null; usage: string | null; result: string | null; error: string | null;
  started_at: string; ended_at: string | null;
  final: string | null;   // claude 最后那条 result 消息（JSON），一到就落库，pagentd 重启也不丢
}
export interface ActionRow { id: string; run_id: string; tool_use_id: string | null; tool: string; input: string; side_effect: number; status: string; reason: string | null; created_at: string; updated_at: string }
export interface MemoryRow { id: string; text: string; source_bot_id: string | null; source_run_id: string | null; created_at: string; updated_at: string; deleted_at: string | null }
export interface AskRow { kind: string; id: string; run_id: string; bot_id: string; thread_id: string; question: string; options: string; allow_custom: number; answer: string | null; created_at: string; answered_at: string | null }

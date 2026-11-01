// 调度与执行：每个 Bot 同一时刻最多一个 Run；排队的消息合并成下一轮的输入。
// 每轮是一个 claude -p 进程（bypass 模式，不经任何审批），用 --resume 接上 Bot 当前会话。
// 工具调用记录直接取自输出流：用来显示步骤、做活动日志、限制每轮调用次数。
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { type ActionRow, type BotRow, type RunRow, type Store, type ThreadRow, newId, now } from './store.ts';
import { ensureWorker, execTurn, interruptTurn } from './docker.ts';
import { config } from './config.ts';
import { prepareRun } from './plugins.ts';
import { type MemSnap, diffFiles, listGlobal, promptOf, readAgentFiles, snap, updateBlock } from './memory.ts';
import type { RunStatus } from '../../protocol/src/types.ts';

interface Active {
  runId: string;
  container?: string;
  cancelKill?: () => void;
  actions: number;
  memDir: string;
  mem: Map<string, string>;     // 记忆目录上一次的快照，用来实时发现 Agent 改了记忆
  newSession?: string;          // Agent 要求这一轮结束后换新会话（原因）
}

interface ResultMsg {
  subtype: string; is_error: boolean; num_turns?: number; total_cost_usd?: number;
  usage?: unknown; result?: string; session_id?: string;
}

type Ref = { botId: string; threadId: string; runId: string };

// 只读工具：被打断时没回结果也不算"结果不明"
const READ_ONLY = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebSearch', 'WebFetch', 'TodoWrite', 'Skill', 'ToolSearch',
  'mcp__pagent__ask_user',
]);

export const agentMemoryDir = (botId: string) => join(config.dataDir, 'bots', botId, 'home', '.claude', 'memory');

/** 一行话描述一次工具调用（时间线和"结果不明"说明用） */
export function summarize(tool: string, input: Record<string, unknown>): string {
  const v = input.command ?? input.file_path ?? input.url ?? input.pattern ?? input.query;
  return typeof v === 'string' ? v.slice(0, 200) : JSON.stringify(input).slice(0, 200);
}

export class Runner {
  private active = new Map<string, Active>(); // botId → 正在跑的 run
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** Bot 当前的会话；没有就新建一条 */
  currentThread(botId: string): ThreadRow {
    return this.store.tx(() => {
      const t = this.store.get<ThreadRow>(
        'SELECT * FROM threads WHERE bot_id = ? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1', botId);
      if (t) return t;
      const id = newId('thr');
      this.store.run('INSERT INTO threads(id, bot_id, created_at) VALUES (?,?,?)', id, botId, now());
      return this.store.get<ThreadRow>('SELECT * FROM threads WHERE id = ?', id)!;
    });
  }

  enqueue(botId: string, text: string): { threadId: string; messageId: number; seq: number } {
    const out = this.store.tx(() => {
      const threadId = this.currentThread(botId).id;
      const r = this.store.run("INSERT INTO messages(thread_id, content, status, created_at) VALUES (?,?, 'queued', ?)", threadId, text, now());
      const messageId = Number(r.lastInsertRowid);
      this.store.emit('message.queued', { messageId, text }, { botId, threadId });
      return { threadId, messageId, seq: this.store.get<{ s: number }>('SELECT max(seq) s FROM events')!.s };
    });
    this.kick(botId);
    return out;
  }

  /** 换一条新会话：旧的归档，还没跑的消息挪到新会话；人设和记忆不受影响 */
  newSession(botId: string, by: string, reason = ''): { threadId: string } {
    const threadId = this.store.tx(() => {
      const old = this.currentThread(botId);
      const id = newId('thr');
      this.store.run('UPDATE threads SET archived_at = ? WHERE id = ?', now(), old.id);
      this.store.run('INSERT INTO threads(id, bot_id, created_at) VALUES (?,?,?)', id, botId, now());
      this.store.run("UPDATE messages SET thread_id = ? WHERE thread_id = ? AND status = 'queued'", id, old.id);
      // 旧会话里没回答的选择卡作废
      this.store.run('UPDATE asks SET answered_at = ? WHERE thread_id = ? AND answered_at IS NULL', now(), old.id);
      this.store.emit('session.new', { previous: old.id, by, reason }, { botId, threadId: id });
      return id;
    });
    return { threadId };
  }

  requestNewSession(runId: string, reason: string): void {
    for (const a of this.active.values()) if (a.runId === runId) a.newSession = reason || 'Agent 自己开的新会话';
  }

  kick(botId: string): void {
    if (this.active.has(botId)) return;
    this.start(botId).catch((e) => console.error('start run failed', botId, e));
  }

  private async start(botId: string): Promise<void> {
    if (this.active.has(botId)) return;
    const prep = this.store.tx(() => {
      const thread = this.currentThread(botId);
      const msgs = this.store.all<{ id: number; content: string }>(
        "SELECT id, content FROM messages WHERE thread_id = ? AND status = 'queued' ORDER BY id", thread.id);
      if (msgs.length === 0) return null;
      const bot = this.store.get<BotRow>('SELECT * FROM bots WHERE id = ?', botId)!;
      const prev = this.store.get<RunRow>('SELECT * FROM runs WHERE thread_id = ? ORDER BY started_at DESC LIMIT 1', thread.id);
      const runId = newId('run');
      const token = randomBytes(24).toString('hex');
      this.store.run(
        "INSERT INTO runs(id, thread_id, bot_id, status, hook_token, started_at) VALUES (?,?,?, 'running', ?, ?)",
        runId, thread.id, bot.id, token, now());
      for (const m of msgs) this.store.run("UPDATE messages SET status = 'consumed', run_id = ? WHERE id = ?", runId, m.id);
      this.store.emit('run.started', { messageIds: msgs.map((m) => m.id) }, { botId, threadId: thread.id, runId });
      // 每日预算：今天（UTC）已用轮次达到上限就不跑，这一轮直接以失败结束并说明原因
      const used = this.store.get<{ n: number }>(
        'SELECT coalesce(sum(num_turns), 0) n FROM runs WHERE bot_id = ? AND started_at >= ?',
        bot.id, new Date().toISOString().slice(0, 10))!.n;
      if (used >= bot.daily_turn_budget) {
        const error = `今天已经用了 ${used} 轮，达到每日上限 ${bot.daily_turn_budget}，明天（UTC）再继续`;
        this.store.run("UPDATE runs SET status = 'failed', ended_at = ?, error = ? WHERE id = ?", now(), error, runId);
        this.store.emit('run.finished', { status: 'failed', error, unconfirmed: [] }, { botId, threadId: thread.id, runId });
        return 'skipped' as const;
      }
      // 上一轮被打断、有操作结果不明：在这一轮开头告诉 Agent，让它自己核实
      const unknown = prev
        ? this.store.all<ActionRow>("SELECT * FROM actions WHERE run_id = ? AND status = 'unknown' ORDER BY created_at", prev.id)
        : [];
      const note = unknown.length
        ? `[系统说明] 上一轮被中断，下面这些操作已经开始执行但没等到结果，请先核实它们实际是否完成：\n${
          unknown.map((a) => `- ${a.tool}: ${summarize(a.tool, JSON.parse(a.input))}`).join('\n')}\n\n`
        : '';
      // 人设和记忆：新会话写进系统提示；老会话只补发变化（--resume 时新的系统提示不生效）
      const cur = snap(bot.persona, listGlobal(this.store), readAgentFiles(agentMemoryDir(bot.id)).get('MEMORY.md') ?? null);
      let sys: string | null = null;
      let update = '';
      if (!thread.session_id) {
        sys = promptOf(cur);
        this.store.run('UPDATE threads SET mem_base = ?, mem_delivered = ? WHERE id = ?', JSON.stringify(cur), JSON.stringify(cur), thread.id);
      } else {
        update = updateBlock(thread.mem_delivered ? JSON.parse(thread.mem_delivered) as MemSnap : null, cur);
        if (update) this.store.run('UPDATE threads SET mem_delivered = ? WHERE id = ?', JSON.stringify(cur), thread.id);
      }
      return { runId, token, thread, bot, sys, prompt: update + note + msgs.map((m) => m.content).join('\n\n') };
    });
    if (!prep) return;
    if (prep === 'skipped') return this.kick(botId);
    const { runId, token, thread, bot, sys, prompt } = prep;
    const memDir = agentMemoryDir(bot.id);
    mkdirSync(memDir, { recursive: true });
    const mem = readAgentFiles(memDir);
    const entry: Active = { runId, actions: 0, memDir, mem };
    this.active.set(botId, entry);
    const ref: Ref = { botId, threadId: thread.id, runId };

    let container: string;
    let plugins: Awaited<ReturnType<typeof prepareRun>>;
    try {
      [container, plugins] = await Promise.all([ensureWorker(bot.id), prepareRun(this.store, bot.id)]);
    } catch (e) {
      this.finish(ref, null, `启动 worker / 插件失败：${(e as Error).message}`);
      return;
    }
    if (plugins.stale.length) {
      this.store.emit('plugin.needs_consent', { plugins: plugins.stale, note: '插件权限已变化，需在服务器上重新启用后才会加载' }, ref);
    }
    entry.container = container;
    if (this.store.get<RunRow>('SELECT * FROM runs WHERE id = ?', runId)!.interrupt_requested) {
      this.finish(ref, null, null);
      return;
    }

    const mcpConfig = {
      mcpServers: {
        ...plugins.servers,
        pagent: {
          type: 'http', url: `http://${config.mcpHost}:${config.mcpPort}/mcp`,
          headers: { Authorization: `Bearer ${token}`, 'x-pagent-run': runId },
        },
      },
    };
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions',
      '--strict-mcp-config', '--mcp-config', JSON.stringify(mcpConfig),
      '--setting-sources', 'user', '--max-turns', String(bot.max_turns)];
    if (sys) args.push('--append-system-prompt', sys);
    for (const d of plugins.pluginDirs) args.push('--plugin-dir', d);
    if (bot.model) args.push('--model', bot.model);
    if (thread.session_id) args.push('--resume', thread.session_id);

    const child = execTurn(container, runId, { PAGENT_RUN_ID: runId }, args, prompt);

    let result: ResultMsg | null = null;
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000); });
    createInterface({ input: child.stdout }).on('line', (line) => {
      let m: any;
      try { m = JSON.parse(line); } catch { return; }
      if (m.type === 'result') result = m;
      else this.onMessage(ref, bot, entry, m);
    });
    const timer = setTimeout(() => this.interrupt(runId, `超过单轮时长上限 ${bot.max_run_seconds} 秒，已自动停止`), bot.max_run_seconds * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      entry.cancelKill?.();
      this.finish(ref, result, result ? null : `claude 退出码 ${code}：${stderr.trim().slice(-500)}`);
    });
  }

  private onMessage(ref: Ref, bot: BotRow, entry: Active, m: any): void {
    if (m.type === 'system' && m.subtype === 'init') {
      this.store.tx(() => {
        this.store.run('UPDATE threads SET session_id = ? WHERE id = ? AND session_id IS NULL', m.session_id, ref.threadId);
        this.store.emit('run.init', { sessionId: m.session_id, model: m.model, permissionMode: m.permissionMode, mcp: m.mcp_servers ?? [] }, ref);
      });
    } else if (m.type === 'system' && m.subtype === 'compact_boundary') {
      // 上下文被压缩：之前补发的记忆更新可能被概括掉了，下一轮从系统提示里的版本重新比对
      this.store.tx(() => {
        this.store.run('UPDATE threads SET mem_delivered = mem_base WHERE id = ?', ref.threadId);
        this.store.emit('session.compacted', { trigger: m.compact_metadata?.trigger ?? null, preTokens: m.compact_metadata?.pre_tokens ?? null }, ref);
      });
    } else if (m.type === 'assistant') {
      for (const c of m.message?.content ?? []) {
        if (c.type === 'text' && c.text) this.store.emit('assistant.text', { text: c.text }, ref);
        if (c.type !== 'tool_use') continue;
        this.store.tx(() => {
          this.store.run(
            `INSERT INTO actions(id, run_id, tool_use_id, tool, input, side_effect, status, created_at, updated_at)
             VALUES (?,?,?,?,?,?, 'running', ?, ?)`,
            newId('act'), ref.runId, c.id, c.name, JSON.stringify(c.input ?? {}).slice(0, 8000),
            READ_ONLY.has(c.name) ? 0 : 1, now(), now());
          this.store.emit('tool.use', { toolUseId: c.id, name: c.name, input: c.input, summary: summarize(c.name, c.input ?? {}) }, ref);
        });
        if (++entry.actions === bot.max_actions + 1) {
          this.interrupt(ref.runId, `这一轮的工具调用超过上限 ${bot.max_actions} 次，已自动停止`);
        }
      }
    } else if (m.type === 'user') {
      for (const c of m.message?.content ?? []) {
        if (c.type !== 'tool_result') continue;
        const text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
        this.store.tx(() => {
          // 被打断时 claude 会给在途工具回一条"用户拒绝"的错误，但命令可能已经开始执行：有副作用的记 unknown
          this.store.run(
            `UPDATE actions SET
               status = CASE WHEN ? = 0 THEN 'succeeded'
                             WHEN side_effect = 1 AND (SELECT interrupt_requested FROM runs WHERE id = ?) = 1 THEN 'unknown'
                             ELSE 'failed' END,
               reason = CASE WHEN ? = 0 THEN NULL ELSE ? END,
               updated_at = ?
             WHERE run_id = ? AND tool_use_id = ? AND status = 'running'`,
            c.is_error ? 1 : 0, ref.runId, c.is_error ? 1 : 0, text.slice(0, 200), now(), ref.runId, c.tool_use_id);
          this.store.emit('tool.result', { toolUseId: c.tool_use_id, isError: !!c.is_error, preview: text.slice(0, 500) }, ref);
        });
        this.scanMemory(ref, bot, entry);
      }
    }
  }

  /** Agent 改了自己的记忆文件（不管用的是 Write 还是 Bash）就发 memory.updated */
  private scanMemory(ref: Ref, bot: BotRow, entry: Active): void {
    const next = readAgentFiles(entry.memDir);
    const changes = diffFiles(entry.mem, next);
    entry.mem = next;
    if (!changes.length) return;
    this.store.tx(() => {
      for (const ch of changes) this.store.emit('memory.updated', { scope: 'agent', ...ch, by: bot.name }, ref);
    });
  }

  /** 一轮结束：定终态。没回结果的有副作用操作记 unknown，只留在时间线上，下一轮告诉 Agent。 */
  private finish(ref: Ref, result: ResultMsg | null, error: string | null): void {
    const entry = this.active.get(ref.botId);
    const bot = this.store.get<BotRow>('SELECT * FROM bots WHERE id = ?', ref.botId)!;
    if (entry?.runId === ref.runId) this.scanMemory(ref, bot, entry);
    this.store.tx(() => {
      const run = this.store.get<RunRow>('SELECT * FROM runs WHERE id = ?', ref.runId)!;
      if (run.status !== 'running') return;
      const unconfirmed = this.settleActions(ref.runId);
      let status: RunStatus;
      if (run.interrupt_requested) status = 'interrupted';
      else if (result && !result.is_error && result.subtype === 'success') status = 'succeeded';
      else status = 'failed';
      const err = run.error ?? error
        ?? (result && result.subtype !== 'success' ? result.subtype : null)
        ?? (result?.is_error ? (result.result ?? 'is_error').slice(0, 300) : null);  // 例如 API 层拒绝
      this.store.run(
        `UPDATE runs SET status = ?, ended_at = ?, num_turns = ?, cost_usd = ?, usage = ?, result = ?, error = ? WHERE id = ?`,
        status, now(), result?.num_turns ?? null, result?.total_cost_usd ?? null,
        result?.usage ? JSON.stringify(result.usage) : null, result?.result ?? null, err, ref.runId);
      this.store.emit('run.finished', {
        status, numTurns: result?.num_turns ?? null, costUsd: result?.total_cost_usd ?? null, unconfirmed, error: err,
      }, ref);
      this.markOwnMemoryDelivered(ref);
    });
    if (entry?.runId === ref.runId) {
      if (entry.newSession) this.newSession(ref.botId, bot.name, entry.newSession);
      this.active.delete(ref.botId);
    }
    this.kick(ref.botId);
  }

  /** Agent 这一轮自己写的记忆它已经知道了，算作已送达，下一轮不再补发 */
  private markOwnMemoryDelivered(ref: Ref): void {
    const t = this.store.get<ThreadRow>('SELECT * FROM threads WHERE id = ?', ref.threadId)!;
    if (!t.mem_delivered) return;
    const d = JSON.parse(t.mem_delivered) as MemSnap;
    d.index = (readAgentFiles(agentMemoryDir(ref.botId)).get('MEMORY.md') ?? '').trim();
    for (const m of this.store.all<{ id: string; text: string }>(
      'SELECT id, text FROM memories WHERE source_run_id = ? AND deleted_at IS NULL', ref.runId)) d.globals[m.id] = m.text;
    this.store.run('UPDATE threads SET mem_delivered = ? WHERE id = ?', JSON.stringify(d), ref.threadId);
  }

  /** 还在 running 的操作收尾：有副作用的记 unknown，其余记 failed。返回结果不明的操作摘要。 */
  private settleActions(runId: string): { tool: string; summary: string }[] {
    this.store.run(
      "UPDATE actions SET status = CASE WHEN side_effect = 1 THEN 'unknown' ELSE 'failed' END, reason = '没等到结果', updated_at = ? WHERE run_id = ? AND status = 'running'",
      now(), runId);
    return this.store.all<ActionRow>("SELECT * FROM actions WHERE run_id = ? AND status = 'unknown' ORDER BY created_at", runId)
      .map((a) => ({ tool: a.tool, summary: summarize(a.tool, JSON.parse(a.input)) }));
  }

  interrupt(runId: string, reason?: string): boolean {
    const run = this.store.get<RunRow>('SELECT * FROM runs WHERE id = ?', runId);
    if (!run || run.status !== 'running') return false;
    this.store.run('UPDATE runs SET interrupt_requested = 1, error = coalesce(?, error) WHERE id = ?', reason ?? null, runId);
    const entry = this.active.get(run.bot_id);
    if (entry?.runId === runId && entry.container) entry.cancelKill = interruptTurn(entry.container, runId);
    return true;
  }

  /** pagentd 启动时对账：上次退出时还在跑的 Run 记为中断，结果不明的操作留给下一轮的 Agent 核实。 */
  recover(): void {
    const stale = this.store.all<RunRow>("SELECT * FROM runs WHERE status = 'running'");
    for (const run of stale) {
      this.store.tx(() => {
        const unconfirmed = this.settleActions(run.id);
        const error = 'pagentd 重启时这一轮还在运行';
        this.store.run("UPDATE runs SET status = 'interrupted', ended_at = ?, error = ? WHERE id = ?", now(), error, run.id);
        this.store.emit('run.finished', { status: 'interrupted', unconfirmed, error }, { botId: run.bot_id, threadId: run.thread_id, runId: run.id });
      });
      // 容器里可能还有残留进程
      ensureWorker(run.bot_id).then((c) => interruptTurn(c, run.id, 2000)).catch(() => {});
    }
    const bots = this.store.all<{ bot_id: string }>(
      "SELECT DISTINCT t.bot_id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.status = 'queued'");
    for (const b of bots) this.kick(b.bot_id);
    if (stale.length) console.log(`recover: ${stale.length} 个中断的 run 已对账`);
  }

  activeRuns(): string[] {
    return [...this.active.values()].map((a) => a.runId);
  }
}

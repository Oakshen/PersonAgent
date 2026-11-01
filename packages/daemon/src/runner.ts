// 调度与执行：每个 Thread 同一时刻最多一个 Run；排队的消息合并成下一轮的输入。
// 每轮是一个 claude -p 进程，用 --resume 接上 Thread 的会话。
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { type BotRow, type RunRow, type Store, type ThreadRow, newId, now } from './store.ts';
import { ensureWorker, execTurn, interruptTurn } from './docker.ts';
import { config } from './config.ts';
import type { Approvals } from './approvals.ts';
import { prepareRun } from './plugins.ts';
import type { RunStatus } from '../../protocol/src/types.ts';

interface Active { runId: string; container?: string; cancelKill?: () => void }

interface ResultMsg {
  subtype: string; is_error: boolean; num_turns?: number; total_cost_usd?: number;
  usage?: unknown; result?: string; session_id?: string;
}

export class Runner {
  private active = new Map<string, Active>(); // threadId → 正在跑的 run

  private store: Store;
  private approvals: Approvals;

  constructor(store: Store, approvals: Approvals) {
    this.store = store;
    this.approvals = approvals;
  }

  enqueue(threadId: string, text: string): { messageId: number; seq: number } {
    let out!: { messageId: number; seq: number };
    this.store.tx(() => {
      const t = this.store.get<ThreadRow>('SELECT * FROM threads WHERE id = ?', threadId)!;
      const r = this.store.run("INSERT INTO messages(thread_id, content, status, created_at) VALUES (?,?, 'queued', ?)", threadId, text, now());
      const messageId = Number(r.lastInsertRowid);
      this.store.emit('message.queued', { messageId, text }, { botId: t.bot_id, threadId });
      out = { messageId, seq: this.store.get<{ s: number }>('SELECT max(seq) s FROM events')!.s };
    });
    this.kick(threadId);
    return out;
  }

  kick(threadId: string): void {
    if (this.active.has(threadId)) return;
    this.start(threadId).catch((e) => console.error('start run failed', threadId, e));
  }

  private async start(threadId: string): Promise<void> {
    if (this.active.has(threadId)) return;
    const prep = this.store.tx(() => {
      const msgs = this.store.all<{ id: number; content: string }>(
        "SELECT id, content FROM messages WHERE thread_id = ? AND status = 'queued' ORDER BY id", threadId);
      if (msgs.length === 0) return null;
      const thread = this.store.get<ThreadRow>('SELECT * FROM threads WHERE id = ?', threadId)!;
      const bot = this.store.get<BotRow>('SELECT * FROM bots WHERE id = ?', thread.bot_id)!;
      const runId = newId('run');
      const token = randomBytes(24).toString('hex');
      this.store.run(
        "INSERT INTO runs(id, thread_id, bot_id, status, hook_token, started_at) VALUES (?,?,?, 'running', ?, ?)",
        runId, threadId, bot.id, token, now());
      for (const m of msgs) this.store.run("UPDATE messages SET status = 'consumed', run_id = ? WHERE id = ?", runId, m.id);
      this.store.emit('run.started', { messageIds: msgs.map((m) => m.id) }, { botId: bot.id, threadId, runId });
      // 每日预算：今天（UTC）已用轮次达到上限就不跑，这一轮直接以 budget_exceeded 结束
      const used = this.store.get<{ n: number }>(
        'SELECT coalesce(sum(num_turns), 0) n FROM runs WHERE bot_id = ? AND started_at >= ?',
        bot.id, new Date().toISOString().slice(0, 10))!.n;
      if (used >= bot.daily_turn_budget) {
        const error = `budget_exceeded：今日已用 ${used} 轮，上限 ${bot.daily_turn_budget}`;
        this.store.run("UPDATE runs SET status = 'failed', ended_at = ?, error = ? WHERE id = ?", now(), error, runId);
        this.store.emit('run.finished', { status: 'failed', error, unknownActions: 0 }, { botId: bot.id, threadId, runId });
        return 'skipped' as const;
      }
      return { runId, token, thread, bot, prompt: msgs.map((m) => m.content).join('\n\n') };
    });
    if (!prep) return;
    if (prep === 'skipped') return this.kick(threadId);
    const { runId, token, thread, bot, prompt } = prep;
    const entry: Active = { runId };
    this.active.set(threadId, entry);
    const ref = { botId: bot.id, threadId, runId };

    let container: string;
    let plugins: Awaited<ReturnType<typeof prepareRun>>;
    try {
      [container, plugins] = await Promise.all([ensureWorker(bot.id), prepareRun(this.store, bot.id)]);
    } catch (e) {
      this.finish(ref, null, `启动 worker / 插件失败：${(e as Error).message}`);
      return;
    }
    if (plugins.stale.length) {
      this.store.emit('plugin.needs_consent', { plugins: plugins.stale, note: '插件权限已变化，需重新启用后才会加载' }, ref);
    }
    entry.container = container;
    if (this.store.get<RunRow>('SELECT * FROM runs WHERE id = ?', runId)!.interrupt_requested) {
      this.finish(ref, null, null);
      return;
    }

    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default',
      '--strict-mcp-config', '--mcp-config', plugins.mcpConfig,
      '--setting-sources', 'user', '--max-turns', String(bot.max_turns)];
    for (const d of plugins.pluginDirs) args.push('--plugin-dir', d);
    if (bot.model) args.push('--model', bot.model);
    if (bot.persona) args.push('--append-system-prompt', bot.persona);
    if (thread.session_id) args.push('--resume', thread.session_id);

    const child = execTurn(container, runId, {
      PAGENT_RUN_ID: runId,
      PAGENT_HOOK_TOKEN: token,
      PAGENT_HOOK_URL: `http://${config.hookHost}:${config.hookPort}`,
    }, args, prompt);

    let result: ResultMsg | null = null;
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000); });
    createInterface({ input: child.stdout }).on('line', (line) => {
      let m: any;
      try { m = JSON.parse(line); } catch { return; }
      if (m.type === 'result') result = m;
      else this.onMessage(ref, m);
    });
    const timer = setTimeout(() => this.interrupt(runId, `timeout：超过单轮上限 ${bot.max_run_seconds} 秒`), bot.max_run_seconds * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      entry.cancelKill?.();
      this.finish(ref, result, result ? null : `claude 退出码 ${code}：${stderr.trim().slice(-500)}`);
    });
  }

  private onMessage(ref: { botId: string; threadId: string; runId: string }, m: any): void {
    if (m.type === 'system' && m.subtype === 'init') {
      this.store.tx(() => {
        this.store.run('UPDATE threads SET session_id = ? WHERE id = ? AND session_id IS NULL', m.session_id, ref.threadId);
        this.store.emit('run.init', { sessionId: m.session_id, model: m.model, mcp: m.mcp_servers ?? [] }, ref);
      });
    } else if (m.type === 'assistant') {
      for (const c of m.message?.content ?? []) {
        if (c.type === 'text' && c.text) this.store.emit('assistant.text', { text: c.text }, ref);
        if (c.type === 'tool_use') this.store.emit('tool.use', { toolUseId: c.id, name: c.name, input: c.input }, ref);
      }
    } else if (m.type === 'user') {
      for (const c of m.message?.content ?? []) {
        if (c.type !== 'tool_result') continue;
        const text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
        this.store.tx(() => {
          // tool_result 出现即说明工具已结束；出错的工具不一定触发 PostToolUse，以这里为准。
          // 被中断时 claude 会给在途工具回一条"用户拒绝"的错误，但命令其实已经开始执行：有副作用的记 unknown
          this.store.run(
            `UPDATE actions SET
               status = CASE WHEN ? = 0 THEN 'succeeded'
                             WHEN side_effect = 1 AND (SELECT interrupt_requested FROM runs WHERE id = ?) = 1 THEN 'unknown'
                             ELSE 'failed' END,
               reason = CASE WHEN ? = 0 THEN reason ELSE ? END,
               updated_at = ?
             WHERE run_id = ? AND tool_use_id = ? AND status = 'approved'`,
            c.is_error ? 1 : 0, ref.runId, c.is_error ? 1 : 0, text.slice(0, 200), now(), ref.runId, c.tool_use_id);
          this.store.emit('tool.result', { toolUseId: c.tool_use_id, isError: !!c.is_error, preview: text.slice(0, 500) }, ref);
        });
      }
    }
  }

  /** 一轮结束：定终态；已放行但没收到完成回执的副作用操作标为 unknown，绝不自动重试。 */
  private finish(ref: { botId: string; threadId: string; runId: string }, result: ResultMsg | null, error: string | null): void {
    this.approvals.cancelRun(ref.runId);
    this.store.tx(() => {
      const run = this.store.get<RunRow>('SELECT * FROM runs WHERE id = ?', ref.runId)!;
      if (run.status !== 'running') return;
      this.markUnknownActions(ref.runId);
      const unknown = this.store.get<{ n: number }>("SELECT count(*) n FROM actions WHERE run_id = ? AND status = 'unknown'", ref.runId)!.n;
      let status: RunStatus;
      if (unknown > 0) status = 'unknown';
      else if (run.interrupt_requested) status = 'interrupted';
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
        status, numTurns: result?.num_turns ?? null, costUsd: result?.total_cost_usd ?? null, unknownActions: unknown, error: err,
      }, ref);
    });
    this.active.delete(ref.threadId);
    this.kick(ref.threadId);
  }

  private markUnknownActions(runId: string): number {
    const r = this.store.run(
      "UPDATE actions SET status = 'unknown', reason = '执行结果未确认', updated_at = ? WHERE run_id = ? AND status = 'approved' AND side_effect = 1",
      now(), runId);
    this.store.run(
      "UPDATE actions SET status = 'failed', reason = '未完成', updated_at = ? WHERE run_id = ? AND status IN ('approved', 'pending_approval')",
      now(), runId);
    return Number(r.changes);
  }

  interrupt(runId: string, reason?: string): boolean {
    const run = this.store.get<RunRow>('SELECT * FROM runs WHERE id = ?', runId);
    if (!run || run.status !== 'running') return false;
    this.store.run('UPDATE runs SET interrupt_requested = 1, error = coalesce(?, error) WHERE id = ?', reason ?? null, runId);
    const entry = this.active.get(run.thread_id);
    // 先发信号，再取消审批：反过来的话 hook 拿到"拒绝"后 claude 会继续下一步
    if (entry?.container) entry.cancelKill = interruptTurn(entry.container, runId);
    this.approvals.cancelRun(runId);
    return true;
  }

  /** pagentd 启动时对账：上次退出时还在跑的 Run 不再可信，副作用状态不明的进 unknown。 */
  recover(): void {
    const stale = this.store.all<RunRow>("SELECT * FROM runs WHERE status = 'running'");
    for (const run of stale) {
      this.store.run("UPDATE approvals SET status = 'cancelled', decided_by = 'recovery', decided_at = ? WHERE run_id = ? AND status = 'pending'", now(), run.id);
      this.store.tx(() => {
        const unknown = this.markUnknownActions(run.id);
        const status: RunStatus = unknown > 0 ? 'unknown' : 'interrupted';
        const error = 'pagentd 重启时该轮仍在运行';
        this.store.run('UPDATE runs SET status = ?, ended_at = ?, error = ? WHERE id = ?', status, now(), error, run.id);
        this.store.emit('run.finished', { status, unknownActions: unknown, error }, { botId: run.bot_id, threadId: run.thread_id, runId: run.id });
      });
      // 容器里可能还有残留进程
      ensureWorker(run.bot_id).then((c) => interruptTurn(c, run.id, 2000)).catch(() => {});
    }
    const threads = this.store.all<{ thread_id: string }>("SELECT DISTINCT thread_id FROM messages WHERE status = 'queued'");
    for (const t of threads) this.kick(t.thread_id);
    if (stale.length) console.log(`recover: ${stale.length} 个中断的 run 已对账`);
  }

  activeRuns(): string[] {
    return [...this.active.values()].map((a) => a.runId);
  }
}

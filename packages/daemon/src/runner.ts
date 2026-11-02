// 调度与执行：每个 Bot 同一时刻最多一个 Run；排队的消息合并成下一轮的输入。
// 每轮交给盒子里的网关跑一个 claude -p（bypass 模式，不经任何审批，--resume 接上 Bot 当前会话），
// 输出经网关事件流回来（BoxLink → onBoxEvent）。pagentd 重启不影响盒子里的轮次，回来后按游标补齐。
// 工具调用记录直接取自输出流：用来显示步骤、做活动日志、限制每轮调用次数。
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type ActionRow, type BotRow, type RunRow, type Store, type ThreadRow, newId, now } from './store.ts';
import { type Box, type BoxEvent, agentDirInBox, agentDirOnHost, ensureBox, gw } from './box.ts';
import { config } from './config.ts';
import { prepareRun } from './plugins.ts';
import { type CodexState, codexState, engineOf, fromCodex } from './engines.ts';
import { allSecrets, redactor } from './vault.ts';
import { type EnvelopeMeta, block, envelopeKey, escapeTags, render } from './envelope.ts';
import { NO_NEWS } from './routines.ts';
import { type MemSnap, diffFiles, guideFor, listGlobal, promptOf, readAgentFiles, snap, updateBlock } from './memory.ts';
import type { RunStatus } from '../../protocol/src/types.ts';

interface Active {
  runId: string;
  boot?: string;                // 接手这一轮的盒子的 boot；还没交给盒子时为空
  actions: number;
  memDir: string;
  mem: Map<string, string>;     // 记忆目录上一次的快照，用来实时发现 Agent 改了记忆
  newSession?: string;          // Agent 要求这一轮结束后换新会话（原因）
  codex?: CodexState;           // Codex 引擎：输出翻译状态
  redact?: (t: string) => string; // 遮住保险箱里的值（写进时间线之前）
}

interface ResultMsg {
  subtype: string; is_error: boolean; num_turns?: number; total_cost_usd?: number;
  usage?: unknown; result?: string; session_id?: string;
}

export type Ref = { botId: string; threadId: string; runId: string };

// 只读工具：被打断时没回结果也不算"结果不明"
const READ_ONLY = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebSearch', 'WebFetch', 'TodoWrite', 'Skill', 'ToolSearch',
  'mcp__pagent__ask_user',
]);

export const agentMemoryDir = (botId: string) => join(agentDirOnHost(botId), 'memory');

/** 一行话描述一次工具调用（时间线和"结果不明"说明用） */
export function summarize(tool: string, input: Record<string, unknown>): string {
  const v = input.command ?? input.file_path ?? input.url ?? input.pattern ?? input.query;
  return typeof v === 'string' ? v.slice(0, 200) : JSON.stringify(input).slice(0, 200);
}

export class Runner {
  private active = new Map<string, Active>(); // botId → 正在跑的 run
  private store: Store;
  /** 一轮结束后的扩展点（Agent 之间回传结果用） */
  hooks: { afterRun?: (ref: Ref, bot: BotRow, status: RunStatus, text: string, metas: any[]) => void } = {};

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

  /** meta：消息从哪来（Routine、别的 Agent、群聊），时间线据此显示，结束时据此通知 / 回传 */
  enqueue(botId: string, text: string, meta?: Record<string, unknown>): { threadId: string; messageId: number; seq: number } {
    const out = this.store.tx(() => {
      const threadId = this.currentThread(botId).id;
      const r = this.store.run("INSERT INTO messages(thread_id, content, status, created_at, meta) VALUES (?,?, 'queued', ?, ?)",
        threadId, text, now(), meta ? JSON.stringify(meta) : null);
      const messageId = Number(r.lastInsertRowid);
      this.store.emit('message.queued', { messageId, text, ...(meta ? { meta } : {}) }, { botId, threadId });
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
      const msgs = this.store.all<{ id: number; content: string; meta: string | null }>(
        "SELECT id, content, meta FROM messages WHERE thread_id = ? AND status = 'queued' ORDER BY id", thread.id);
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
      const key = envelopeKey(this.store);
      const note = unknown.length
        ? `${block(key, 'pagent-msg', { from: 'system' }, { note: `上一轮被中断，下面这些操作已经开始执行但没等到结果，请先核实它们实际是否完成：\n${
          escapeTags(unknown.map((a) => `- ${a.tool}: ${summarize(a.tool, JSON.parse(a.input))}`).join('\n'))}` })}\n\n`
        : '';
      // 人设和记忆：新会话写进系统提示；老会话只补发变化（--resume 时新的系统提示不生效）
      const cur = snap(bot.persona, guideFor(bot.name, `${agentDirInBox(bot.id)}/memory`, key), listGlobal(this.store),
        readAgentFiles(agentMemoryDir(bot.id)).get('MEMORY.md') ?? null);
      let sys: string | null = null;
      let update = '';
      if (!thread.session_id) {
        sys = promptOf(cur);
        this.store.run('UPDATE threads SET mem_base = ?, mem_delivered = ? WHERE id = ?', JSON.stringify(cur), JSON.stringify(cur), thread.id);
      } else {
        update = updateBlock(thread.mem_delivered ? JSON.parse(thread.mem_delivered) as MemSnap : null, cur, key);
        if (update) this.store.run('UPDATE threads SET mem_delivered = ? WHERE id = ?', JSON.stringify(cur), thread.id);
      }
      const body = msgs.map((m) => render(key, m.content, m.meta ? JSON.parse(m.meta) as EnvelopeMeta : null, NO_NEWS)).join('\n\n');
      return { runId, token, thread, bot, sys, key, prompt: update + note + body };
    });
    if (!prep) return;
    if (prep === 'skipped') return this.kick(botId);
    const { runId, token, thread, bot, key } = prep;
    const engine = engineOf(bot.engine);
    let { sys, prompt } = prep;
    // Codex 没有追加系统提示的参数：新会话第一轮把人设和记忆放在消息开头（之后照样只补发变化）
    if (engine === 'codex' && sys) {
      prompt = `<pagent-context key="${key}">\n以下是你的人设、工作方式和记忆，以此为准。\n\n${sys}\n</pagent-context>\n\n${prompt}`;
      sys = null;
    }
    const memDir = agentMemoryDir(bot.id);
    mkdirSync(memDir, { recursive: true });
    const mem = readAgentFiles(memDir);
    const entry: Active = { runId, actions: 0, memDir, mem };
    this.active.set(botId, entry);
    const ref: Ref = { botId, threadId: thread.id, runId };

    let box: Box;
    let plugins: Awaited<ReturnType<typeof prepareRun>>;
    try {
      [box, plugins] = await Promise.all([ensureBox(), prepareRun(this.store, bot.id)]);
    } catch (e) {
      this.finish(ref, `启动盒子 / 插件失败：${(e as Error).message}`);
      return;
    }
    if (plugins.stale.length) {
      this.store.emit('plugin.needs_consent', { plugins: plugins.stale, note: '插件权限已变化，需在服务器上重新启用后才会加载' }, ref);
    }
    if (this.interruptRequested(runId)) {
      this.finish(ref, null);
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
    entry.redact = redactor(allSecrets(this.store));
    try {
      const r = await gw<{ boot: string }>(box, 'POST', '/api/runTurn', {
        engine, agentId: bot.id, runId, prompt, systemPrompt: sys, sessionId: thread.session_id, mcpConfig,
        model: bot.model, maxTurns: bot.max_turns, pluginDirs: plugins.pluginDirs, maxSeconds: bot.max_run_seconds,
      });
      entry.boot = r.boot;
    } catch (e) {
      this.sendInterrupt(runId);   // 万一网关其实已经启动了
      this.finish(ref, `交给盒子失败：${(e as Error).message}`);
      return;
    }
    // 交给盒子的途中被要求中断：现在补发
    if (this.interruptRequested(runId)) this.sendInterrupt(runId);
  }

  private interruptRequested(runId: string): boolean {
    return !!this.store.get<RunRow>('SELECT * FROM runs WHERE id = ?', runId)!.interrupt_requested;
  }

  /** 盒子事件流里的一条（在 BoxLink 的事务里调用，和游标一起提交） */
  onBoxEvent(ev: BoxEvent): void {
    if (ev.type === 'engine.codex') {
      this.store.emit('engine.changed', { engine: 'codex', status: ev.data.status }, {});
      return;
    }
    const runId = ev.data?.runId;
    if (typeof runId !== 'string') return;
    const run = this.store.get<RunRow>('SELECT * FROM runs WHERE id = ?', runId);
    if (!run || run.status !== 'running') return;
    const ref: Ref = { botId: run.bot_id, threadId: run.thread_id, runId };
    const bot = this.store.get<BotRow>('SELECT * FROM bots WHERE id = ?', run.bot_id)!;
    const entry = this.attach(run);
    if (ev.type === 'turn.line') {
      const msgs = ev.data.engine === 'codex' ? fromCodex(ev.data.msg, entry.codex ??= codexState()) : [ev.data.msg];
      for (const m of msgs) {
        if (m?.type === 'result') this.store.run('UPDATE runs SET final = ? WHERE id = ?', JSON.stringify(m), runId);
        else if (m) this.onMessage(ref, bot, entry, m);
      }
    } else if (ev.type === 'turn.timeout') {
      this.interrupt(runId, `超过单轮时长上限 ${bot.max_run_seconds} 秒，已自动停止`);
    } else if (ev.type === 'turn.finished') {
      const { code, signal, stderr } = ev.data;
      this.finish(ref, `claude 退出码 ${code ?? signal}：${String(stderr ?? '').slice(-500)}`);
    }
  }

  /** 盒子重启了：交给旧盒子的轮次都没了，收尾 */
  onBoxBoot(boot: string): void {
    for (const run of this.store.all<RunRow>("SELECT * FROM runs WHERE status = 'running'")) {
      const e = this.active.get(run.bot_id);
      if (e?.runId === run.id && (e.boot === undefined || e.boot === boot)) continue;
      this.abandon(run, '盒子重启了，这一轮没有跑完');
    }
  }

  /** pagentd 重启后，盒子里还在跑（或跑完了但事件还没落库）的轮次：重新挂上，事件续传进来 */
  private attach(run: RunRow, boot?: string): Active {
    const cur = this.active.get(run.bot_id);
    if (cur?.runId === run.id) return cur;
    const memDir = agentMemoryDir(run.bot_id);
    const entry: Active = {
      runId: run.id, boot, memDir, mem: readAgentFiles(memDir), redact: redactor(allSecrets(this.store)),
      actions: this.store.get<{ n: number }>('SELECT count(*) n FROM actions WHERE run_id = ?', run.id)!.n,
    };
    this.active.set(run.bot_id, entry);
    return entry;
  }

  private onMessage(ref: Ref, bot: BotRow, entry: Active, raw: any): void {
    // 保险箱里的值不进时间线
    const m = entry.redact ? JSON.parse(entry.redact(JSON.stringify(raw))) : raw;
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
  private finish(ref: Ref, error: string | null): void {
    const entry = this.active.get(ref.botId);
    const bot = this.store.get<BotRow>('SELECT * FROM bots WHERE id = ?', ref.botId)!;
    if (entry?.runId === ref.runId) this.scanMemory(ref, bot, entry);
    this.store.tx(() => {
      const run = this.store.get<RunRow>('SELECT * FROM runs WHERE id = ?', ref.runId)!;
      if (run.status !== 'running') return;
      const result = run.final ? JSON.parse(run.final) as ResultMsg : null;
      if (result) error = null;
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
      this.afterRun(ref, bot, status, (result?.result ?? '').trim());
    });
    if (entry?.runId === ref.runId) {
      if (entry.newSession) this.newSession(ref.botId, bot.name, entry.newSession);
      this.active.delete(ref.botId);
    }
    this.kick(ref.botId);
  }

  /** 这一轮由 Routine 触发：没新内容（NO_NEWS）就安静收尾，有新内容才通知用户 */
  private afterRun(ref: Ref, bot: BotRow, status: RunStatus, text: string): void {
    const metas = this.store.all<{ meta: string | null }>('SELECT meta FROM messages WHERE run_id = ?', ref.runId)
      .map((m) => (m.meta ? JSON.parse(m.meta) : {}));
    for (const meta of metas) {
      if (!meta.routine) continue;
      const quiet = status === 'succeeded' && /^\W*NO_NEWS\W*$/.test(text);
      this.store.emit('routine.fired', { phase: 'done', routineId: meta.routine.id, name: meta.routine.name, status, quiet }, ref);
      if (!quiet) {
        this.store.emit('notify', {
          kind: 'routine', title: `${bot.name} · ${meta.routine.name}`,
          body: status === 'succeeded' ? text.slice(0, 300) : `这次没跑成（${status}）`,
        }, ref);
      }
    }
    this.hooks.afterRun?.(ref, bot, status, text, metas);
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
    if (entry?.runId === runId && entry.boot) this.sendInterrupt(runId);
    return true;
  }

  /** 让网关对这一轮的进程组发 SIGINT（宽限后 SIGKILL，计时在网关那边） */
  private sendInterrupt(runId: string): void {
    ensureBox().then((box) => gw(box, 'POST', '/api/interrupt', { runId })).catch((e) => console.error('interrupt', runId, e.message));
  }

  /** 收尾一轮已经不在盒子里跑的 run：记为中断，结果不明的操作留给下一轮的 Agent 核实 */
  private abandon(run: RunRow, error: string): void {
    this.store.tx(() => {
      const unconfirmed = this.settleActions(run.id);
      this.store.run("UPDATE runs SET status = 'interrupted', ended_at = ?, error = ? WHERE id = ?", now(), error, run.id);
      this.store.emit('run.finished', { status: 'interrupted', unconfirmed, error }, { botId: run.bot_id, threadId: run.thread_id, runId: run.id });
    });
    if (this.active.get(run.bot_id)?.runId === run.id) this.active.delete(run.bot_id);
    this.kick(run.bot_id);
  }

  /** pagentd 启动时对账：盒子里还有的轮次重新挂上（之后事件续传），没有的记为中断。 */
  async recover(): Promise<void> {
    const stale = this.store.all<RunRow>("SELECT * FROM runs WHERE status = 'running'");
    let info: { boot: string; runs: { runId: string }[] } | null = null;
    for (let i = 0; stale.length && !info && i < 10; i++) {
      try { info = await gw(await ensureBox(), 'GET', '/api/runs'); } catch (e) {
        console.error('recover: 连不上盒子', (e as Error).message);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    const known = new Set(info?.runs.map((r) => r.runId) ?? []);
    let lost = 0;
    for (const run of stale) {
      if (known.has(run.id)) this.attach(run, info!.boot);
      else { lost++; this.abandon(run, info ? '盒子里已经没有这一轮（盒子重启过）' : '连不上盒子'); }
    }
    const bots = this.store.all<{ bot_id: string }>(
      "SELECT DISTINCT t.bot_id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.status = 'queued'");
    for (const b of bots) this.kick(b.bot_id);
    if (stale.length) console.log(`recover: ${stale.length - lost} 个轮次在盒子里继续，${lost} 个记为中断`);
  }

  activeRuns(): string[] {
    return [...this.active.values()].map((a) => a.runId);
  }
}

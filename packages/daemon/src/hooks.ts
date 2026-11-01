// worker 里的 hook 打到这里。pre：策略决定 / 等审批，并记一条 Action；post：把 Action 标为完成。
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { type ActionRow, type BotRow, type RunRow, type Store, newId, now } from './store.ts';
import { evaluate, hasSideEffect, summarize } from './policy.ts';
import type { Approvals } from './approvals.ts';
import type { Decision, PolicyRule } from '../../protocol/src/types.ts';

interface HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
  tool_response?: unknown;
}

const preOutput = (decision: 'allow' | 'deny', reason: string) => JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
});

export function startHookServer(store: Store, approvals: Approvals, port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const run = authenticate(store, req);
      if (!run) return send(res, 401, { error: 'bad run token' });
      const input = JSON.parse(await readBody(req)) as HookInput;
      if (req.url === '/hook/pre') return send(res, 200, await pre(store, approvals, run, input));
      if (req.url === '/hook/post') return send(res, 200, post(store, run, input));
      send(res, 404, { error: 'not found' });
    } catch (e) {
      console.error('hook error', e);
      send(res, 500, { error: String(e) });
    }
  });
  server.listen(port, () => console.log(`hook server :${port}`));
  return server;
}

function authenticate(store: Store, req: http.IncomingMessage): RunRow | null {
  const runId = String(req.headers['x-pagent-run'] ?? '');
  const token = Buffer.from(String(req.headers['x-pagent-token'] ?? ''));
  const run = store.get<RunRow>('SELECT * FROM runs WHERE id = ?', runId);
  if (!run) return null;
  const expected = Buffer.from(run.hook_token);
  if (token.length !== expected.length || !timingSafeEqual(token, expected)) return null;
  return run;
}

async function pre(store: Store, approvals: Approvals, run: RunRow, h: HookInput): Promise<string> {
  const ref = { runId: run.id, botId: run.bot_id, threadId: run.thread_id };
  const bot = store.get<BotRow>('SELECT * FROM bots WHERE id = ?', run.bot_id)!;
  const live = store.get<RunRow>('SELECT * FROM runs WHERE id = ?', run.id)!;
  let { decision, reason } = evaluate(JSON.parse(bot.policy) as PolicyRule[], h.tool_name, h.tool_input ?? {});
  if (live.status !== 'running' || live.interrupt_requested) {
    decision = 'deny';
    reason = '这一轮已被中断';
  }
  const actionId = newId('act');
  const status = decision === 'allow' ? 'approved' : decision === 'deny' ? 'denied' : 'pending_approval';
  store.tx(() => {
    store.run(
      `INSERT INTO actions(id, run_id, tool_use_id, tool, input, side_effect, status, reason, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      actionId, run.id, h.tool_use_id ?? null, h.tool_name, JSON.stringify(h.tool_input ?? {}),
      hasSideEffect(h.tool_name) ? 1 : 0, status, reason, now(), now(),
    );
    store.emit('action.decided', { actionId, tool: h.tool_name, decision, reason, summary: summarize(h.tool_name, h.tool_input ?? {}) }, ref);
  });
  if (decision !== 'ask') return preOutput(decision as Exclude<Decision, 'ask'>, `pagent: ${reason}`);

  const result = await approvals.request({ ...ref, actionId }, h.tool_name, h.tool_input ?? {});
  const final = result === 'approved' ? 'allow' : 'deny';
  const why = { approved: '用户已批准', denied: '用户拒绝', expired: '审批超时', cancelled: '审批已取消' }[result];
  store.tx(() => {
    store.run('UPDATE actions SET status = ?, reason = ?, updated_at = ? WHERE id = ?',
      final === 'allow' ? 'approved' : 'denied', why, now(), actionId);
    store.emit('action.decided', { actionId, tool: h.tool_name, decision: final, reason: why }, ref);
  });
  return preOutput(final, `pagent: ${why}`);
}

function post(store: Store, run: RunRow, h: HookInput): Record<string, never> {
  const action = h.tool_use_id
    ? store.get<ActionRow>("SELECT * FROM actions WHERE run_id = ? AND tool_use_id = ? AND status = 'approved'", run.id, h.tool_use_id)
    : store.get<ActionRow>("SELECT * FROM actions WHERE run_id = ? AND tool = ? AND status = 'approved' ORDER BY created_at DESC LIMIT 1", run.id, h.tool_name);
  if (!action) return {};
  const resp = h.tool_response as { is_error?: boolean; interrupted?: boolean } | undefined;
  const status = resp?.is_error || resp?.interrupted ? 'failed' : 'succeeded';
  store.tx(() => {
    store.run('UPDATE actions SET status = ?, updated_at = ? WHERE id = ?', status, now(), action.id);
    store.emit('action.completed', { actionId: action.id, tool: action.tool, status },
      { runId: run.id, botId: run.bot_id, threadId: run.thread_id });
  });
  return {};
}

export function readBody(req: http.IncomingMessage, limit = 5 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function send(res: http.ServerResponse, code: number, body: unknown): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }).end(text);
}

// 本机管理 API：只监听 unix socket（0600），worker 所在的网络够不到它。
// 手机 / 远程设备的入口在 P2 单独做（设备认证）。
import http from 'node:http';
import { chmodSync, rmSync } from 'node:fs';
import { type ActionRow, type ApprovalRow, type BotRow, type RunRow, type Store, type ThreadRow, bus, newId, now } from './store.ts';
import { readBody, send } from './hooks.ts';
import type { Runner } from './runner.ts';
import type { Approvals } from './approvals.ts';
import type { Bot, PagentEvent, PolicyRule } from '../../protocol/src/types.ts';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

export const toBot = (r: BotRow): Bot => ({
  id: r.id, name: r.name, persona: r.persona, model: r.model,
  policy: JSON.parse(r.policy) as PolicyRule[], maxTurns: r.max_turns, createdAt: r.created_at,
});

class HttpError extends Error {
  code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}

export function startApi(store: Store, runner: Runner, approvals: Approvals, sock: string): http.Server {
  const botByName = (name: string) => {
    const b = store.get<BotRow>('SELECT * FROM bots WHERE name = ?', name);
    if (!b) throw new HttpError(404, `没有名为 ${name} 的 Bot`);
    return b;
  };

  const routes: [string, RegExp, (m: RegExpMatchArray, body: any, url: URL, res: http.ServerResponse) => unknown][] = [
    ['GET', /^\/bots$/, () => store.all<BotRow>('SELECT * FROM bots ORDER BY created_at').map(toBot)],
    ['POST', /^\/bots$/, (_m, b) => {
      if (!NAME_RE.test(b?.name ?? '')) throw new HttpError(400, 'name 只能用小写字母、数字和 -');
      if (store.get('SELECT 1 FROM bots WHERE name = ?', b.name)) throw new HttpError(409, `${b.name} 已存在`);
      const id = newId('bot');
      store.tx(() => {
        store.run('INSERT INTO bots(id, name, persona, model, policy, max_turns, created_at) VALUES (?,?,?,?,?,?,?)',
          id, b.name, b.persona ?? '', b.model ?? null, JSON.stringify(b.policy ?? []), b.maxTurns ?? 30, now());
        store.emit('bot.created', { name: b.name }, { botId: id });
      });
      return toBot(store.get<BotRow>('SELECT * FROM bots WHERE id = ?', id)!);
    }],
    ['GET', /^\/bots\/([^/]+)$/, (m) => toBot(botByName(m[1]))],
    ['PATCH', /^\/bots\/([^/]+)$/, (m, b) => {
      const bot = botByName(m[1]);
      store.run('UPDATE bots SET persona = ?, model = ?, policy = ?, max_turns = ? WHERE id = ?',
        b.persona ?? bot.persona, b.model === undefined ? bot.model : b.model,
        b.policy ? JSON.stringify(b.policy) : bot.policy, b.maxTurns ?? bot.max_turns, bot.id);
      return toBot(store.get<BotRow>('SELECT * FROM bots WHERE id = ?', bot.id)!);
    }],
    ['POST', /^\/bots\/([^/]+)\/messages$/, (m, b) => {
      const bot = botByName(m[1]);
      if (!b?.text) throw new HttpError(400, '缺少 text');
      let thread = b.newThread ? undefined
        : store.get<ThreadRow>('SELECT * FROM threads WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1', bot.id);
      if (!thread) {
        const id = newId('thr');
        store.run('INSERT INTO threads(id, bot_id, created_at) VALUES (?,?,?)', id, bot.id, now());
        thread = store.get<ThreadRow>('SELECT * FROM threads WHERE id = ?', id)!;
      }
      return { threadId: thread.id, ...runner.enqueue(thread.id, b.text) };
    }],
    ['GET', /^\/runs$/, (_m, _b, url) => {
      const bot = url.searchParams.get('bot');
      const limit = Number(url.searchParams.get('limit') ?? 20);
      return bot
        ? store.all<RunRow>('SELECT * FROM runs WHERE bot_id = ? ORDER BY started_at DESC LIMIT ?', botByName(bot).id, limit)
        : store.all<RunRow>('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?', limit);
    }],
    ['GET', /^\/runs\/([^/]+)$/, (m) => {
      const run = store.get<RunRow>('SELECT * FROM runs WHERE id = ?', m[1]);
      if (!run) throw new HttpError(404, 'run 不存在');
      const { hook_token: _, ...rest } = run;
      return {
        ...rest,
        actions: store.all<ActionRow>('SELECT * FROM actions WHERE run_id = ? ORDER BY created_at', run.id),
        approvals: store.all<ApprovalRow>('SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at', run.id),
      };
    }],
    ['POST', /^\/runs\/([^/]+)\/interrupt$/, (m) => ({ ok: runner.interrupt(m[1]) })],
    ['GET', /^\/approvals$/, (_m, _b, url) =>
      store.all<ApprovalRow>('SELECT * FROM approvals WHERE status = ? ORDER BY created_at', url.searchParams.get('status') ?? 'pending')],
    ['POST', /^\/approvals\/([^/]+)$/, (m, b) => {
      const status = b?.decision === 'approve' ? 'approved' : b?.decision === 'deny' ? 'denied' : null;
      if (!status) throw new HttpError(400, 'decision 必须是 approve 或 deny');
      const r = approvals.settle(m[1], status, b.by ?? 'cli');
      if (!r.current) throw new HttpError(404, '审批不存在');
      if (!r.ok) throw new HttpError(409, `审批已是 ${r.current} 状态，不能再改`);
      return { ok: true, status };
    }],
    ['GET', /^\/events$/, (_m, _b, url, res) => streamEvents(store, url, res)],
  ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://pagent');
    try {
      for (const [method, re, fn] of routes) {
        const m = url.pathname.match(re);
        if (!m || method !== req.method) continue;
        const raw = req.method === 'GET' ? '' : await readBody(req);
        const out = fn(m, raw ? JSON.parse(raw) : undefined, url, res);
        if (out !== STREAMING) send(res, 200, out);
        return;
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      const code = e instanceof HttpError ? e.code : 500;
      if (code === 500) console.error(e);
      send(res, code, { error: (e as Error).message });
    }
  });
  rmSync(sock, { force: true });
  server.listen(sock, () => {
    chmodSync(sock, 0o600);
    console.log(`api ${sock}`);
  });
  return server;
}

const STREAMING = Symbol('streaming');

/** 事件流：after 游标续传；follow=1 时以 SSE 持续推送。客户端断线重连带上最后的 seq 即可不重不漏。 */
function streamEvents(store: Store, url: URL, res: http.ServerResponse): unknown {
  const after = Number(url.searchParams.get('after') ?? 0);
  const filter = {
    threadId: url.searchParams.get('thread'),
    runId: url.searchParams.get('run'),
    botId: url.searchParams.get('bot'),
  };
  const match = (e: PagentEvent) =>
    (!filter.threadId || e.threadId === filter.threadId) && (!filter.runId || e.runId === filter.runId) && (!filter.botId || e.botId === filter.botId);
  if (url.searchParams.get('follow') !== '1') return store.eventsAfter(after, 1000).filter(match);

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const write = (e: PagentEvent) => { if (match(e)) res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`); };
  // 回放与订阅在同一个同步片段里完成，中间不会插入新事件
  let cursor = after;
  for (let batch = store.eventsAfter(cursor); batch.length; batch = store.eventsAfter(cursor)) {
    batch.forEach(write);
    cursor = batch[batch.length - 1].seq;
  }
  const onEvent = (e: PagentEvent) => { if (e.seq > cursor) write(e); };
  bus.on('event', onEvent);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  res.on('close', () => { bus.off('event', onEvent); clearInterval(ping); });
  return STREAMING;
}

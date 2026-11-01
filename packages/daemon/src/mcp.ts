// pagent 自带的 MCP 服务（Streamable HTTP，JSON 响应模式），每个 Agent 每轮都会挂上。
// 只在沙箱网络里可达；凭据是这一轮的 run token，轮次结束即失效。
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { type BotRow, type RunRow, type Store, newId, now } from './store.ts';
import { MemoryError, rememberGlobal } from './memory.ts';
import { readBody, send } from './http.ts';

export interface McpHooks {
  /** 这一轮结束后换一条新会话 */
  requestNewSession(runId: string, reason: string): void;
}

const TOOLS = [
  {
    name: 'remember',
    description: '把一条关于用户本人的事写进全局记忆（所有 Agent 共享，下一轮起生效）。一次一件事，写成完整的一句话。'
      + '要更正或合并已有条目时，传入它的编号 replaces（系统提示里方括号中的编号）。不要写密码、token 等凭据。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的事，例如"用户习惯用简体中文交流"' },
        replaces: { type: 'string', description: '可选：被这条取代的已有记忆编号' },
      },
      required: ['text'],
    },
  },
  {
    name: 'ask_user',
    description: '请用户在几个选项里拿主意。调用后用户会看到一张选择卡；这一轮随即结束，用户的选择会作为下一条消息发给你。'
      + '只在缺少关键信息、或必须由用户决定时使用，不要用来征求执行许可。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6 },
        allowCustom: { type: 'boolean', description: '是否允许用户自己输入答案，默认 true' },
      },
      required: ['question', 'options'],
    },
  },
  {
    name: 'new_session',
    description: '这一轮结束后换一条新的会话：上下文清空，人设和两层记忆都保留。适合对话已经很长、或话题彻底换了的时候。'
      + '调用前先把还需要的东西写进记忆。',
    inputSchema: { type: 'object', properties: { reason: { type: 'string' } } },
  },
];

const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], isError });

export function startMcpServer(store: Store, hooks: McpHooks, port: number): http.Server {
  const callTool = (run: RunRow, name: string, args: any) => {
    const bot = store.get<BotRow>('SELECT * FROM bots WHERE id = ?', run.bot_id)!;
    const ref = { botId: run.bot_id, threadId: run.thread_id, runId: run.id };
    if (name === 'remember') {
      try {
        const m = rememberGlobal(store, args?.text, { ...ref, by: bot.name }, args?.replaces || undefined);
        return text(`已记住（编号 ${m.id}），下一轮起所有 Agent 都能看到。`);
      } catch (e) {
        if (e instanceof MemoryError) return text(e.message, true);
        throw e;
      }
    }
    if (name === 'ask_user') {
      const question = String(args?.question ?? '').trim().slice(0, 500);
      const options = (Array.isArray(args?.options) ? args.options : []).map((o: unknown) => String(o).trim().slice(0, 200)).filter(Boolean).slice(0, 6);
      if (!question || !options.length) return text('question 和 options 都不能为空', true);
      const allowCustom = args?.allowCustom !== false;
      const id = newId('ask');
      store.tx(() => {
        store.run('INSERT INTO asks(id, run_id, bot_id, thread_id, question, options, allow_custom, created_at) VALUES (?,?,?,?,?,?,?,?)',
          id, run.id, run.bot_id, run.thread_id, question, JSON.stringify(options), allowCustom ? 1 : 0, now());
        store.emit('ask.created', { askId: id, question, options, allowCustom }, ref);
      });
      return text('问题已经发给用户。现在结束这一轮：不要再调用工具，也不要替用户做选择，用一句话说明你在等什么即可。');
    }
    if (name === 'new_session') {
      hooks.requestNewSession(run.id, String(args?.reason ?? '').slice(0, 200));
      return text('好的，这一轮结束后会换一条新会话。还没写进记忆的要点请现在写好。');
    }
    throw Object.assign(new Error(`未知工具 ${name}`), { code: -32602 });
  };

  const handle = (run: RunRow, msg: any) => {
    const { id, method, params } = msg ?? {};
    if (id === undefined) return null; // 通知
    try {
      let result: unknown;
      if (method === 'initialize') {
        result = {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'pagent', version: '0.3.0' },
        };
      } else if (method === 'tools/list') result = { tools: TOOLS };
      else if (method === 'tools/call') result = callTool(run, params?.name, params?.arguments ?? {});
      else if (method === 'ping') result = {};
      else return { jsonrpc: '2.0', id, error: { code: -32601, message: `不支持的方法 ${method}` } };
      return { jsonrpc: '2.0', id, result };
    } catch (e: any) {
      return { jsonrpc: '2.0', id, error: { code: e.code ?? -32603, message: e.message } };
    }
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url !== '/mcp') return send(res, 404, { error: 'not found' });
      if (req.method !== 'POST') return res.writeHead(405).end();
      const run = authenticate(store, req);
      if (!run) return send(res, 401, { error: 'bad run token' });
      const msg = JSON.parse(await readBody(req, 1024 * 1024));
      const out = Array.isArray(msg) ? msg.map((m) => handle(run, m)).filter(Boolean) : handle(run, msg);
      if (!out || (Array.isArray(out) && !out.length)) return res.writeHead(202).end();
      send(res, 200, out);
    } catch (e) {
      console.error('mcp error', e);
      if (!res.headersSent) send(res, 500, { error: String(e) });
    }
  });
  server.listen(port, () => console.log(`pagent mcp :${port}/mcp`));
  return server;
}

/** run id + token 都对，且这一轮还在跑 */
function authenticate(store: Store, req: http.IncomingMessage): RunRow | null {
  const runId = String(req.headers['x-pagent-run'] ?? '');
  const m = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''));
  const run = store.get<RunRow>("SELECT * FROM runs WHERE id = ? AND status = 'running'", runId);
  if (!run || !m) return null;
  const got = Buffer.from(m[1]);
  const expected = Buffer.from(run.hook_token);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  return run;
}

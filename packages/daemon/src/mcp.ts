// pagent 自带的 MCP 服务（Streamable HTTP，JSON 响应模式），每个 Agent 每轮都会挂上。
// 只在沙箱网络里可达；凭据是这一轮的 run token，轮次结束即失效。
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { type BotRow, type RunRow, type Store, newId, now } from './store.ts';
import { MemoryError, rememberGlobal } from './memory.ts';
import { createRoutine, deleteRoutine, listRoutines } from './routines.ts';
import { ServiceError } from './service.ts';
import type { LocalExec } from './localexec.ts';
import { listSecrets } from './vault.ts';
import { readBody, send } from './http.ts';
import type { Runner } from './runner.ts';
import { listAgents, messageAgent } from './collab.ts';

export interface McpHooks {
  /** 这一轮结束后换一条新会话 */
  requestNewSession(runId: string, reason: string): void;
  localExec?: LocalExec;
  runner?: Runner;
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
    name: 'request_takeover',
    description: '需要用户亲自在你的屏幕上操作时调用：输入密码、二步验证码、扫码、人机验证、付款确认等你不该或做不到的事。'
      + '用户会看到一张卡片，可以打开你的屏幕直接操作；接管期间你的屏幕工具暂停。用户交还后你会收到消息，再接着做。调用后这一轮就结束。',
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string', description: '请用户做什么，例如"请在屏幕上输入短信验证码，完成登录"' } },
      required: ['reason'],
    },
  },
  {
    name: 'notify_user',
    description: '主动给用户发一条通知（手机 / 浏览器推送）。用于用户不在看对话、但有值得马上知道的结果或变化时，比如长任务做完了、监控到异常。不要用来闲聊。',
    inputSchema: {
      type: 'object', required: ['title', 'body'],
      properties: { title: { type: 'string', description: '一句话标题' }, body: { type: 'string', description: '要点，200 字以内' } },
    },
  },
  {
    name: 'create_routine',
    description: '给你自己建一个 Routine（定时任务）：到点时 prompt 会作为一条消息发到你当前的会话里，你照常完成。'
      + '没有新内容时你只需回复 NO_NEWS，用户不会被打扰；有新内容会推送给用户。用户说"每天/每周/每小时帮我……"时用它。'
      + 'schedule 是 5 段 cron（分 时 日 月 周），时区是用户本地时间（Asia/Shanghai），例如每天 8 点 "0 8 * * *"、工作日 9:30 "30 9 * * 1-5"。'
      + 'webhook=true 时还会生成一个 webhook 地址，外部系统 POST 过来也会触发。',
    inputSchema: {
      type: 'object', required: ['name', 'prompt'],
      properties: {
        name: { type: 'string', description: '简短的名字，例如"盘前要闻"' },
        prompt: { type: 'string', description: '每次触发时要做的事，写成完整的指令' },
        schedule: { type: 'string', description: 'cron 表达式；只要 webhook 触发时可以不填' },
        webhook: { type: 'boolean' },
      },
    },
  },
  {
    name: 'list_routines',
    description: '列出你自己的 Routine（编号、名字、时间、下次运行）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'delete_routine',
    description: '删除你自己的一个 Routine。',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
  },
  {
    name: 'list_machines',
    description: '列出用户允许你操作的电脑（用户自己的 Mac 等，跑着本机执行守护进程的），以及各自开放的目录。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ExternalShell',
    description: '在用户的电脑上执行一条 shell 命令（工作目录在该电脑开放的目录内）。最多等 25 秒；没跑完会返回任务编号，用 AwaitExternalShell 接着等。'
      + '只在任务确实需要用户本机上的东西时用；这台盒子里能做的事就在盒子里做。',
    inputSchema: {
      type: 'object', required: ['command'],
      properties: {
        machine: { type: 'string', description: '电脑名，只有一台时可省略' },
        command: { type: 'string' },
        cwd: { type: 'string', description: '相对开放目录的子目录，默认就是开放目录' },
        timeoutSec: { type: 'number', description: '命令最长运行秒数，默认 120，最大 1800' },
      },
    },
  },
  {
    name: 'AwaitExternalShell',
    description: '继续等待 ExternalShell 返回的任务，最多等 waitSec 秒（默认 60）。',
    inputSchema: { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string' }, waitSec: { type: 'number' } } },
  },
  {
    name: 'ExternalRead',
    description: '读取用户电脑上开放目录里的一个文本文件（路径相对开放目录，不能跳出去）。',
    inputSchema: { type: 'object', required: ['path'], properties: { machine: { type: 'string' }, path: { type: 'string' } } },
  },
  {
    name: 'list_secrets',
    description: '列出保险箱里有哪些凭据（只有名字和说明，没有值）。命令里用环境变量 $名字 引用；网页登录时用 screen 的 fill_secret 把值填进当前输入框，不要把值打印出来。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_agents',
    description: '列出用户的其他 Agent（名字和人设摘要），找人协作前先看看谁适合。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'message_agent',
    description: '给另一个 Agent 发消息、托付一件事。消息排进它当前的会话；它做完后，最后的回复会自动交回给你。'
      + '同一轮里托付出去的几件事算一批，全部有结果后合成一条消息一次性发给你，所以要并行分工就在同一轮里连续调用几次，然后结束这一轮（不要轮询）。'
      + '把任务写完整：背景、要做什么、要交回什么。不需要回复（只是告知）时传 expectReply=false。',
    inputSchema: {
      type: 'object', required: ['to', 'text'],
      properties: { to: { type: 'string', description: 'Agent 的名字' }, text: { type: 'string' }, expectReply: { type: 'boolean' } },
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
  const callTool = async (run: RunRow, name: string, args: any) => {
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
    if (name === 'request_takeover') {
      const reason = String(args?.reason ?? '').trim().slice(0, 500) || '请你在我的屏幕上操作一下';
      const id = newId('ask');
      const options = ['我处理好了，交还给你'];
      store.tx(() => {
        store.run("INSERT INTO asks(id, run_id, bot_id, thread_id, question, options, allow_custom, kind, created_at) VALUES (?,?,?,?,?,?,1,'takeover',?)",
          id, run.id, run.bot_id, run.thread_id, reason, JSON.stringify(options), now());
        store.emit('ask.created', { askId: id, kind: 'takeover', question: reason, options, allowCustom: true }, ref);
      });
      return text('已请用户接管你的屏幕。现在结束这一轮：不要再调用工具，用一句话说明你在等用户做什么。');
    }
    if (name === 'notify_user') {
      const title = String(args?.title ?? '').trim().slice(0, 80);
      const body = String(args?.body ?? '').trim().slice(0, 500);
      if (!title) return text('title 不能为空', true);
      store.emit('notify', { kind: 'agent', title: `${bot.name}：${title}`, body }, ref);
      return text('已通知用户。');
    }
    if (name === 'create_routine' || name === 'list_routines' || name === 'delete_routine') {
      try {
        if (name === 'create_routine') {
          const r = createRoutine(store, run.bot_id, args ?? {}, bot.name);
          return text(`已创建 Routine ${r.id}「${r.name}」：${r.when}${r.nextAt ? `，下次 ${r.nextAt}` : ''}${r.webhook ? `，webhook 路径 ${r.webhook}` : ''}。`);
        }
        if (name === 'list_routines') {
          const list = listRoutines(store, run.bot_id);
          return text(list.length ? list.map((r) => `- ${r.id}「${r.name}」${r.when}${r.enabled ? '' : '（已停用）'}：${r.prompt.slice(0, 80)}`).join('\n') : '你还没有 Routine。');
        }
        const own = listRoutines(store, run.bot_id).find((r) => r.id === args?.id);
        if (!own) return text('没有这个 Routine（只能删自己的）', true);
        deleteRoutine(store, own.id, bot.name);
        return text(`已删除「${own.name}」。`);
      } catch (e) {
        if (e instanceof ServiceError) return text(e.message, true);
        throw e;
      }
    }
    if (name === 'list_secrets') {
      const list = listSecrets(store);
      return text(list.length ? list.map((s) => `- ${s.name}${s.note ? `：${s.note}` : ''}`).join('\n') : '保险箱是空的。需要凭据时请用户在 设置 → 保险箱 里添加。');
    }
    if (['list_machines', 'ExternalShell', 'AwaitExternalShell', 'ExternalRead'].includes(name)) {
      const le = hooks.localExec;
      if (!le) return text('本机执行没有启用', true);
      try {
        if (name === 'list_machines') {
          const ms = le.machines();
          return text(ms.length ? ms.map((m) => `- ${m.name}：${m.allowed ? '已允许' : '未允许'}，${m.online ? '在线' : '离线'}${m.root ? `，开放目录 ${m.root}` : ''}`).join('\n') : '用户还没有接入任何电脑。');
        }
        const show = (r: any) => text(JSON.stringify(r, null, 1).slice(0, 60_000), r.ok === false);
        if (name === 'ExternalShell') {
          const timeoutSec = Math.min(1800, Math.max(1, Number(args?.timeoutSec ?? 120)));
          return show(await le.submit(String(args?.machine ?? ''), 'shell', { command: String(args?.command ?? ''), cwd: args?.cwd ? String(args.cwd) : undefined, timeoutSec }, 25_000));
        }
        if (name === 'AwaitExternalShell') return show(await le.await(String(args?.jobId ?? ''), Math.min(120, Number(args?.waitSec ?? 60)) * 1000));
        return show(await le.submit(String(args?.machine ?? ''), 'read', { path: String(args?.path ?? '') }, 25_000));
      } catch (e) {
        if (e instanceof ServiceError) return text(e.message, true);
        throw e;
      }
    }
    if (name === 'list_agents') {
      const list = listAgents(store, bot.id);
      return text(list.length ? list.map((a) => `- ${a.name}（${a.engine}）：${a.persona.replace(/\s+/g, ' ').slice(0, 120) || '（没写人设）'}`).join('\n') : '没有其他 Agent。');
    }
    if (name === 'message_agent') {
      if (!hooks.runner) return text('协作没有启用', true);
      try {
        const r = messageAgent(store, hooks.runner, bot, run.id, String(args?.to ?? ''), String(args?.text ?? ''), args?.expectReply !== false);
        return text(args?.expectReply === false ? `已发给 ${r.to}。` : `已发给 ${r.to}。这一轮托付出去的事全部有结果后，会合成一条消息一次性发给你（不用轮询，也不用等）；没有别的事要做的话，现在就结束这一轮。`);
      } catch (e) {
        if (e instanceof ServiceError) return text(e.message, true);
        throw e;
      }
    }
    if (name === 'new_session') {
      hooks.requestNewSession(run.id, String(args?.reason ?? '').slice(0, 200));
      return text('好的，这一轮结束后会换一条新会话。还没写进记忆的要点请现在写好。');
    }
    throw Object.assign(new Error(`未知工具 ${name}`), { code: -32602 });
  };

  const handle = async (run: RunRow, msg: any) => {
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
      else if (method === 'tools/call') result = await callTool(run, params?.name, params?.arguments ?? {});
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
      const out = Array.isArray(msg) ? (await Promise.all(msg.map((m) => handle(run, m)))).filter(Boolean) : await handle(run, msg);
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

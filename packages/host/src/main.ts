// pagent-host：盒子里的网关（对应 Grok 0.18 的 host-main.cjs）。零依赖，盒子主进程。
// - pagentd 经 /api/runTurn 让某个 Agent 跑一轮；claude -p 在这里启动、在这里跑到底，pagentd 重启也不影响。
// - claude 输出的每一行、轮次开始/结束都进带序号的事件日志，经 /events（SSE）推给 pagentd；
//   pagentd 带游标续传，处理完用 /api/ack 确认，确认过的才从内存里删。
// - 盒子重启（boot 变了）意味着进行中的轮次都没了，pagentd 据此收尾。
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import { extname, join, normalize } from 'node:path';
import { createInterface } from 'node:readline';
import { Screens } from './screens.ts';
import { rpc, screenTool } from './screen-mcp.ts';

const VERSION = '1';
const PORT = Number(process.env.PAGENT_GATEWAY_PORT ?? 7700);
const TOKEN = process.env.PAGENT_GATEWAY_TOKEN ?? '';
const HOME = process.env.HOME ?? '/home/box';
const ROOT = join(HOME, '.pagent');
const SKILLS = join(ROOT, 'skills');
const CRED = '/opt/pagent-cred/.credentials.json';
// Codex 引擎：所有 Agent 共用一个 CODEX_HOME（一份 ChatGPT 登录，免得多份刷新令牌互相顶掉；会话按 id 区分）
const CODEX_HOME = join(ROOT, 'codex');
const WORKSPACE = '/workspace';
const BOOT = randomUUID();
const EVENTS_MAX_BYTES = 200 * 1024 * 1024;   // pagentd 长时间不来确认时的兜底上限

if (!TOKEN) throw new Error('缺少 PAGENT_GATEWAY_TOKEN');

// ---- 事件日志 ----

interface Ev { seq: number; type: string; data: Record<string, unknown>; size: number }
const events: Ev[] = [];
let seq = 0;
let bytes = 0;
const subscribers = new Set<ServerResponse>();

function push(type: string, data: Record<string, unknown>): void {
  const body = JSON.stringify({ seq: ++seq, type, data });
  const ev = { seq, type, data, size: body.length };
  events.push(ev);
  bytes += ev.size;
  while (bytes > EVENTS_MAX_BYTES && events.length > 1) bytes -= events.shift()!.size;
  for (const res of subscribers) res.write(`id: ${seq}\ndata: ${body}\n\n`);
}

function ack(upTo: number): void {
  while (events.length && events[0].seq <= upTo) bytes -= events.shift()!.size;
}

// ---- 轮次 ----

interface Run {
  runId: string; agentId: string; token: string; secrets: Record<string, string>; status: 'running' | 'exited'; child: ChildProcessWithoutNullStreams;
  stderr: string; killTimer?: NodeJS.Timeout; timeout?: NodeJS.Timeout; startedAt: number; endedAt?: number;
}
const runs = new Map<string, Run>();

const screens = new Screens(ROOT, (s, what) => push('screen.changed', { what, ...screens.status(s) }));

const AGENT_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Agent 的配置目录：会话、它自己的记忆；skill 指向共享目录，订阅凭据指向宿主挂进来的文件 */
function prepareAgent(agentId: string): string {
  const dir = join(ROOT, 'agents', agentId, 'claude');
  mkdirSync(join(dir, 'memory'), { recursive: true });
  mkdirSync(SKILLS, { recursive: true });
  const skills = join(dir, 'skills');
  const st = lstatSync(skills, { throwIfNoEntry: false });
  if (st && !st.isSymbolicLink()) {
    // 以前装在自己目录里的 skill 并进共享目录（同名的保留共享目录里的）
    for (const name of readdirSync(skills)) {
      const to = join(SKILLS, name);
      if (!existsSync(to)) renameSync(join(skills, name), to);
    }
    rmSync(skills, { recursive: true, force: true });
  }
  if (!lstatSync(skills, { throwIfNoEntry: false })) symlinkSync(SKILLS, skills);
  // 共享 HOME 下的 ~/.claude/skills 也指向同一处：Agent 按习惯往那里装也能被所有 Agent 用上
  mkdirSync(join(HOME, '.claude'), { recursive: true });
  if (!lstatSync(join(HOME, '.claude', 'skills'), { throwIfNoEntry: false })) symlinkSync(SKILLS, join(HOME, '.claude', 'skills'));
  syncCred();
  return dir;
}

/**
 * 订阅凭据：每个 Agent 的 .credentials.json 都链到宿主挂进来的那一份。
 * Claude CLI 刷新令牌时写新文件再 rename，会把链接换成一份普通文件；刷新令牌是轮换的，旧的随即作废。
 * 所以以最新的一份为准：写回共享文件（原地写：它是单文件挂载，不能 rename 覆盖，宿主那边也就跟着更新），再把链接恢复。
 */
const credExpiry = (f: string): number => {
  try { return Number(JSON.parse(readFileSync(f, 'utf8')).claudeAiOauth?.expiresAt ?? 0); } catch { return -1; }
};
function syncCred(): void {
  if (!existsSync(CRED)) return;
  const agentsDir = join(ROOT, 'agents');
  const paths = (existsSync(agentsDir) ? readdirSync(agentsDir) : [])
    .filter((id) => existsSync(join(agentsDir, id, 'claude')))
    .map((id) => join(agentsDir, id, 'claude', '.credentials.json'));
  const copies = paths.filter((p) => lstatSync(p, { throwIfNoEntry: false })?.isFile());
  let best = CRED;
  let bestExp = credExpiry(CRED);
  for (const p of copies) {
    const e = credExpiry(p);
    if (e > bestExp) { best = p; bestExp = e; }
  }
  if (best !== CRED) {
    writeFileSync(CRED, readFileSync(best));
    console.log(`订阅凭据：采用 ${best} 里刷新过的令牌（${new Date(bestExp).toISOString()} 到期）`);
  }
  for (const p of paths) {
    if (lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()) continue;
    rmSync(p, { force: true });
    symlinkSync(CRED, p);
  }
}
// 一轮跑到一半刷新了令牌，也尽快让其他 Agent 用上
setInterval(() => { try { syncCred(); } catch (e) { console.error('syncCred', e); } }, 30_000).unref();

interface TurnReq {
  engine?: 'claude' | 'codex';
  agentId: string; runId: string; prompt: string; systemPrompt?: string | null; sessionId?: string | null;
  mcpConfig: unknown; model?: string | null; maxTurns: number; pluginDirs?: string[]; maxSeconds: number;
  secrets?: Record<string, string>;   // 保险箱：整份给这一轮（环境变量 + fill_secret），轮次结束就丢
}

function runTurn(r: TurnReq): Run {
  if (!AGENT_RE.test(r.agentId) || !AGENT_RE.test(r.runId)) throw new HttpError(400, 'agentId / runId 不合法');
  if (runs.has(r.runId)) throw new HttpError(409, '这一轮已经启动过');
  for (const x of runs.values()) if (x.agentId === r.agentId && x.status === 'running') throw new HttpError(409, `${r.agentId} 还有一轮在跑`);
  const configDir = prepareAgent(r.agentId);
  mkdirSync(WORKSPACE, { recursive: true });
  const n = screens.prepare(r.agentId);
  const token = randomBytes(24).toString('hex');
  // 屏幕相关的 MCP 由网关按 Agent 提供，绑定到它自己的显示器 :n 和 Chrome（CDP 9222+n，懒启动）
  const mcpConfig = r.mcpConfig as { mcpServers: Record<string, unknown> };
  mcpConfig.mcpServers = {
    ...mcpConfig.mcpServers,
    screen: { type: 'http', url: `http://127.0.0.1:${PORT}/mcp/screen`, headers: { Authorization: `Bearer ${token}`, 'x-pagent-run': r.runId } },
    browser: { type: 'stdio', command: 'playwright-mcp', args: ['--cdp-endpoint', `http://127.0.0.1:${9222 + n}`] },
  };

  const engine = r.engine === 'codex' ? 'codex' : 'claude';
  let args: string[];
  const extraEnv: Record<string, string> = {};
  if (engine === 'codex') {
    prepareCodex();
    extraEnv.CODEX_HOME = CODEX_HOME;
    // 没有系统提示参数：人设和记忆由 pagentd 放进第一轮的消息里
    args = ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-C', WORKSPACE,
      ...codexMcpArgs(mcpConfig.mcpServers)];
    if (r.model) args.push('-m', r.model);
    args.push(...(r.sessionId ? ['resume', r.sessionId, '-'] : ['-']));
  } else {
    args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions',
      '--strict-mcp-config', '--mcp-config', JSON.stringify(mcpConfig),
      '--setting-sources', 'user', '--max-turns', String(r.maxTurns)];
    if (r.systemPrompt) args.push('--append-system-prompt', r.systemPrompt);
    for (const d of r.pluginDirs ?? []) args.push('--plugin-dir', d);
    if (r.model) args.push('--model', r.model);
    if (r.sessionId) args.push('--resume', r.sessionId);
  }

  const { PAGENT_GATEWAY_TOKEN: _t, ...base } = process.env;
  // detached：claude 成为新进程组的组长，中断时对整组发信号（连同它起的子进程）
  const child = spawn(engine, args, {
    cwd: WORKSPACE, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...base, CLAUDE_CONFIG_DIR: configDir, PAGENT_RUN_ID: r.runId, PAGENT_AGENT_ID: r.agentId, DISPLAY: `:${n}`, ...secretEnv(r.secrets), ...extraEnv },
  }) as ChildProcessWithoutNullStreams;
  const run: Run = { runId: r.runId, agentId: r.agentId, token, secrets: r.secrets ?? {}, status: 'running', child, stderr: '', startedAt: Date.now() };
  runs.set(r.runId, run);
  push('turn.started', { runId: r.runId, agentId: r.agentId, engine, pid: child.pid ?? null });

  child.stdin.on('error', () => {});
  child.stdin.end(r.prompt);
  child.stderr.on('data', (d: Buffer) => { run.stderr = (run.stderr + d.toString()).slice(-4000); });
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg: unknown;
    try { msg = JSON.parse(line); } catch { return; }
    push('turn.line', { runId: r.runId, agentId: r.agentId, engine, msg });
  });
  child.on('close', () => { run.secrets = {}; });
  run.timeout = setTimeout(() => {
    push('turn.timeout', { runId: r.runId, agentId: r.agentId, maxSeconds: r.maxSeconds });
    interrupt(run, 8000);
  }, r.maxSeconds * 1000);
  child.on('error', (e) => { run.stderr += `\n${e.message}`; });
  child.on('close', (code, signal) => {
    clearTimeout(run.timeout);
    clearTimeout(run.killTimer);
    run.status = 'exited';
    run.endedAt = Date.now();
    push('turn.finished', { runId: r.runId, agentId: r.agentId, code, signal, stderr: run.stderr.trim().slice(-1000) });
  });
  return run;
}

/** 保险箱条目作为环境变量：名字是大写下划线的才给，避免覆盖 PATH 这类系统变量 */
function secretEnv(s: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(s ?? {})) if (/^[A-Z][A-Z0-9_]{1,63}$/.test(k) && !/^(PATH|HOME|DISPLAY|CLAUDE_|CODEX_|PAGENT_|HTTPS?_PROXY|NO_PROXY)/.test(k)) out[k] = v;
  return out;
}

// ---- Codex ----

function prepareCodex(): void {
  mkdirSync(CODEX_HOME, { recursive: true });
  mkdirSync(SKILLS, { recursive: true });
  const skills = join(CODEX_HOME, 'skills');
  if (!lstatSync(skills, { throwIfNoEntry: false })) symlinkSync(SKILLS, skills);
}

/** MCP 配置转成 codex 的 -c 覆盖（字符串和数组用 JSON 写法，也是合法的 TOML） */
function codexMcpArgs(servers: Record<string, any>): string[] {
  const out: string[] = [];
  const kv = (o: Record<string, string>) => `{${Object.entries(o).map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`).join(',')}}`;
  for (const [name, sv] of Object.entries(servers)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
    const p = `mcp_servers.${name}`;
    if (sv.url) {
      out.push('-c', `${p}.url=${JSON.stringify(sv.url)}`);
      if (sv.headers) out.push('-c', `${p}.http_headers=${kv(sv.headers)}`);
    } else if (sv.command) {
      out.push('-c', `${p}.command=${JSON.stringify(sv.command)}`, '-c', `${p}.args=${JSON.stringify(sv.args ?? [])}`);
    }
  }
  return out;
}

const stripAnsi = (t: string) => t.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

interface CodexLogin { status: 'pending' | 'ok' | 'failed'; url?: string; code?: string; output: string; child?: ChildProcessWithoutNullStreams }
let codexLogin: CodexLogin | null = null;

/** ChatGPT 设备码登录：返回网址和验证码，用户在手机上完成；登录结果经事件流推送 */
async function startCodexLogin(): Promise<Omit<CodexLogin, 'child'>> {
  if (codexLogin?.status !== 'pending') {
    prepareCodex();
    const { PAGENT_GATEWAY_TOKEN: _t, ...base } = process.env;
    const child = spawn('codex', ['login', '--device-auth'], { env: { ...base, CODEX_HOME }, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    const st: CodexLogin = { status: 'pending', output: '', child };
    codexLogin = st;
    const onOut = (d: Buffer) => {
      st.output = (st.output + stripAnsi(d.toString())).slice(-4000);
      st.url ??= /https:\/\/\S+/.exec(st.output)?.[0];
      st.code ??= /\b[A-Z0-9]{4,5}-[A-Z0-9]{4,6}\b/.exec(st.output)?.[0];
    };
    child.stdout.on('data', onOut);
    child.stderr.on('data', onOut);
    child.on('close', (code) => {
      st.status = code === 0 ? 'ok' : 'failed';
      push('engine.codex', { status: st.status, output: st.output.slice(-500) });
    });
    setTimeout(() => { if (st.status === 'pending') child.kill('SIGTERM'); }, 16 * 60_000).unref();
  }
  const st = codexLogin!;
  for (let i = 0; i < 60 && st.status === 'pending' && !(st.url && st.code); i++) await new Promise((r) => setTimeout(r, 250));
  return { status: st.status, url: st.url, code: st.code, output: st.output.slice(-1000) };
}

async function codexStatus() {
  const out = await new Promise<string>((resolve) => {
    const { PAGENT_GATEWAY_TOKEN: _t, ...base } = process.env;
    const c = spawn('codex', ['login', 'status'], { env: { ...base, CODEX_HOME } });
    let o = '';
    c.stdout.on('data', (d) => { o += d; });
    c.stderr.on('data', (d) => { o += d; });
    c.on('close', () => resolve(stripAnsi(o).trim()));
    c.on('error', (e) => resolve(e.message));
  });
  return {
    loggedIn: /logged in/i.test(out) && !/not logged in/i.test(out), detail: out,
    login: codexLogin ? { status: codexLogin.status, url: codexLogin.url, code: codexLogin.code } : null,
  };
}

/** 先 SIGINT 整个进程组，宽限期后还在就 SIGKILL */
function interrupt(run: Run, graceMs: number): void {
  if (run.status !== 'running' || !run.child.pid) return;
  const pg = -run.child.pid;
  try { process.kill(pg, 'SIGINT'); } catch {}
  clearTimeout(run.killTimer);
  run.killTimer = setTimeout(() => { try { process.kill(pg, 'SIGKILL'); } catch {} }, graceMs);
}

// 结束超过一小时的轮次不再记着
setInterval(() => {
  for (const [id, r] of runs) if (r.endedAt && Date.now() - r.endedAt > 3600_000) runs.delete(id);
}, 600_000).unref();

// ---- HTTP ----

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function authed(req: IncomingMessage): boolean {
  const got = Buffer.from(String(req.headers.authorization ?? ''));
  const want = Buffer.from(`Bearer ${TOKEN}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function body(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > 4 * 1024 * 1024) throw new HttpError(413, '请求太大');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString();
  try { return text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, '不是合法 JSON'); }
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

function stream(req: IncomingMessage, res: ServerResponse, url: URL): void {
  // 带上次的 boot：盒子重启过，游标就从头算
  const after = url.searchParams.get('boot') === BOOT ? Number(url.searchParams.get('after') ?? 0) : 0;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-pagent-boot': BOOT });
  res.write(': hello\n\n');
  for (const ev of events) {
    if (ev.seq > after) res.write(`id: ${ev.seq}\ndata: ${JSON.stringify({ seq: ev.seq, type: ev.type, data: ev.data })}\n\n`);
  }
  subscribers.add(res);
  const beat = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => { clearInterval(beat); subscribers.delete(res); });
}

/** 屏幕 MCP 的凭据：这一轮的 run token，轮次结束即失效 */
function runFor(req: IncomingMessage): Run | null {
  const run = runs.get(String(req.headers['x-pagent-run'] ?? ''));
  if (!run || run.status !== 'running') return null;
  const got = Buffer.from(String(req.headers.authorization ?? ''));
  const want = Buffer.from(`Bearer ${run.token}`);
  return got.length === want.length && timingSafeEqual(got, want) ? run : null;
}

const NOVNC = '/usr/share/novnc';
const MIME: Record<string, string> = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://box');
    if (url.pathname === '/mcp/screen') {
      if (req.method !== 'POST') return res.writeHead(405).end();
      const run = runFor(req);
      if (!run) return send(res, 401, { error: 'bad run token' });
      const msg = await body(req);
      const call = (name: string, a: any) => screenTool(screens, run.agentId, name, a, run.secrets);
      const out = Array.isArray(msg) ? (await Promise.all(msg.map((m) => rpc(m, call)))).filter(Boolean) : await rpc(msg, call);
      if (!out || (Array.isArray(out) && !out.length)) return res.writeHead(202).end();
      return send(res, 200, out);
    }
    if (!authed(req)) return send(res, 401, { error: 'unauthorized' });
    const route = `${req.method} ${url.pathname}`;
    if (req.method === 'GET' && url.pathname.startsWith('/novnc/')) {
      const file = normalize(join(NOVNC, url.pathname.slice('/novnc/'.length)));
      if (!file.startsWith(`${NOVNC}/`) || !existsSync(file)) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'max-age=3600' });
      return res.end(readFileSync(file));
    }
    if (route === 'GET /api/codex/status') return send(res, 200, await codexStatus());
    if (route === 'POST /api/codex/login') return send(res, 200, await startCodexLogin());
    if (route === 'POST /api/codex/logout') {
      await new Promise((r) => spawn('codex', ['logout'], { env: { ...process.env, CODEX_HOME } }).on('close', r));
      return send(res, 200, await codexStatus());
    }
    if (route === 'GET /api/screens') return send(res, 200, { screens: screens.list().map((s) => screens.status(s)) });
    if (route === 'POST /api/screen') {
      const { agentId, chrome } = await body(req);
      if (!AGENT_RE.test(String(agentId))) throw new HttpError(400, 'agentId 不合法');
      const s = chrome ? await screens.ensureChrome(agentId) : await screens.ensureDisplay(agentId);
      return send(res, 200, screens.status(s));
    }
    if (route === 'POST /api/screen/takeover') {
      const { agentId, on } = await body(req);
      if (!AGENT_RE.test(String(agentId))) throw new HttpError(400, 'agentId 不合法');
      const s = await screens.ensureChrome(agentId);
      s.takenOver = !!on;
      push('screen.changed', { what: on ? 'takeover' : 'handback', ...screens.status(s) });
      return send(res, 200, screens.status(s));
    }
    if (route === 'GET /health') return send(res, 200, { ok: true, version: VERSION, boot: BOOT, uptime: process.uptime() });
    if (route === 'GET /events') return stream(req, res, url);
    if (route === 'GET /api/runs') {
      return send(res, 200, {
        boot: BOOT, seq,
        runs: [...runs.values()].map((r) => ({ runId: r.runId, agentId: r.agentId, status: r.status, startedAt: r.startedAt })),
      });
    }
    if (route === 'POST /api/runTurn') {
      const run = runTurn(await body(req));
      return send(res, 200, { ok: true, boot: BOOT, pid: run.child.pid ?? null });
    }
    if (route === 'POST /api/interrupt') {
      const { runId, graceMs } = await body(req);
      const run = runs.get(String(runId));
      if (!run) throw new HttpError(404, '没有这一轮');
      interrupt(run, Number(graceMs ?? 8000));
      return send(res, 200, { ok: true, status: run.status });
    }
    if (route === 'POST /api/ack') {
      ack(Number((await body(req)).seq ?? 0));
      return send(res, 200, { ok: true, retained: events.length });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (!res.headersSent) send(res, status, { error: (e as Error).message });
  }
});

// 看屏幕 / 接管：/vnc/<agentId> 的 WebSocket 原样转给这块屏幕的 websockify
server.on('upgrade', async (req, sock, head) => {
  const m = /^\/vnc\/([A-Za-z0-9_-]{1,64})$/.exec(new URL(req.url ?? '/', 'http://box').pathname);
  if (!m || !authed(req)) { sock.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
  try {
    const s = await screens.ensureDisplay(m[1]);
    const up = net.connect(6080 + s.n, '127.0.0.1', () => {
      const headers = Object.entries(req.headers).filter(([k]) => k !== 'authorization')
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\r\n');
      up.write(`GET / HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head.length) up.write(head);
      sock.pipe(up).pipe(sock);
    });
    const end = () => { sock.destroy(); up.destroy(); };
    up.on('error', end); sock.on('error', end); sock.on('close', end);
    const tick = setInterval(() => screens.touch(m[1]), 30_000);
    sock.on('close', () => clearInterval(tick));
  } catch (e) {
    sock.end(`HTTP/1.1 500 Internal Server Error\r\n\r\n${(e as Error).message}`);
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`pagent-host ${VERSION} boot=${BOOT} :${PORT}`));

// 盒子停止时把进行中的轮次一起停掉（容器反正要没了）
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    for (const r of runs.values()) interrupt(r, 2000);
    screens.stopAll();
    setTimeout(() => process.exit(0), [...runs.values()].some((r) => r.status === 'running') ? 2500 : 0);
  });
}

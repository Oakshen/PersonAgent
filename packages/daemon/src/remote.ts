// 远程入口（手机 / 浏览器）：静态 Web 控制台 + /api。只做"看、聊、审批、打断、核对"，管理操作留在本机 CLI。
// 默认只发布到宿主 127.0.0.1，经 tailscale serve 提供 HTTPS 给手机。
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Store } from './store.ts';
import type { Runner } from './runner.ts';
import type { Approvals } from './approvals.ts';
import { type Devices, DeviceError, type Scope } from './devices.ts';
import { readBody, send } from './hooks.ts';
import {
  ServiceError, botByName, botHistory, createBot, decideApproval, reconcileAction, sendMessage, snapshot, streamEvents,
} from './service.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json',
};
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

type Auth = { deviceId: string; name: string; scopes: Scope[]; sessionExpires: string };
type Handler = (m: RegExpMatchArray, body: any, ctx: { url: URL; res: http.ServerResponse; auth: Auth }) => unknown;

const STREAMING = Symbol('streaming');

export function startRemote(store: Store, runner: Runner, approvals: Approvals, devices: Devices, webDir: string, port: number): http.Server {
  // 每个设备当前打开的事件流，撤销时全部断开
  const streams = new Map<string, Set<() => void>>();
  devices.onRevoke((id) => {
    for (const close of streams.get(id) ?? []) close();
    streams.delete(id);
  });

  const need = (auth: Auth, scope: Scope) => {
    if (!auth.scopes.includes(scope)) throw new ServiceError(403, `该设备没有 ${scope} 权限`);
  };

  const open: [string, RegExp, (body: any) => unknown][] = [
    ['POST', /^\/api\/pair$/, (b) => devices.pair(b?.code, b?.publicKey)],
    ['POST', /^\/api\/auth\/challenge$/, (b) => devices.challenge(b?.deviceId)],
    ['POST', /^\/api\/auth\/login$/, (b) => devices.login(b?.deviceId, b?.nonce, b?.signature)],
  ];

  const routes: [string, RegExp, Handler][] = [
    ['GET', /^\/api\/me$/, (_m, _b, { auth }) => auth],
    ['GET', /^\/api\/state$/, () => snapshot(store)],
    ['POST', /^\/api\/bots$/, (_m, b, { auth }) => {
      need(auth, 'admin');
      // 远程只能设名字、人设、模型；策略和插件只能在服务器 CLI 上改
      const bot = createBot(store, { name: b?.name, persona: b?.persona, model: b?.model });
      return { id: bot.id, name: bot.name };
    }],
    ['PATCH', /^\/api\/bots\/([^/]+)$/, (m, b, { auth }) => {
      need(auth, 'admin');
      const bot = botByName(store, m[1]);
      store.run('UPDATE bots SET persona = ?, model = ? WHERE id = ?',
        typeof b?.persona === 'string' ? b.persona.slice(0, 4000) : bot.persona,
        b?.model === undefined ? bot.model : (b.model || null), bot.id);
      return { ok: true };
    }],
    ['GET', /^\/api\/bots\/([^/]+)\/history$/, (m, _b, { url }) => botHistory(store, m[1], Number(url.searchParams.get('limit') ?? 300))],
    ['POST', /^\/api\/bots\/([^/]+)\/messages$/, (m, b, { auth }) => {
      need(auth, 'chat');
      return sendMessage(store, runner, m[1], b?.text, { interrupt: !!b?.interrupt });
    }],
    ['POST', /^\/api\/runs\/([^/]+)\/interrupt$/, (m, _b, { auth }) => {
      need(auth, 'chat');
      return { ok: runner.interrupt(m[1], `设备 ${auth.name} 中断`) };
    }],
    ['POST', /^\/api\/approvals\/([^/]+)$/, (m, b, { auth }) => {
      need(auth, 'approve');
      return decideApproval(approvals, m[1], b?.decision, `device:${auth.name}`);
    }],
    ['POST', /^\/api\/actions\/([^/]+)\/resolve$/, (m, b, { auth }) => {
      need(auth, 'approve');
      return reconcileAction(store, m[1], b?.outcome, `device:${auth.name}`, typeof b?.note === 'string' ? b.note.slice(0, 200) : undefined);
    }],
    ['GET', /^\/api\/events$/, (_m, _b, { url, res, auth }) => {
      const close = streamEvents(store, res, Number(url.searchParams.get('after') ?? 0));
      const set = streams.get(auth.deviceId) ?? new Set();
      set.add(close);
      streams.set(auth.deviceId, set);
      // 会话到期时也断开，客户端会重新登录再续上
      const t = setTimeout(close, Math.max(0, Date.parse(auth.sessionExpires) - Date.now()));
      res.on('close', () => { set.delete(close); clearTimeout(t); });
      return STREAMING;
    }],
  ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://pagent');
    try {
      if (!url.pathname.startsWith('/api/')) return serveStatic(webDir, url.pathname, req.method ?? 'GET', res);
      // 跨站请求一律拒绝：Origin 存在时必须与 Host 同源
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw new ServiceError(403, '跨站请求被拒绝');
      const body = async () => {
        if (req.method !== 'POST' && req.method !== 'PATCH') return undefined;
        const raw = await readBody(req, 64 * 1024);
        return raw ? JSON.parse(raw) : undefined;
      };
      for (const [method, re, fn] of open) {
        if (method === req.method && re.test(url.pathname)) return send(res, 200, fn(await body()));
      }
      const a = devices.authenticate(req.headers.authorization);
      if (!a) return send(res, 401, { error: '未登录或会话已失效' });
      const auth: Auth = { deviceId: a.device.id, name: a.device.name, scopes: a.scopes, sessionExpires: a.sessionExpires };
      for (const [method, re, fn] of routes) {
        const m = decodeURIComponent(url.pathname).match(re);
        if (!m || method !== req.method) continue;
        const out = fn(m, await body(), { url, res, auth });
        if (out !== STREAMING) send(res, 200, out);
        return;
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      const code = e instanceof ServiceError || e instanceof DeviceError ? e.status : e instanceof SyntaxError ? 400 : 500;
      if (code === 500) console.error(e);
      if (!res.headersSent) send(res, code, { error: (e as Error).message });
    }
  });
  server.listen(port, () => console.log(`remote :${port}`));
  return server;
}

function serveStatic(webDir: string, pathname: string, method: string, res: http.ServerResponse) {
  if (method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!/^[\w.-]+$/.test(file)) return send(res, 404, { error: 'not found' });
  try {
    const body = readFileSync(join(webDir, file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', ...SECURITY_HEADERS });
    res.end(body);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

// 远程入口（手机 / 浏览器）：静态 Web 控制台 + /api。看、聊、打断、新会话、管理记忆；插件等管理操作留在本机 CLI。
// 默认只发布到宿主 127.0.0.1，经 tailscale serve 提供 HTTPS 给手机。
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { extname, join } from 'node:path';
import type { Store } from './store.ts';
import type { Runner } from './runner.ts';
import type { Devices, Scope } from './devices.ts';
import { readBody, send } from './http.ts';
import {
  ServiceError, agentMemory, botByName, botHistory, createBot, editAgentMemory, newSession, sendMessage, snapshot, streamEvents,
} from './service.ts';
import { forgetGlobal, listGlobal, rememberGlobal } from './memory.ts';
import { ensureBox, gw } from './box.ts';
import { getSettings, patchSettings } from './settings.ts';
import { listSkills } from './skills.ts';
import { createGroup, deleteGroup, groupHistory, listGroups, postToGroup } from './collab.ts';
import { createRoutine, deleteRoutine, fireByWebhook, fireRoutine, listRoutines, updateRoutine, type RoutineRow } from './routines.ts';
import { sendPush, subscribe, unsubscribe, vapidPublicKey } from './push.ts';
import type { LocalExec } from './localexec.ts';
import { deleteSecret, listSecrets, setSecret } from './vault.ts';
import { engineOf } from './engines.ts';
import { config } from './config.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
};
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

type Auth = { deviceId: string; name: string; scopes: Scope[]; sessionExpires: string };
type Handler = (m: RegExpMatchArray, body: any, ctx: { url: URL; res: http.ServerResponse; auth: Auth }) => unknown | Promise<unknown>;

const STREAMING = Symbol('streaming');

export function startRemote(store: Store, runner: Runner, devices: Devices, webDir: string, port: number, localExec?: LocalExec): http.Server {
  // 每个设备当前打开的事件流，撤销时全部断开
  const streams = new Map<string, Set<() => void>>();
  devices.onRevoke((id) => {
    for (const close of streams.get(id) ?? []) close();
    streams.delete(id);
  });

  // 看屏幕用的短期令牌（浏览器的 WebSocket 带不了 Authorization 头）：绑定 Agent 和设备，5 分钟内有效
  const networkTokens = new Map<string, { botId: string; deviceId: string; exp: number }>();
  const issueNetworkToken = (botId: string, deviceId: string) => {
    for (const [t, v] of networkTokens) if (v.exp < Date.now()) networkTokens.delete(t);
    const t = randomBytes(24).toString('base64url');
    networkTokens.set(t, { botId, deviceId, exp: Date.now() + 5 * 60_000 });
    return t;
  };

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
      // 远程只能设名字、人设、模型；插件只能在服务器 CLI 上改
      const bot = createBot(store, { name: b?.name, persona: b?.persona, model: b?.model, engine: b?.engine });
      return { id: bot.id, name: bot.name };
    }],
    ['PATCH', /^\/api\/bots\/([^/]+)$/, (m, b, { auth }) => {
      need(auth, 'admin');
      const bot = botByName(store, m[1]);
      const engine = b?.engine === undefined ? engineOf(bot.engine) : engineOf(b.engine);
      store.run('UPDATE bots SET persona = ?, model = ?, engine = ? WHERE id = ?',
        typeof b?.persona === 'string' ? b.persona.slice(0, 4000) : bot.persona,
        b?.model === undefined ? bot.model : (b.model || null), engine, bot.id);
      // 换引擎：两种引擎的会话互不相通，开一条新会话（记忆都在）
      if (engine !== engineOf(bot.engine)) newSession(store, runner, bot.name, `${auth.name}（换成 ${engine === 'codex' ? 'Codex' : 'Claude'}）`);
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
    ['POST', /^\/api\/bots\/([^/]+)\/session$/, (m, _b, { auth }) => {
      need(auth, 'chat');
      return newSession(store, runner, m[1], auth.name);
    }],
    // 屏幕：确保显示器和 Chrome 在跑，发一个看屏幕用的短期令牌
    ['POST', /^\/api\/bots\/([^/]+)\/screen$/, async (m, _b, { auth }) => {
      const bot = botByName(store, m[1]);
      const st = await gw(await ensureBox(), 'POST', '/api/screen', { agentId: bot.id, chrome: true }, 40_000);
      return { ...st, networkToken: issueNetworkToken(bot.id, auth.deviceId) };
    }],
    // 接管 / 交还：接管期间 Agent 的屏幕工具暂停
    ['POST', /^\/api\/bots\/([^/]+)\/screen\/takeover$/, async (m, b, { auth }) => {
      need(auth, 'chat');
      const bot = botByName(store, m[1]);
      const st = await gw(await ensureBox(), 'POST', '/api/screen/takeover', { agentId: bot.id, on: !!b?.on }, 40_000);
      store.emit('screen.takeover', { on: !!b?.on, by: auth.name }, { botId: bot.id });
      return st;
    }],
    ['GET', /^\/api\/bots\/([^/]+)\/memory$/, (m) => agentMemory(store, m[1])],
    ['PUT', /^\/api\/bots\/([^/]+)\/memory\/([^/]+)$/, (m, b, { auth }) => {
      need(auth, 'admin');
      return editAgentMemory(store, m[1], m[2], String(b?.content ?? ''), auth.name);
    }],
    ['DELETE', /^\/api\/bots\/([^/]+)\/memory\/([^/]+)$/, (m, _b, { auth }) => {
      need(auth, 'admin');
      return editAgentMemory(store, m[1], m[2], null, auth.name);
    }],
    // Routine
    ['GET', /^\/api\/routines$/, (_m, _b, { url }) => {
      const bot = url.searchParams.get('bot');
      return listRoutines(store, bot ? botByName(store, bot).id : undefined);
    }],
    ['POST', /^\/api\/bots\/([^/]+)\/routines$/, (m, b, { auth }) => { need(auth, 'chat'); return createRoutine(store, botByName(store, m[1]).id, b ?? {}, auth.name); }],
    ['PATCH', /^\/api\/routines\/([^/]+)$/, (m, b, { auth }) => { need(auth, 'chat'); return updateRoutine(store, m[1], b ?? {}, auth.name); }],
    ['DELETE', /^\/api\/routines\/([^/]+)$/, (m, _b, { auth }) => { need(auth, 'chat'); deleteRoutine(store, m[1], auth.name); return { ok: true }; }],
    ['POST', /^\/api\/routines\/([^/]+)\/run$/, (m, _b, { auth }) => {
      need(auth, 'chat');
      const r = store.get<RoutineRow>('SELECT * FROM routines WHERE id = ?', m[1]);
      if (!r) throw new ServiceError(404, '没有这个 Routine');
      return fireRoutine(store, runner, r, 'manual');
    }],
    ['GET', /^\/api\/bots\/([^/]+)\/skills$/, (m) => listSkills(store, botByName(store, m[1]).id)],
    // 群聊
    ['GET', /^\/api\/groups$/, () => listGroups(store)],
    ['POST', /^\/api\/groups$/, (_m, b, { auth }) => { need(auth, 'chat'); return createGroup(store, b ?? {}, auth.name); }],
    ['DELETE', /^\/api\/groups\/([^/]+)$/, (m, _b, { auth }) => { need(auth, 'chat'); return deleteGroup(store, m[1], auth.name); }],
    ['GET', /^\/api\/groups\/([^/]+)\/history$/, (m) => ({ events: groupHistory(store, m[1]) })],
    ['POST', /^\/api\/groups\/([^/]+)\/messages$/, (m, b, { auth }) => { need(auth, 'chat'); return postToGroup(store, runner, m[1], String(b?.text ?? ''), auth.name); }],
    // 推送
    ['GET', /^\/api\/push\/key$/, () => ({ publicKey: vapidPublicKey() })],
    ['POST', /^\/api\/push\/subscribe$/, (_m, b, { auth }) => subscribe(store, auth.deviceId, b)],
    ['POST', /^\/api\/push\/unsubscribe$/, (_m, b, { auth }) => unsubscribe(store, auth.deviceId, b?.endpoint)],
    ['POST', /^\/api\/push\/test$/, (_m, _b, { auth }) => sendPush(store, { title: 'PersonAgent', body: `${auth.name} 的通知已打开`, url: '/' }, auth.deviceId)],
    // 本机执行：守护进程（local 权限）领任务、交结果；用户按电脑开关
    ['GET', /^\/api\/local-exec\/requests$/, (_m, _b, { url, res, auth }) => {
      need(auth, 'local');
      if (!localExec) throw new ServiceError(404, '没有启用本机执行');
      localExec.connect(auth.deviceId, res, url.searchParams.get('root') ?? '', url.searchParams.get('host') ?? '');
      return STREAMING;
    }],
    ['POST', /^\/api\/local-exec\/responses$/, (_m, b, { auth }) => { need(auth, 'local'); return localExec!.respond(auth.deviceId, b); }],
    ['GET', /^\/api\/machines$/, () => localExec?.machines() ?? []],
    ['PATCH', /^\/api\/machines\/([^/]+)$/, (m, b, { auth }) => { need(auth, 'admin'); return localExec!.setAllowed(m[1], !!b?.allowed, auth.name); }],
    // 保险箱：只能看名字，值只进不出
    ['GET', /^\/api\/secrets$/, (_m, _b, { auth }) => { need(auth, 'admin'); return listSecrets(store); }],
    ['PUT', /^\/api\/secrets\/([^/]+)$/, (m, b, { auth }) => { need(auth, 'admin'); return setSecret(store, m[1], b?.value, auth.name, b?.note); }],
    ['DELETE', /^\/api\/secrets\/([^/]+)$/, (m, _b, { auth }) => { need(auth, 'admin'); return deleteSecret(store, m[1], auth.name); }],
    ['GET', /^\/api\/settings$/, () => getSettings(store)],
    // 引擎登录状态：Claude 复用宿主登录；Codex 在盒子里用 ChatGPT 设备码登录（全部 Agent 共用一份）
    ['GET', /^\/api\/engines$/, async () => ({
      claude: { loggedIn: !!config.hostCred, detail: config.hostCred ? '复用服务器上已登录的 Claude 订阅' : '服务器上没有配置 Claude 登录' },
      codex: await gw(await ensureBox(), 'GET', '/api/codex/status').catch((e) => ({ loggedIn: false, detail: e.message })),
    })],
    ['POST', /^\/api\/engines\/codex\/login$/, async (_m, _b, { auth }) => {
      need(auth, 'admin');
      return gw(await ensureBox(), 'POST', '/api/codex/login', {}, 30_000);
    }],
    ['POST', /^\/api\/engines\/codex\/logout$/, async (_m, _b, { auth }) => {
      need(auth, 'admin');
      return gw(await ensureBox(), 'POST', '/api/codex/logout', {}, 30_000);
    }],
    ['PATCH', /^\/api\/settings$/, (_m, b, { auth }) => { need(auth, 'admin'); return patchSettings(store, b); }],
    ['GET', /^\/api\/memory$/, () => listGlobal(store)],
    ['POST', /^\/api\/memory$/, (_m, b, { auth }) => {
      need(auth, 'admin');
      return rememberGlobal(store, b?.text, { by: '用户' }, b?.replaces);
    }],
    ['DELETE', /^\/api\/memory\/([^/]+)$/, (m, _b, { auth }) => {
      need(auth, 'admin');
      forgetGlobal(store, m[1], '用户');
      return { ok: true };
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
      if (url.pathname.startsWith('/novnc/')) return await proxyNovnc(url.pathname, res);
      // webhook 触发 Routine：地址里的令牌就是凭据（不需要设备登录）
      const hook = /^\/hook\/([\w-]{16,64})$/.exec(url.pathname);
      if (hook && req.method === 'POST') return send(res, 200, fireByWebhook(store, runner, hook[1], await readBody(req, 64 * 1024)));
      if (!url.pathname.startsWith('/api/')) return serveStatic(webDir, url.pathname, req.method ?? 'GET', res);
      // 跨站请求一律拒绝：Origin 存在时必须与 Host 同源
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw new ServiceError(403, '跨站请求被拒绝');
      const body = async () => {
        if (req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'PUT') return undefined;
        const raw = await readBody(req, 1024 * 1024);
        return raw ? JSON.parse(raw) : undefined;
      };
      for (const [method, re, fn] of open) {
        if (method === req.method && re.test(url.pathname)) return send(res, 200, fn(await body()));
      }
      const a = devices.authenticate(req.headers.authorization);
      if (!a) return send(res, 401, { error: '未登录或会话已失效' });
      const auth: Auth = { deviceId: a.device.id, name: a.device.name, scopes: a.scopes, sessionExpires: a.sessionExpires };
      // 只有 local 权限的设备（本机执行守护进程）只能领任务、交结果
      if (!auth.scopes.some((s) => s === 'chat' || s === 'admin') && !url.pathname.startsWith('/api/local-exec/') && url.pathname !== '/api/me') {
        return send(res, 403, { error: '这台设备只能用于本机执行' });
      }
      for (const [method, re, fn] of routes) {
        const m = decodeURIComponent(url.pathname).match(re);
        if (!m || method !== req.method) continue;
        const out = await fn(m, await body(), { url, res, auth });
        if (out !== STREAMING) send(res, 200, out);
        return;
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      const code = typeof (e as any)?.status === 'number' ? (e as any).status : e instanceof SyntaxError ? 400 : 500;
      if (code === 500) console.error(e);
      if (!res.headersSent) send(res, code, { error: (e as Error).message });
    }
  });
  // 浏览器看屏幕：/api/vnc/<networkToken> 的 WebSocket → 盒子网关 /vnc/<agentId> → websockify
  server.on('upgrade', (req, sock, head) => {
    const m = /^\/api\/vnc\/([\w-]+)$/.exec(new URL(req.url ?? '/', 'http://pagent').pathname);
    const tok = m ? networkTokens.get(m[1]) : undefined;
    const origin = req.headers.origin;
    if (!tok || tok.exp < Date.now() || (origin && new URL(origin).host !== req.headers.host)) {
      sock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    ensureBox().then((box) => {
      const u = new URL(`${box.gatewayUrl}/vnc/${tok.botId}`);
      const up = http.request({
        host: u.hostname, port: u.port, path: u.pathname, method: 'GET',
        headers: {
          ...Object.fromEntries(Object.entries(req.headers).filter(([k]) => /^(sec-websocket-|upgrade$|connection$)/.test(k))),
          authorization: `Bearer ${box.gatewayToken}`,
        },
      });
      up.on('upgrade', (upRes, upSock, upHead) => {
        const lines = [`HTTP/1.1 101 Switching Protocols`, ...Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}`)];
        sock.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (upHead.length) sock.write(upHead);
        if (head.length) upSock.write(head);
        upSock.pipe(sock).pipe(upSock);
        const end = () => { sock.destroy(); upSock.destroy(); };
        upSock.on('error', end); sock.on('error', end); sock.on('close', end);
      });
      up.on('response', () => sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
      up.on('error', () => sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
      up.end();
    }).catch(() => sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
  });
  server.listen(port, () => console.log(`remote :${port}`));
  return server;
}

/** noVNC 的静态文件（盒子镜像里自带的那份） */
async function proxyNovnc(pathname: string, res: http.ServerResponse) {
  const box = await ensureBox();
  const r = await fetch(box.gatewayUrl + pathname, { headers: { authorization: `Bearer ${box.gatewayToken}` } });
  res.writeHead(r.status, {
    'content-type': r.headers.get('content-type') ?? 'application/octet-stream', 'cache-control': 'max-age=3600', ...SECURITY_HEADERS,
  });
  res.end(Buffer.from(await r.arrayBuffer()));
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

// 本机管理 API：只监听 unix socket（0600），worker 所在的网络够不到它。
// 手机 / 远程设备的入口在 P2 单独做（设备认证）。
import http from 'node:http';
import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from './config.ts';
import { type BotPluginRow, type PluginRow, PluginError, disable, enable, install } from './plugins.ts';
import { canonicalPermissions } from '../../protocol/src/plugin.ts';
import { type ActionRow, type ApprovalRow, type BotRow, type RunRow, type Store, newId, now } from './store.ts';
import { ServiceError, createBot, decideApproval, reconcileAction, sendMessage, streamEvents } from './service.ts';
import { type Devices, DeviceError, type Scope } from './devices.ts';
import { readBody, send } from './hooks.ts';
import type { Runner } from './runner.ts';
import type { Approvals } from './approvals.ts';
import type { Bot, PolicyRule } from '../../protocol/src/types.ts';

export const toBot = (r: BotRow): Bot => ({
  id: r.id, name: r.name, persona: r.persona, model: r.model,
  policy: JSON.parse(r.policy) as PolicyRule[], maxTurns: r.max_turns, dailyTurnBudget: r.daily_turn_budget,
  maxRunSeconds: r.max_run_seconds, maxActions: r.max_actions, createdAt: r.created_at,
});

const posInt = (v: unknown, name: string): number | undefined => {
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || (v as number) <= 0) throw new HttpError(400, `${name} 须为正整数`);
  return v as number;
};

class HttpError extends Error {
  code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}

export function startApi(store: Store, runner: Runner, approvals: Approvals, devices: Devices, sock: string): http.Server {
  const botByName = (name: string) => {
    const b = store.get<BotRow>('SELECT * FROM bots WHERE name = ?', name);
    if (!b) throw new HttpError(404, `没有名为 ${name} 的 Bot`);
    return b;
  };

  const routes: [string, RegExp, (m: RegExpMatchArray, body: any, url: URL, res: http.ServerResponse) => unknown][] = [
    ['GET', /^\/bots$/, () => store.all<BotRow>('SELECT * FROM bots ORDER BY created_at').map(toBot)],
    ['POST', /^\/bots$/, (_m, b) => toBot(createBot(store, b ?? {}))],
    ['GET', /^\/bots\/([^/]+)$/, (m) => toBot(botByName(m[1]))],
    ['PATCH', /^\/bots\/([^/]+)$/, (m, b) => {
      const bot = botByName(m[1]);
      store.run(
        `UPDATE bots SET persona = ?, model = ?, policy = ?, max_turns = ?, daily_turn_budget = ?, max_run_seconds = ?, max_actions = ?
         WHERE id = ?`,
        b.persona ?? bot.persona, b.model === undefined ? bot.model : b.model,
        b.policy ? JSON.stringify(b.policy) : bot.policy, posInt(b.maxTurns, 'maxTurns') ?? bot.max_turns,
        posInt(b.dailyTurnBudget, 'dailyTurnBudget') ?? bot.daily_turn_budget,
        posInt(b.maxRunSeconds, 'maxRunSeconds') ?? bot.max_run_seconds,
        posInt(b.maxActions, 'maxActions') ?? bot.max_actions, bot.id);
      return toBot(store.get<BotRow>('SELECT * FROM bots WHERE id = ?', bot.id)!);
    }],
    ['POST', /^\/bots\/([^/]+)\/messages$/, (m, b) =>
      sendMessage(store, runner, m[1], b?.text, { newThread: b?.newThread, interrupt: b?.interrupt })],
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
    ['POST', /^\/approvals\/([^/]+)$/, (m, b) => decideApproval(approvals, m[1], b?.decision, b?.by ?? 'cli')],
    ['POST', /^\/actions\/([^/]+)\/resolve$/, (m, b) => reconcileAction(store, m[1], b?.outcome, 'cli', b?.note)],
    ['POST', /^\/devices\/pair$/, (_m, b) => devices.createPairing(b?.name, (b?.scopes ?? ['chat', 'approve', 'admin']) as Scope[])],
    ['GET', /^\/devices$/, () => devices.list()],
    ['POST', /^\/devices\/([^/]+)\/revoke$/, (m) => ({ ok: devices.revoke(m[1]) })],
    ['GET', /^\/plugins$/, () => store.all<PluginRow>('SELECT * FROM plugins ORDER BY id').map(toPlugin)],
    ['GET', /^\/plugins\/([^/]+)$/, (m) => {
      const p = store.get<PluginRow>('SELECT * FROM plugins WHERE id = ?', m[1]);
      if (!p) throw new HttpError(404, `插件 ${m[1]} 未安装`);
      return toPlugin(p);
    }],
    // 安装：CLI 把插件目录打包成 {相对路径: base64} 上传，这里落到暂存目录再走校验安装
    ['POST', /^\/plugins$/, (_m, b) => {
      const files = b?.files as Record<string, string> | undefined;
      if (!files || typeof files !== 'object') throw new HttpError(400, '缺少 files');
      const stage = join(config.dataDir, 'plugins', '.staging', randomBytes(6).toString('hex'));
      try {
        for (const [rel, b64] of Object.entries(files)) {
          const n = normalize(rel);
          if (n.startsWith('..') || n.startsWith('/') || n.includes('\0')) throw new HttpError(400, `非法路径：${rel}`);
          mkdirSync(dirname(join(stage, n)), { recursive: true });
          writeFileSync(join(stage, n), Buffer.from(b64, 'base64'), { mode: 0o644 });
        }
        return toPlugin(install(store, stage));
      } catch (e) {
        if (e instanceof PluginError) throw new HttpError(400, e.message);
        throw e;
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
    }],
    ['GET', /^\/bots\/([^/]+)\/plugins$/, (m) => {
      const bot = botByName(m[1]);
      return store.all<BotPluginRow & { manifest: string; version: string }>(
        'SELECT bp.*, p.manifest, p.version FROM bot_plugins bp JOIN plugins p ON p.id = bp.plugin_id WHERE bp.bot_id = ?', bot.id)
        .map((r) => ({
          id: r.plugin_id, version: r.version, enabledAt: r.enabled_at,
          status: canonicalPermissions(JSON.parse(r.manifest).permissions) === r.granted ? 'active' : 'needs_consent',
        }));
    }],
    ['POST', /^\/bots\/([^/]+)\/plugins$/, (m, b) => {
      try { return enable(store, botByName(m[1]).id, b?.id); } catch (e) {
        if (e instanceof PluginError) throw new HttpError(404, e.message);
        throw e;
      }
    }],
    ['DELETE', /^\/bots\/([^/]+)\/plugins\/([^/]+)$/, (m) => ({ ok: disable(store, botByName(m[1]).id, m[2]) })],
    ['POST', /^\/backup$/, () => {
      const dir = join(config.dataDir, 'backups');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `pagent-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
      store.backup(file);
      // 只保留最近 10 份
      for (const old of readdirSync(dir).filter((f) => f.endsWith('.db')).sort().slice(0, -10)) rmSync(join(dir, old));
      return { file };
    }],
    ['GET', /^\/events$/, (_m, _b, url, res) => {
      const after = Number(url.searchParams.get('after') ?? 0);
      const filter = { threadId: url.searchParams.get('thread'), runId: url.searchParams.get('run'), botId: url.searchParams.get('bot') };
      if (url.searchParams.get('follow') !== '1') {
        return store.eventsAfter(after, 1000).filter((e) =>
          (!filter.threadId || e.threadId === filter.threadId) && (!filter.runId || e.runId === filter.runId) && (!filter.botId || e.botId === filter.botId));
      }
      streamEvents(store, res, after, filter);
      return STREAMING;
    }],
  ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://pagent');
    try {
      for (const [method, re, fn] of routes) {
        const m = decodeURIComponent(url.pathname).match(re);
        if (!m || method !== req.method) continue;
        const raw = req.method === 'GET' || req.method === 'DELETE' ? '' : await readBody(req, 20 * 1024 * 1024);
        const out = fn(m, raw ? JSON.parse(raw) : undefined, url, res);
        if (out !== STREAMING) send(res, 200, out);
        return;
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      const code = e instanceof HttpError ? e.code : e instanceof ServiceError || e instanceof DeviceError ? e.status : 500;
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

const toPlugin = (p: PluginRow) => ({ id: p.id, version: p.version, hash: p.hash, installedAt: p.installed_at, manifest: JSON.parse(p.manifest) });

// 浏览器登录共享（方案 8.2 的 B）：每个 Agent 的 Chrome 用自己的用户目录（多个 Chrome 不能共用一个），
// 由网关经 CDP 把 cookie 实时同步到一个共享的 cookie 罐，再推给其他 Chrome。
// 一个 Agent 登录了某网站（cookie 变了），几秒内别的 Agent 的 Chrome 也带上这些 cookie；新起的 Chrome 先灌入整罐。
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Cookie {
  name: string; value: string; domain: string; path: string; expires?: number; secure?: boolean; httpOnly?: boolean;
  sameSite?: string; session?: boolean; priority?: string; sourceScheme?: string; sourcePort?: number; partitionKey?: unknown;
}

const key = (c: Cookie) => `${c.name}\u0000${c.domain}\u0000${c.path}`;
const sig = (c: Cookie) => JSON.stringify([c.value, Math.round(c.expires ?? -1), !!c.secure, !!c.httpOnly, c.sameSite ?? '']);

/** 只保留 Storage.setCookies 认的字段 */
function param(c: Cookie): Record<string, unknown> {
  const p: Record<string, unknown> = { name: c.name, value: c.value, domain: c.domain, path: c.path, secure: !!c.secure, httpOnly: !!c.httpOnly };
  if (c.sameSite) p.sameSite = c.sameSite;
  if (!c.session && typeof c.expires === 'number' && c.expires > 0) p.expires = c.expires;
  return p;
}

/** 浏览器级 CDP 连接（只用 Storage 域） */
class Cdp {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  ready: Promise<void>;
  closed = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ready = new Promise((ok, fail) => {
      this.ws.addEventListener('open', () => ok());
      this.ws.addEventListener('error', () => fail(new Error('CDP 连接失败')));
    });
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.fail(new Error(m.error.message)); else p.ok(m.result);
    });
    this.ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.fail(new Error('CDP 连接已断开'));
      this.pending.clear();
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((ok, fail) => {
      this.pending.set(id, { ok, fail });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void { try { this.ws.close(); } catch {} }
}

interface Peer { cdp: Cdp; seen: Map<string, string> }

export class CookieJar {
  private dir: string;
  private jar = new Map<string, Cookie>();
  private peers = new Map<string, Peer>();
  private dirty = false;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    try { for (const c of JSON.parse(readFileSync(join(dir, 'cookies.json'), 'utf8')) as Cookie[]) this.jar.set(key(c), c); } catch {}
    setInterval(() => { this.sync().catch((e) => console.error('cookie 同步出错', e.message)); }, 3000).unref();
  }

  /** 新起的 Chrome：灌入整罐，然后纳入同步 */
  async attach(agentId: string, port: number): Promise<void> {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string };
    const cdp = new Cdp(v.webSocketDebuggerUrl);
    await cdp.ready;
    const now = Date.now() / 1000;
    const live = [...this.jar.values()].filter((c) => c.session || !c.expires || c.expires <= 0 || c.expires > now);
    if (live.length) await cdp.send('Storage.setCookies', { cookies: live.map(param) });
    const seen = new Map<string, string>();
    for (const c of (await cdp.send('Storage.getCookies')).cookies as Cookie[]) seen.set(key(c), sig(c));
    this.peers.get(agentId)?.cdp.close();
    this.peers.set(agentId, { cdp, seen });
  }

  detach(agentId: string): void {
    this.peers.get(agentId)?.cdp.close();
    this.peers.delete(agentId);
  }

  /** 找出每个 Chrome 自上次以来变了的 cookie（新增 / 改了 / 删了），并入罐子再推给其他 Chrome */
  private async sync(): Promise<void> {
    for (const [agentId, peer] of this.peers) {
      if (peer.cdp.closed) { this.peers.delete(agentId); continue; }
      let cookies: Cookie[];
      try { cookies = (await peer.cdp.send('Storage.getCookies')).cookies; } catch { continue; }
      const now = new Map(cookies.map((c) => [key(c), c] as const));
      const changed: Cookie[] = [];
      for (const [k, c] of now) if (peer.seen.get(k) !== sig(c)) changed.push(c);
      const removed = [...peer.seen.keys()].filter((k) => !now.has(k));
      peer.seen = new Map([...now].map(([k, c]) => [k, sig(c)]));
      if (!changed.length && !removed.length) continue;

      const deletions: Cookie[] = [];
      for (const c of changed) this.jar.set(key(c), c);
      for (const k of removed) {
        const old = this.jar.get(k);
        if (old) deletions.push({ ...old, value: '', expires: 1, session: false });
        this.jar.delete(k);
      }
      this.dirty = true;
      // 推给其他 Chrome；删掉的用一个过期时间在过去的同名 cookie 覆盖
      const push = [...changed, ...deletions].map(param);
      for (const [other, p] of this.peers) {
        if (other === agentId || p.cdp.closed) continue;
        try {
          await p.cdp.send('Storage.setCookies', { cookies: push });
          for (const c of changed) p.seen.set(key(c), sig(c));
          for (const c of deletions) p.seen.delete(key(c));
        } catch {}
      }
    }
    if (this.dirty) this.save();
  }

  private save(): void {
    const f = join(this.dir, 'cookies.json');
    writeFileSync(`${f}.tmp`, JSON.stringify([...this.jar.values()]), { mode: 0o600 });
    renameSync(`${f}.tmp`, f);
    chmodSync(f, 0o600);
    this.dirty = false;
  }

  size(): number { return this.jar.size; }
}

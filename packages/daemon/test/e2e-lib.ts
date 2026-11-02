// e2e 公共工具：对着运行中的 pagentd（unix socket + 127.0.0.1:7780）配对设备、登录、读事件流。
import http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

export const BASE = process.env.PAGENT_REMOTE ?? 'http://127.0.0.1:7780';
export const SOCK = process.env.PAGENT_SOCK ?? join(homedir(), 'pagent/run/api.sock');
export const BOT = process.env.PAGENT_E2E_BOT ?? 'tester';

export function local(method: string, path: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCK, path, method, headers: { 'content-type': 'application/json' } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => (res.statusCode! >= 400 ? reject(new Error(d)) : resolve(d ? JSON.parse(d) : null)));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

export async function req(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

/** 模拟一台设备：本地生成不可导出的 P-256 密钥，配对后用签名登录 */
export async function device(name: string, scopes = ['chat', 'admin']) {
  const { code } = await local('POST', '/devices/pair', { name, scopes });
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const p = await req('POST', '/api/pair', { code, publicKey });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  const d = { id: p.data.deviceId as string, code, keys, token: '' };
  await login(d);
  return d;
}
export async function login(d: { id: string; keys: CryptoKeyPair; token: string }) {
  const { data: { nonce } } = await req('POST', '/api/auth/challenge', { deviceId: d.id });
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, d.keys.privateKey, new TextEncoder().encode(`pagent-login:${nonce}`));
  const r = await req('POST', '/api/auth/login', { deviceId: d.id, nonce, signature: Buffer.from(sig).toString('base64') });
  d.token = r.data?.token;
  return r;
}

/** 读 SSE：返回事件数组和关闭函数；ended 在服务端断开时 resolve */
export function subscribe(token: string, after: number) {
  const events: any[] = [];
  const ac = new AbortController();
  const ended = (async () => {
    const res = await fetch(`${BASE}/api/events?after=${after}`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return 'server-closed';
      buf += value;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
        buf = buf.slice(i + 2);
        if (line) events.push(JSON.parse(line.slice(6)));
      }
    }
  })().catch((e) => (ac.signal.aborted ? 'client-closed' : `error: ${e.message}`));
  return { events, close: () => ac.abort(), ended };
}

export const waitFor = async <T>(fn: () => T | undefined | false, ms = 120_000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 300));
  }
};


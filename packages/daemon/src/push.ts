// Web Push（RFC 8030 / 8291 aes128gcm / 8292 VAPID），零依赖。
// 设备在 Web 控制台里订阅；Agent 需要你（选择卡、接管）或有新消息要告诉你（notify_user、Routine 有新内容）时推送。
import {
  type KeyObject, createCipheriv, createECDH, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign,
} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Store, now } from './store.ts';
import { config } from './config.ts';
import type { PagentEvent } from '../../protocol/src/types.ts';

const b64u = (b: Buffer) => b.toString('base64url');

interface Vapid { priv: KeyObject; pubRaw: Buffer }
let vapid: Vapid | null = null;

/** VAPID 密钥：第一次用时生成，存在数据目录 */
export function vapidKeys(): Vapid {
  if (vapid) return vapid;
  const f = join(config.dataDir, 'vapid.pem');
  if (!existsSync(f)) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    writeFileSync(f, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  const priv = createPrivateKey(readFileSync(f));
  const jwk = createPublicKey(priv).export({ format: 'jwk' }) as { x: string; y: string };
  vapid = { priv, pubRaw: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]) };
  return vapid;
}

export const vapidPublicKey = () => b64u(vapidKeys().pubRaw);

const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

/** RFC 8291：用订阅的 p256dh / auth 加密一条消息（单个记录） */
export function encrypt(payload: Buffer, uaPublic: Buffer, authSecret: Buffer, opts: { salt?: Buffer; asPrivate?: Buffer } = {}): Buffer {
  const ecdh = createECDH('prime256v1');
  if (opts.asPrivate) ecdh.setPrivateKey(opts.asPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = opts.salt ?? randomBytes(16);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);
  const c = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([payload, Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

function vapidHeader(endpoint: string): string {
  const { priv, pubRaw } = vapidKeys();
  const enc = (o: unknown) => b64u(Buffer.from(JSON.stringify(o)));
  const data = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:pagent@localhost' })}`;
  const sig = sign('sha256', Buffer.from(data), { key: priv, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u(sig)}, k=${b64u(pubRaw)}`;
}

interface SubRow { endpoint: string; device_id: string; p256dh: string; auth: string }

export function subscribe(store: Store, deviceId: string, sub: any) {
  const endpoint = String(sub?.endpoint ?? '');
  const p256dh = String(sub?.keys?.p256dh ?? '');
  const auth = String(sub?.keys?.auth ?? '');
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) throw Object.assign(new Error('订阅信息不完整'), { status: 400 });
  store.run(
    `INSERT INTO push_subs(endpoint, device_id, p256dh, auth, created_at) VALUES (?,?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET device_id = excluded.device_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    endpoint, deviceId, p256dh, auth, now());
  return { ok: true };
}

export function unsubscribe(store: Store, deviceId: string, endpoint?: string) {
  if (endpoint) store.run('DELETE FROM push_subs WHERE device_id = ? AND endpoint = ?', deviceId, endpoint);
  else store.run('DELETE FROM push_subs WHERE device_id = ?', deviceId);
  return { ok: true };
}

export async function sendPush(store: Store, msg: { title: string; body: string; url?: string; tag?: string }, deviceId?: string): Promise<{ sent: number; failed: number }> {
  const subs = deviceId
    ? store.all<SubRow>('SELECT * FROM push_subs WHERE device_id = ?', deviceId)
    : store.all<SubRow>('SELECT * FROM push_subs');
  let sent = 0, failed = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      const body = encrypt(Buffer.from(JSON.stringify(msg)), Buffer.from(s.p256dh, 'base64url'), Buffer.from(s.auth, 'base64url'));
      const r = await fetch(s.endpoint, {
        method: 'POST', body: new Uint8Array(body),
        headers: { 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'high', authorization: vapidHeader(s.endpoint) },
        signal: AbortSignal.timeout(10_000),
      });
      // 404 / 410：订阅已失效
      if (r.status === 404 || r.status === 410) store.run('DELETE FROM push_subs WHERE endpoint = ?', s.endpoint);
      if (r.ok) sent++; else { failed++; console.error('push', r.status, (await r.text()).slice(0, 200)); }
    } catch (e) { failed++; console.error('push', (e as Error).message); }
  }));
  return { sent, failed };
}

/** 哪些事件要推送：Agent 主动通知、等你回答的选择卡、请你接管屏幕 */
export function pushFor(store: Store, e: PagentEvent): void {
  const bot = e.botId ? store.get<{ name: string }>('SELECT name FROM bots WHERE id = ?', e.botId)?.name : null;
  const url = bot ? `/#bot=${encodeURIComponent(bot)}` : '/';
  let msg: { title: string; body: string; url: string; tag?: string } | null = null;
  if (e.type === 'notify') msg = { title: String(e.data.title ?? bot ?? 'PersonAgent'), body: String(e.data.body ?? ''), url, tag: `notify-${e.seq}` };
  if (e.type === 'ask.created') {
    msg = { title: `${bot} ${e.data.kind === 'takeover' ? '请你接管屏幕' : '在等你回答'}`, body: String(e.data.question ?? ''), url, tag: `ask-${e.data.askId}` };
  }
  if (msg) sendPush(store, msg).catch(() => {});
}

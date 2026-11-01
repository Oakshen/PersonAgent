// 远程设备：配对码（一次性、短时）→ 设备在本地生成 ECDSA P-256 密钥对，只上传公钥；
// 之后用"挑战—签名"换短期会话 token。撤销设备立即使其所有会话失效。
import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from 'node:crypto';
import { type Store, newId, now } from './store.ts';

// chat：发消息 / 打断；approve：审批 / 核对；admin：创建和修改 Bot（策略、插件仍只能在服务器 CLI 上改）
export type Scope = 'chat' | 'approve' | 'admin';
export const ALL_SCOPES: Scope[] = ['chat', 'approve', 'admin'];

export interface DeviceRow {
  id: string; name: string; public_key: string; scopes: string; created_at: string;
  last_seen_at: string | null; revoked_at: string | null;
}

const PAIR_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 12 * 3600_000;
const CHALLENGE_TTL_MS = 60_000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
// 去掉易混字符的 base32，10 位 ≈ 50 bit，配合 5 分钟有效期 + 限流足够抗猜
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const pairCode = () => [...randomBytes(10)].map((b) => ALPHABET[b % ALPHABET.length]).join('');

export class DeviceError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export class Devices {
  private store: Store;
  private challenges = new Map<string, { deviceId: string; expires: number }>();
  private failures: number[] = [];   // 最近的配对 / 认证失败时间，全局限流
  private revokeListeners = new Set<(deviceId: string) => void>();

  constructor(store: Store) {
    this.store = store;
  }

  /** 本机 CLI 调用：生成配对码。只返回明文一次，库里存哈希。 */
  createPairing(name: string, scopes: Scope[]): { code: string; expiresAt: string } {
    if (!name || name.length > 40) throw new DeviceError(400, '设备名 1~40 个字符');
    for (const s of scopes) if (!ALL_SCOPES.includes(s)) throw new DeviceError(400, `未知权限 ${s}`);
    const code = pairCode();
    const expiresAt = new Date(Date.now() + PAIR_TTL_MS).toISOString();
    this.store.run('INSERT INTO pairings(code_hash, name, scopes, expires_at, created_at) VALUES (?,?,?,?,?)',
      sha256(code), name, JSON.stringify(scopes), expiresAt, now());
    return { code, expiresAt };
  }

  /** 设备用配对码 + 公钥完成配对。配对码 CAS 消费，只能用一次。 */
  pair(code: string, publicKey: JsonWebKey): { deviceId: string; name: string; scopes: Scope[] } {
    this.throttle();
    if (publicKey?.kty !== 'EC' || publicKey?.crv !== 'P-256' || publicKey.d) {
      throw new DeviceError(400, '公钥必须是 P-256 的 EC 公钥（不能带私钥）');
    }
    try { createPublicKey({ key: publicKey, format: 'jwk' }); } catch { throw new DeviceError(400, '公钥无效'); }
    const hash = sha256(String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
    return this.store.tx(() => {
      const r = this.store.run(
        'UPDATE pairings SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?', now(), hash, now());
      if (r.changes === 0) {
        this.failures.push(Date.now());
        throw new DeviceError(403, '配对码无效、已使用或已过期');
      }
      const p = this.store.get<{ name: string; scopes: string }>('SELECT name, scopes FROM pairings WHERE code_hash = ?', hash)!;
      const deviceId = newId('dev');
      this.store.run('INSERT INTO devices(id, name, public_key, scopes, created_at) VALUES (?,?,?,?,?)',
        deviceId, p.name, JSON.stringify(publicKey), p.scopes, now());
      this.store.emit('device.paired', { deviceId, name: p.name, scopes: JSON.parse(p.scopes) });
      return { deviceId, name: p.name, scopes: JSON.parse(p.scopes) };
    });
  }

  challenge(deviceId: string): { nonce: string } {
    const d = this.store.get<DeviceRow>('SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL', deviceId);
    if (!d) throw new DeviceError(403, '设备不存在或已撤销');
    const nonce = randomBytes(24).toString('base64url');
    this.challenges.set(nonce, { deviceId, expires: Date.now() + CHALLENGE_TTL_MS });
    return { nonce };
  }

  /** 校验签名（WebCrypto ECDSA 输出的是 r||s，即 ieee-p1363 编码），签发会话 token */
  login(deviceId: string, nonce: string, signatureB64: string): { token: string; expiresAt: string } {
    this.throttle();
    const ch = this.challenges.get(nonce);
    this.challenges.delete(nonce); // 挑战一次性
    const d = this.store.get<DeviceRow>('SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL', deviceId);
    const ok = !!ch && ch.deviceId === deviceId && ch.expires > Date.now() && !!d && verify(
      'sha256', Buffer.from(`pagent-login:${nonce}`),
      { key: createPublicKey({ key: JSON.parse(d.public_key), format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(String(signatureB64 ?? ''), 'base64'),
    );
    if (!ok) {
      this.failures.push(Date.now());
      throw new DeviceError(403, '签名校验失败');
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    this.store.run('INSERT INTO device_sessions(token_hash, device_id, expires_at, created_at) VALUES (?,?,?,?)',
      sha256(token), deviceId, expiresAt, now());
    this.store.run('UPDATE devices SET last_seen_at = ? WHERE id = ?', now(), deviceId);
    return { token, expiresAt };
  }

  /** 每个远程请求都走这里：token 有效、未过期、设备未撤销 */
  authenticate(authorization: string | undefined): { device: DeviceRow; scopes: Scope[]; sessionExpires: string } | null {
    const m = /^Bearer (\S+)$/.exec(authorization ?? '');
    if (!m) return null;
    // 库里只存 token 的哈希，按哈希查找
    const row = this.store.get<DeviceRow & { session_expires: string }>(
      `SELECT d.*, s.expires_at AS session_expires FROM device_sessions s JOIN devices d ON d.id = s.device_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND d.revoked_at IS NULL`, sha256(m[1]), now());
    if (!row) return null;
    return { device: row, scopes: JSON.parse(row.scopes), sessionExpires: row.session_expires };
  }

  list(): Omit<DeviceRow, 'public_key'>[] {
    return this.store.all<DeviceRow>('SELECT * FROM devices ORDER BY created_at')
      .map(({ public_key: _, ...rest }) => rest);
  }

  revoke(deviceId: string): boolean {
    const changed = this.store.tx(() => {
      const r = this.store.run('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now(), deviceId);
      if (r.changes === 0) return false;
      this.store.run('DELETE FROM device_sessions WHERE device_id = ?', deviceId);
      this.store.emit('device.revoked', { deviceId });
      return true;
    });
    if (changed) for (const fn of this.revokeListeners) fn(deviceId);
    return changed;
  }

  onRevoke(fn: (deviceId: string) => void): () => void {
    this.revokeListeners.add(fn);
    return () => this.revokeListeners.delete(fn);
  }

  /** 全局限流：1 分钟内失败超过 20 次就暂停配对和登录 */
  private throttle(): void {
    const cutoff = Date.now() - 60_000;
    this.failures = this.failures.filter((t) => t > cutoff);
    if (this.failures.length >= 20) throw new DeviceError(429, '失败次数过多，请稍后再试');
  }
}

// 保险箱：密码和 token 在 pagentd 加密保存（AES-256-GCM，密钥文件只在数据目录里）。
// 每一轮整份交给盒子（同 Grok 的 setBoxSecrets：要么整份生效，要么不生效）：
// - 作为环境变量给 Agent 的命令用（$NAME）；
// - 网页登录时 Agent 调 screen 的 fill_secret，由网关直接把值打进输入框，不经过模型。
// 时间线上出现的值会被遮住。
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Store, now } from './store.ts';
import { config } from './config.ts';
import { ServiceError } from './service.ts';

const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

let key: Buffer | null = null;
function vaultKey(): Buffer {
  if (key) return key;
  const f = join(config.dataDir, 'vault.key');
  if (!existsSync(f)) writeFileSync(f, randomBytes(32), { mode: 0o600 });
  key = readFileSync(f);
  return key;
}

export function setSecret(store: Store, name: string, value: unknown, by: string, note?: unknown) {
  if (!NAME_RE.test(name)) throw new ServiceError(400, '名字只能用大写字母、数字和下划线，字母开头，例如 GITHUB_TOKEN');
  const v = String(value ?? '');
  if (!v || v.length > 8192) throw new ServiceError(400, '值不能为空，最长 8192 字');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', vaultKey(), iv);
  const ct = Buffer.concat([c.update(v, 'utf8'), c.final()]);
  store.tx(() => {
    store.run(
      `INSERT INTO secrets(name, ciphertext, iv, tag, note, updated_at, updated_by) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag,
         note = coalesce(excluded.note, secrets.note), updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      name, ct.toString('base64'), iv.toString('base64'), c.getAuthTag().toString('base64'),
      note === undefined ? null : String(note).slice(0, 200), now(), by);
    store.emit('secret.changed', { op: 'set', name, by });
  });
  return { ok: true };
}

export function deleteSecret(store: Store, name: string, by: string) {
  store.tx(() => {
    if (store.run('DELETE FROM secrets WHERE name = ?', name).changes === 0) throw new ServiceError(404, '没有这个条目');
    store.emit('secret.changed', { op: 'delete', name, by });
  });
  return { ok: true };
}

export function listSecrets(store: Store) {
  return store.all<{ name: string; note: string | null; updated_at: string; updated_by: string }>(
    'SELECT name, note, updated_at, updated_by FROM secrets ORDER BY name')
    .map((r) => ({ name: r.name, note: r.note, updatedAt: r.updated_at, updatedBy: r.updated_by }));
}

/** 整份解密（交给盒子用）；任何一条解不开就整份不给 */
export function allSecrets(store: Store): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of store.all<{ name: string; ciphertext: string; iv: string; tag: string }>('SELECT * FROM secrets')) {
    const d = createDecipheriv('aes-256-gcm', vaultKey(), Buffer.from(r.iv, 'base64'));
    d.setAuthTag(Buffer.from(r.tag, 'base64'));
    out[r.name] = Buffer.concat([d.update(Buffer.from(r.ciphertext, 'base64')), d.final()]).toString('utf8');
  }
  return out;
}

/** 把出现在文本里的保险箱值遮住（时间线、事件里用） */
export function redactor(secrets: Record<string, string>): (t: string) => string {
  const vals = Object.values(secrets).filter((v) => v.length >= 6).sort((a, b) => b.length - a.length);
  if (!vals.length) return (t) => t;
  return (t) => { let s = t; for (const v of vals) s = s.split(v).join('••••••'); return s; };
}

// 远程入口端到端测试：对着运行中的 pagentd 跑（需要本机 unix socket 和 127.0.0.1:7780）。
// 用法：node --test packages/daemon/test/remote.e2e.ts   （PAGENT_E2E_BOT 指定一个 Bash 需要审批的 Bot）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.PAGENT_REMOTE ?? 'http://127.0.0.1:7780';
const SOCK = process.env.PAGENT_SOCK ?? join(homedir(), 'pagent/run/api.sock');
const BOT = process.env.PAGENT_E2E_BOT ?? 'tester';

function local(method: string, path: string, body?: unknown): Promise<any> {
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

async function req(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

/** 模拟一台设备：本地生成不可导出的 P-256 密钥，配对后用签名登录 */
async function device(name: string, scopes = ['chat', 'approve', 'admin']) {
  const { code } = await local('POST', '/devices/pair', { name, scopes });
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const p = await req('POST', '/api/pair', { code, publicKey });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  const d = { id: p.data.deviceId as string, code, keys, token: '' };
  await login(d);
  return d;
}
async function login(d: { id: string; keys: CryptoKeyPair; token: string }) {
  const { data: { nonce } } = await req('POST', '/api/auth/challenge', { deviceId: d.id });
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, d.keys.privateKey, new TextEncoder().encode(`pagent-login:${nonce}`));
  const r = await req('POST', '/api/auth/login', { deviceId: d.id, nonce, signature: Buffer.from(sig).toString('base64') });
  d.token = r.data?.token;
  return r;
}

/** 读 SSE：返回事件数组和关闭函数；ended 在服务端断开时 resolve */
function subscribe(token: string, after: number) {
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

const waitFor = async <T>(fn: () => T | undefined | false, ms = 120_000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 300));
  }
};

test('配对码只能用一次；错误配对码被拒', async () => {
  const d = await device('e2e-once');
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = await crypto.subtle.exportKey('jwk', keys.publicKey);
  assert.equal((await req('POST', '/api/pair', { code: d.code, publicKey })).status, 403);
  assert.equal((await req('POST', '/api/pair', { code: 'AAAAAAAAAA', publicKey })).status, 403);
  await local('POST', `/devices/${d.id}/revoke`);
});

test('签名错误不能登录；挑战不能重放', async () => {
  const d = await device('e2e-sig');
  const { data: { nonce } } = await req('POST', '/api/auth/challenge', { deviceId: d.id });
  const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const bad = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, other.privateKey, new TextEncoder().encode(`pagent-login:${nonce}`));
  assert.equal((await req('POST', '/api/auth/login', { deviceId: d.id, nonce, signature: Buffer.from(bad).toString('base64') })).status, 403);
  // 同一个 nonce 已被消费，用正确签名也不行
  const good = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, d.keys.privateKey, new TextEncoder().encode(`pagent-login:${nonce}`));
  assert.equal((await req('POST', '/api/auth/login', { deviceId: d.id, nonce, signature: Buffer.from(good).toString('base64') })).status, 403);
  await local('POST', `/devices/${d.id}/revoke`);
});

test('权限范围：只有 chat 的设备不能审批、不能建 Bot', async () => {
  const d = await device('e2e-chat-only', ['chat']);
  assert.equal((await req('POST', '/api/approvals/apv_x', { decision: 'approve' }, d.token)).status, 403);
  assert.equal((await req('POST', '/api/bots', { name: 'x' }, d.token)).status, 403);
  assert.equal((await req('GET', '/api/state', undefined, d.token)).status, 200);
  await local('POST', `/devices/${d.id}/revoke`);
});

test('跨站请求被拒', async () => {
  const res = await fetch(`${BASE}/api/state`, { headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
});

test('审批全流程：断线续传不重不漏、两台设备抢同一审批、作废后不能再批准、撤销立即断流', async () => {
  const phone = await device('e2e-phone');
  const laptop = await device('e2e-laptop');
  const { data: st0 } = await req('GET', '/api/state', undefined, phone.token);

  // 1) 手机订阅事件，发一条会触发 Bash 审批的消息
  const sub1 = subscribe(phone.token, st0.seq);
  const sent = await req('POST', `/api/bots/${encodeURIComponent(BOT)}/messages`, { text: '用 Bash 执行 echo pagent-e2e，然后告诉我输出。' }, phone.token);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const started = await waitFor(() => sub1.events.find((e) => e.type === 'run.started'));

  // 2) 手机"断线"：记下最后的游标，期间事件继续产生
  const lastSeq = sub1.events.at(-1).seq;
  sub1.close();
  let approvalId: string | undefined;
  for (let i = 0; i < 200 && !approvalId; i++) {
    approvalId = (await req('GET', '/api/state', undefined, laptop.token)).data.approvals.find((a: any) => a.run_id === started.runId)?.id;
    if (!approvalId) await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(approvalId, '没有等到审批');

  // 3) 重连续传：拿到断线期间的事件，且没有重复
  const sub2 = subscribe(phone.token, lastSeq);
  await waitFor(() => sub2.events.find((e) => e.type === 'approval.requested' && e.data.approvalId === approvalId));
  const seqs = sub2.events.map((e) => e.seq);
  assert.ok(seqs[0] === lastSeq + 1 || seqs[0] > lastSeq, '续传起点不对');
  assert.equal(new Set(seqs).size, seqs.length, '续传有重复事件');
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), '事件乱序');

  // 4) 两台设备同时批准：只有一个成功，另一个 409
  const [a, b] = await Promise.all([
    req('POST', `/api/approvals/${approvalId}`, { decision: 'approve' }, phone.token),
    req('POST', `/api/approvals/${approvalId}`, { decision: 'deny' }, laptop.token),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], `${a.status} ${b.status}`);
  await waitFor(() => sub2.events.find((e) => e.type === 'run.finished' && e.runId === started.runId));

  // 5) 作废的审批：发一条新消息，等审批出现后立刻中断这一轮，再去批准 → 409
  await req('POST', `/api/bots/${encodeURIComponent(BOT)}/messages`, { text: '用 Bash 执行 echo second，然后告诉我输出。' }, phone.token);
  const second = await waitFor(() => sub2.events.find((e) => e.type === 'approval.requested' && e.data.approvalId !== approvalId));
  await req('POST', `/api/runs/${second.runId}/interrupt`, undefined, laptop.token);
  await waitFor(() => sub2.events.find((e) => e.type === 'run.finished' && e.runId === second.runId));
  const late = await req('POST', `/api/approvals/${second.data.approvalId}`, { decision: 'approve' }, phone.token);
  assert.equal(late.status, 409, JSON.stringify(late.data));

  // 6) 撤销手机：它的事件流被服务端立即断开，token 失效，也无法重新登录
  await local('POST', `/devices/${phone.id}/revoke`);
  assert.equal(await Promise.race([sub2.ended, new Promise((r) => setTimeout(() => r('still-open'), 3000))]), 'server-closed');
  assert.equal((await req('GET', '/api/state', undefined, phone.token)).status, 401);
  assert.equal((await login(phone)).status, 403);
  // 笔记本不受影响
  assert.equal((await req('GET', '/api/state', undefined, laptop.token)).status, 200);
  await local('POST', `/devices/${laptop.id}/revoke`);
});

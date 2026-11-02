// 远程入口端到端测试：对着运行中的 pagentd 跑（需要本机 unix socket 和 127.0.0.1:7780）。
// 用法：node --test packages/daemon/test/remote.e2e.ts   （PAGENT_E2E_BOT 指定用来测试的 Bot，会真的跑几轮 claude）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOT, BASE, local, req, device, login, subscribe, waitFor } from './e2e-lib.ts';

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

test('权限范围：只有 chat 的设备能聊天、看记忆，不能建 Bot、不能改记忆', async () => {
  const d = await device('e2e-chat-only', ['chat']);
  assert.equal((await req('POST', '/api/bots', { name: 'x' }, d.token)).status, 403);
  assert.equal((await req('POST', '/api/memory', { text: 'x' }, d.token)).status, 403);
  assert.equal((await req('PUT', `/api/bots/${encodeURIComponent(BOT)}/memory/MEMORY.md`, { content: 'x' }, d.token)).status, 403);
  assert.equal((await req('GET', '/api/memory', undefined, d.token)).status, 200);
  assert.equal((await req('GET', `/api/bots/${encodeURIComponent(BOT)}/memory`, undefined, d.token)).status, 200);
  assert.equal((await req('GET', '/api/state', undefined, d.token)).status, 200);
  // 审批接口已经没有了
  assert.equal((await req('POST', '/api/approvals/apv_x', { decision: 'approve' }, d.token)).status, 404);
  await local('POST', `/devices/${d.id}/revoke`);
});

test('跨站请求被拒', async () => {
  const res = await fetch(`${BASE}/api/state`, { headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
});

test('全流程：不出现审批、断线续传不重不漏、打断后记下结果不明的操作、选择卡闭环、新会话、撤销立即断流', async () => {
  const phone = await device('e2e-phone');
  const laptop = await device('e2e-laptop');
  const bot = encodeURIComponent(BOT);
  const { data: st0 } = await req('GET', '/api/state', undefined, phone.token);
  const say = (text: string, token = phone.token) => req('POST', `/api/bots/${bot}/messages`, { text }, token);

  // 1) 直接执行命令，没有任何审批
  const sub1 = subscribe(phone.token, st0.seq);
  assert.equal((await say('用 Bash 执行 echo pagent-e2e，然后告诉我输出。')).status, 200);
  const started = await waitFor(() => sub1.events.find((e) => e.type === 'run.started'));
  await waitFor(() => sub1.events.find((e) => e.type === 'tool.use' && e.runId === started.runId));

  // 2) 手机"断线"：记下最后的游标，期间事件继续产生；重连续传
  const lastSeq = sub1.events.at(-1).seq;
  sub1.close();
  await new Promise((r) => setTimeout(r, 1500));
  const sub2 = subscribe(phone.token, lastSeq);
  const fin1 = await waitFor(() => sub2.events.find((e) => e.type === 'run.finished' && e.runId === started.runId));
  assert.equal(fin1.data.status, 'succeeded', JSON.stringify(fin1.data));
  const seqs = sub2.events.map((e) => e.seq);
  assert.ok(seqs[0] > lastSeq, '续传起点不对');
  assert.equal(new Set(seqs).size, seqs.length, '续传有重复事件');
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), '事件乱序');
  const all = () => [...sub1.events, ...sub2.events];
  assert.ok(all().some((e) => e.type === 'tool.use' && e.data.name === 'Bash' && e.runId === started.runId));
  assert.ok(all().some((e) => e.type === 'assistant.text' && /pagent-e2e/.test(e.data.text)));

  // 3) 打断：长命令执行到一半停下，这一轮记为 interrupted，在途的 Bash 记为结果不明
  await say('用 Bash 执行 node -e "setTimeout(() => console.log(\'done\'), 60000)"，等它结束再告诉我输出。');
  const long = await waitFor(() => sub2.events.find((e) => e.type === 'tool.use' && e.data.name === 'Bash' && /setTimeout/.test(e.data.summary ?? '')));
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal((await req('POST', `/api/runs/${long.runId}/interrupt`, undefined, laptop.token)).data.ok, true);
  const fin2 = await waitFor(() => sub2.events.find((e) => e.type === 'run.finished' && e.runId === long.runId), 30_000);
  assert.equal(fin2.data.status, 'interrupted');
  assert.deepEqual(fin2.data.unconfirmed.map((a: any) => a.tool), ['Bash']);

  // 4) 选择卡：Bot 发卡后状态是 asking；用户回答后卡片关闭，Bot 接着做
  await say('我要你帮我在"苹果"和"香蕉"里选一个当下午茶，这得我来定：用选择卡问我，然后结束这一轮。');
  const ask = await waitFor(() => sub2.events.find((e) => e.type === 'ask.created'));
  await waitFor(() => sub2.events.find((e) => e.type === 'run.finished' && e.runId === ask.runId));
  const st1 = (await req('GET', '/api/state', undefined, phone.token)).data;
  assert.equal(st1.bots.find((b: any) => b.name === BOT).status, 'asking');
  const pick = ask.data.options[0];
  await say(pick);
  const answered = await waitFor(() => sub2.events.find((e) => e.type === 'ask.answered' && e.data.askId === ask.data.askId));
  assert.equal(answered.data.answer, pick);
  const next = await waitFor(() => sub2.events.find((e) => e.type === 'run.started' && e.seq > answered.seq));
  await waitFor(() => sub2.events.find((e) => e.type === 'run.finished' && e.runId === next.runId));

  // 5) 新会话：发出 session.new，Bot 的下一轮不带 --resume（新 session id）
  const before = sub2.events.filter((e) => e.type === 'run.init').at(-1).data.sessionId;
  assert.equal((await req('POST', `/api/bots/${bot}/session`, undefined, phone.token)).status, 200);
  await waitFor(() => sub2.events.find((e) => e.type === 'session.new'));
  await say('只回复"好"。');
  const init = await waitFor(() => sub2.events.find((e) => e.type === 'run.init' && e.data.sessionId !== before));
  assert.equal(init.data.permissionMode, 'bypassPermissions');
  await waitFor(() => sub2.events.find((e) => e.type === 'run.finished' && e.runId === init.runId));

  // 全程没有任何审批类事件
  assert.ok(!all().some((e) => /^(approval|action)\./.test(e.type)), '出现了审批事件');

  // 6) 撤销手机：它的事件流被服务端立即断开，token 失效，也无法重新登录
  await local('POST', `/devices/${phone.id}/revoke`);
  assert.equal(await Promise.race([sub2.ended, new Promise((r) => setTimeout(() => r('still-open'), 3000))]), 'server-closed');
  assert.equal((await req('GET', '/api/state', undefined, phone.token)).status, 401);
  assert.equal((await login(phone)).status, 403);
  // 笔记本不受影响
  assert.equal((await req('GET', '/api/state', undefined, laptop.token)).status, 200);
  await local('POST', `/devices/${laptop.id}/revoke`);
});

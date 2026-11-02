// 功能端到端测试：对着运行中的 pagentd 和盒子，用真模型跑保险箱、Routine、本机执行、屏幕、Codex、群聊协作。
// 用法：node --test packages/daemon/test/features.e2e.ts
//   PAGENT_E2E_BOT（默认 tester）、PAGENT_E2E_HELPER（群聊总管，默认 helper）、PAGENT_E2E_CODEX（Codex Bot，默认 codex助手）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { BOT, BASE, local, req, device, subscribe, waitFor } from './e2e-lib.ts';

const HELPER = process.env.PAGENT_E2E_HELPER ?? 'helper';
const CODEX = process.env.PAGENT_E2E_CODEX ?? 'codex助手';

/** 一台手机：配好对、订阅好事件流，用完撤销 */
async function session(name: string) {
  const d = await device(name);
  const { data: st } = await req('GET', '/api/state', undefined, d.token);
  const sub = subscribe(d.token, st.seq);
  const botId = (n: string) => st.bots.find((b: any) => b.name === n)?.id as string;
  const say = (bot: string, text: string) => req('POST', `/api/bots/${encodeURIComponent(bot)}/messages`, { text }, d.token);
  const call = (method: string, path: string, body?: unknown) => req(method, path, body, d.token);
  /** 某个 Bot 在 afterSeq 之后开始的下一轮，等它结束 */
  const nextRun = async (bot: string, afterSeq = 0, ms = 180_000) => {
    const id = botId(bot);
    const started = await waitFor(() => sub.events.find((e) => e.type === 'run.started' && e.botId === id && e.seq > afterSeq), ms);
    const finished = await waitFor(() => sub.events.find((e) => e.type === 'run.finished' && e.runId === started.runId), ms);
    const of = sub.events.filter((e) => e.runId === started.runId);
    return { started, finished, events: of, text: of.filter((e) => e.type === 'assistant.text').map((e) => e.data.text).join('\n') };
  };
  const lastSeq = () => sub.events.at(-1)?.seq ?? st.seq;
  const done = async () => { sub.close(); await local('POST', `/devices/${d.id}/revoke`); };
  return { d, st, sub, botId, say, call, nextRun, lastSeq, done };
}

test('保险箱：命令里用 pagent-secret 按需取，环境变量里没有，取用有记录，值不出现在事件里', async () => {
  const s = await session('e2e-secret');
  const value = `pagent-e2e-${randomBytes(6).toString('hex')}`;
  assert.equal((await s.call('PUT', '/api/secrets/E2E_TOKEN', { value, note: 'e2e' })).status, 200);
  const seq = s.lastSeq();
  await s.say(BOT, '用 Bash 依次执行这两条命令，把两行输出原样告诉我，不要解释：\n1. pagent-secret E2E_TOKEN | wc -c\n2. env | grep -c pagent-e2e || true');
  const run = await s.nextRun(BOT, seq);
  assert.equal(run.finished.data.status, 'succeeded', JSON.stringify(run.finished.data));
  assert.ok(run.events.some((e) => e.type === 'secret.used' && e.data.name === 'E2E_TOKEN'), '没有 secret.used');
  assert.match(run.text, new RegExp(`\\b${value.length}\\b`), `长度不对：${run.text}`);   // pagent-secret 输出不带换行
  assert.match(run.text, /\b0\b/, `环境变量里有凭据：${run.text}`);
  assert.ok(!JSON.stringify(s.sub.events).includes(value), '凭据的值出现在事件流里');
  await s.call('DELETE', '/api/secrets/E2E_TOKEN');
  await s.done();
});

test('Routine：手动运行能跑；上一次没跑完时再触发被跳过', async () => {
  const s = await session('e2e-routine');
  const { data: r } = await s.call('POST', `/api/bots/${encodeURIComponent(BOT)}/routines`, {
    name: 'e2e-慢任务', prompt: '用 Bash 执行 sleep 10，然后只回复 NO_NEWS', schedule: '0 3 1 1 *',
  });
  try {
    const seq = s.lastSeq();
    const first = await s.call('POST', `/api/routines/${r.id}/run`);
    assert.equal(first.status, 200);
    assert.ok(!first.data?.skipped, '第一次就被跳过了');
    await waitFor(() => s.sub.events.find((e) => e.type === 'run.started' && e.botId === s.botId(BOT) && e.seq > seq));
    const second = await s.call('POST', `/api/routines/${r.id}/run`);
    assert.equal(second.data?.skipped, true, JSON.stringify(second.data));
    await waitFor(() => s.sub.events.find((e) => e.type === 'routine.fired' && e.data.routineId === r.id && e.data.phase === 'skipped'), 5000);
    const run = await s.nextRun(BOT, seq);
    assert.equal(run.finished.data.status, 'succeeded', JSON.stringify(run.finished.data));
    // 跑完之后再触发就不跳过了
    const third = await s.call('POST', `/api/routines/${r.id}/run`);
    assert.ok(!third.data?.skipped);
    await s.nextRun(BOT, run.finished.seq);
  } finally {
    await s.call('DELETE', `/api/routines/${r.id}`);
    await s.done();
  }
});

/** 模拟用户电脑上的本机执行守护进程：拉任务，命令一律回 pagent-local-ok */
function fakeMachine(token: string) {
  const jobs: any[] = [];
  const ac = new AbortController();
  (async () => {
    const res = await fetch(`${BASE}/api/local-exec/requests?root=/tmp/e2e&host=e2e-host`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += value;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
        buf = buf.slice(i + 2);
        if (!line) continue;
        const msg = JSON.parse(line.slice(6));
        if (msg.type !== 'job') continue;
        jobs.push(msg);
        await req('POST', '/api/local-exec/responses', { id: msg.id, ok: true, exitCode: 0, stdout: 'pagent-local-ok\n', stderr: '', content: 'pagent-local-ok' }, token);
      }
    }
  })().catch(() => {});
  return { jobs, close: () => ac.abort() };
}

test('本机执行：打开后 Agent 能在电脑上执行；关掉后新任务被拒', async () => {
  const s = await session('e2e-local-admin');
  const machine = await device('e2e-machine', ['local']);
  const m = fakeMachine(machine.token);
  try {
    let online = false;
    for (let i = 0; i < 20 && !online; i++) {
      const { data } = await s.call('GET', '/api/machines');
      online = !!data.find((x: any) => x.id === machine.id)?.online;
      if (!online) await new Promise((r) => setTimeout(r, 300));
    }
    assert.ok(online, '模拟电脑没上线');
    assert.equal((await s.call('PATCH', `/api/machines/${machine.id}`, { allowed: true })).data.allowed, true);

    let seq = s.lastSeq();
    await s.say(BOT, '用 ExternalShell 在电脑 e2e-machine 上执行 echo hi，把输出原样告诉我。');
    const on = await s.nextRun(BOT, seq);
    assert.equal(on.finished.data.status, 'succeeded', JSON.stringify(on.finished.data));
    assert.equal(m.jobs.length, 1, '电脑没收到任务');
    assert.match(on.text, /pagent-local-ok/);

    assert.equal((await s.call('PATCH', `/api/machines/${machine.id}`, { allowed: false })).data.allowed, false);
    seq = s.lastSeq();
    await s.say(BOT, '再用 ExternalShell 在电脑 e2e-machine 上执行一次 echo hi。如果被拒绝，直接告诉我拒绝的原因，不要换别的办法。');
    const off = await s.nextRun(BOT, seq);
    assert.equal(off.finished.data.status, 'succeeded');
    assert.equal(m.jobs.length, 1, '关掉之后电脑还收到了任务');
    assert.doesNotMatch(off.text, /pagent-local-ok/);
  } finally {
    m.close();
    await local('POST', `/devices/${machine.id}/revoke`);
    await s.done();
  }
});

test('屏幕：打开显示器和 Chrome，Agent 能截图', async () => {
  const s = await session('e2e-screen');
  const { status, data } = await s.call('POST', `/api/bots/${encodeURIComponent(BOT)}/screen`);
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.display_up, true);
  assert.equal(data.chrome, true);
  const seq = s.lastSeq();
  await s.say(BOT, '用 screenshot 工具截一张你的屏幕，一句话告诉我看到了什么。');
  const run = await s.nextRun(BOT, seq);
  assert.equal(run.finished.data.status, 'succeeded', JSON.stringify(run.finished.data));
  assert.ok(run.events.some((e) => e.type === 'tool.use' && /screenshot/.test(e.data.name)), '没有调用 screenshot');
  await s.done();
});

test('Codex 引擎：能跑命令，第二轮接着同一个会话', async (t) => {
  const s = await session('e2e-codex');
  const { data: eng } = await s.call('GET', '/api/engines');
  if (!eng.codex?.loggedIn || !s.botId(CODEX)) { t.skip('Codex 没登录或没有 Codex Bot'); await s.done(); return; }
  let seq = s.lastSeq();
  await s.say(CODEX, '执行 shell 命令 echo pagent-codex，然后把输出原样告诉我。');
  const first = await s.nextRun(CODEX, seq);
  assert.equal(first.finished.data.status, 'succeeded', JSON.stringify(first.finished.data));
  assert.match(first.text, /pagent-codex/);
  seq = first.finished.seq;
  await s.say(CODEX, '上一条命令输出的是什么？只回复那个词。');
  const second = await s.nextRun(CODEX, seq);
  assert.equal(second.finished.data.status, 'succeeded');
  assert.match(second.text, /pagent-codex/);
  await s.done();
});

test('群聊协作：总管分派给成员，成员做完后总管只再跑一轮汇总', async () => {
  const s = await session('e2e-group');
  const { data: g } = await s.call('POST', '/api/groups', { name: `e2e-群-${randomBytes(2).toString('hex')}`, members: [HELPER, BOT], manager: HELPER });
  try {
    const seq = s.lastSeq();
    await s.call('POST', `/api/groups/${g.id}/messages`, {
      text: `请用 message_agent 让 ${BOT} 用 Bash 执行 echo pagent-group，等它回复后把它的输出汇总给我。你自己不要执行命令。`,
    });
    const assign = await s.nextRun(HELPER, seq);
    assert.equal(assign.finished.data.status, 'succeeded', JSON.stringify(assign.finished.data));
    assert.ok(assign.events.some((e) => e.type === 'tool.use' && /message_agent/.test(e.data.name)), '总管没有分派');
    const member = await s.nextRun(BOT, seq);
    assert.equal(member.finished.data.status, 'succeeded');
    const summary = await s.nextRun(HELPER, assign.finished.seq, 240_000);
    assert.ok(summary.started.seq > member.finished.seq, '总管没等成员做完就汇总了');
    assert.match(summary.text, /pagent-group/);
    // 再等几秒，确认总管没有多跑
    await new Promise((r) => setTimeout(r, 5000));
    const helperRuns = s.sub.events.filter((e) => e.type === 'run.started' && e.botId === s.botId(HELPER) && e.seq > seq);
    assert.equal(helperRuns.length, 2, `总管跑了 ${helperRuns.length} 轮`);
  } finally {
    await s.call('DELETE', `/api/groups/${g.id}`);
    await s.done();
  }
});

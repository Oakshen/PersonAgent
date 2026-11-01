import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/policy.ts';
import { Store, bus, newId, now } from '../src/store.ts';
import { Approvals } from '../src/approvals.ts';
import type { PagentEvent } from '../../protocol/src/types.ts';

test('policy: 默认规则', () => {
  assert.equal(evaluate([], 'Read', { file_path: '/etc/passwd' }).decision, 'allow');
  assert.equal(evaluate([], 'Write', { file_path: '/work/a.txt' }).decision, 'allow');
  assert.equal(evaluate([], 'Write', { file_path: '/home/agent/.claude/settings.json' }).decision, 'deny');
  assert.equal(evaluate([], 'Bash', { command: 'ls' }).decision, 'ask');
  assert.equal(evaluate([], 'Bash', { command: 'sleep 9', run_in_background: true }).decision, 'deny');
  assert.equal(evaluate([], 'mcp__x__y', {}).decision, 'ask');
});

test('policy: Bot 规则优先，正则整体匹配', () => {
  const rules = [{ tool: 'Bash', field: 'command', match: '(ls|pwd)( .*)?', decision: 'allow' as const }];
  assert.equal(evaluate(rules, 'Bash', { command: 'ls -la' }).decision, 'allow');
  assert.equal(evaluate(rules, 'Bash', { command: 'ls; rm -rf /' }).decision, 'ask');
  // 正则白名单挡不住命令拼接：Bash 的 allow 规则只是便利，安全边界在容器
  assert.equal(evaluate(rules, 'Bash', { command: 'ls ; rm -rf /' }).decision, 'allow');
  assert.equal(evaluate(rules, 'Bash', { command: 'rm -rf /' }).decision, 'ask');
  assert.equal(evaluate([{ tool: 'Bash', decision: 'deny' }], 'BashX', {}).decision, 'ask');
});

function fixture() {
  const store = new Store(':memory:');
  const botId = newId('bot');
  const threadId = newId('thr');
  const runId = newId('run');
  store.run("INSERT INTO bots(id, name, created_at) VALUES (?, 't', ?)", botId, now());
  store.run('INSERT INTO threads(id, bot_id, created_at) VALUES (?,?,?)', threadId, botId, now());
  store.run("INSERT INTO runs(id, thread_id, bot_id, status, hook_token, started_at) VALUES (?,?,?, 'running', 'x', ?)", runId, threadId, botId, now());
  const actionId = newId('act');
  store.run("INSERT INTO actions(id, run_id, tool, input, side_effect, status, created_at, updated_at) VALUES (?,?, 'Bash', '{}', 1, 'pending_approval', ?, ?)", actionId, runId, now(), now());
  return { store, ref: { botId, threadId, runId, actionId } };
}

test('outbox: 事件在提交后才广播，回滚则不广播', () => {
  const { store } = fixture();
  const seen: PagentEvent[] = [];
  const on = (e: PagentEvent) => seen.push(e);
  bus.on('event', on);
  store.tx(() => {
    store.emit('bot.created', { n: 1 });
    assert.equal(seen.length, 0);
  });
  assert.equal(seen.length, 1);
  assert.throws(() => store.tx(() => { store.emit('bot.created', { n: 2 }); throw new Error('boom'); }));
  assert.equal(seen.length, 1);
  assert.equal(store.eventsAfter(0).length, 1);
  bus.off('event', on);
});

test('approval: 只能决定一次，第二次 409 语义', async () => {
  const { store, ref } = fixture();
  const ap = new Approvals(store, 60);
  const p = ap.request(ref, 'Bash', { command: 'ls' });
  const id = store.get<{ id: string }>('SELECT id FROM approvals')!.id;
  assert.deepEqual(ap.settle(id, 'approved', 'phone'), { ok: true, current: 'approved' });
  assert.deepEqual(ap.settle(id, 'denied', 'cli'), { ok: false, current: 'approved' });
  assert.equal(await p, 'approved');
});

test('approval: 过期后批准无效', async () => {
  const { store, ref } = fixture();
  const ap = new Approvals(store, 60);
  const p = ap.request(ref, 'Bash', { command: 'ls' });
  const id = store.get<{ id: string }>('SELECT id FROM approvals')!.id;
  store.run("UPDATE approvals SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?", id);
  const r = ap.settle(id, 'approved', 'cli');
  assert.equal(r.ok, false);
  assert.equal(r.current, 'expired');
  assert.equal(await p, 'expired');
});

test('approval: 取消整轮', async () => {
  const { store, ref } = fixture();
  const ap = new Approvals(store, 60);
  const p = ap.request(ref, 'Bash', { command: 'ls' });
  ap.cancelRun(ref.runId);
  assert.equal(await p, 'cancelled');
});

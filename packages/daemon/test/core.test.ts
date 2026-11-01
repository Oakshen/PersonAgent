import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { PagentEvent } from '../../protocol/src/types.ts';

// runner / config 在导入时读环境变量
const data = mkdtempSync(join(tmpdir(), 'pagent-test-'));
Object.assign(process.env, { PAGENT_DATA: data, PAGENT_SOCK: join(data, 's'), PAGENT_ASSETS: data, PAGENT_EGRESS_RULES: join(data, 'r.json'), PAGENT_WEB_DIR: data });
const { Store, bus, newId, now } = await import('../src/store.ts');
const { Runner } = await import('../src/runner.ts');
const mem = await import('../src/memory.ts');
const { sendMessage, botStatus } = await import('../src/service.ts');
const { startMcpServer } = await import('../src/mcp.ts');
process.on('exit', () => rmSync(data, { recursive: true, force: true }));

// 不真的起容器：kick 什么都不做
class TestRunner extends Runner { kick() {} }

function fixture() {
  const store = new Store(':memory:');
  const botId = newId('bot');
  const threadId = newId('thr');
  const runId = newId('run');
  store.run("INSERT INTO bots(id, name, created_at) VALUES (?, '小助手', ?)", botId, now());
  store.run('INSERT INTO threads(id, bot_id, created_at) VALUES (?,?,?)', threadId, botId, now());
  store.run("INSERT INTO runs(id, thread_id, bot_id, status, hook_token, started_at) VALUES (?,?,?, 'running', 'tok', ?)", runId, threadId, botId, now());
  return { store, botId, threadId, runId };
}

function collect() {
  const seen: PagentEvent[] = [];
  const on = (e: PagentEvent) => seen.push(e);
  bus.on('event', on);
  return { seen, stop: () => bus.off('event', on) };
}

test('outbox: 事件在提交后才广播，回滚则不广播', () => {
  const { store } = fixture();
  const { seen, stop } = collect();
  store.tx(() => {
    store.emit('bot.created', { n: 1 });
    assert.equal(seen.length, 0);
  });
  assert.equal(seen.length, 1);
  assert.throws(() => store.tx(() => { store.emit('bot.created', { n: 2 }); throw new Error('boom'); }));
  assert.equal(seen.length, 1);
  stop();
});

test('全局记忆：新增、改写、删除都发 memory.updated，并记录来源', () => {
  const { store, botId, runId } = fixture();
  const { seen, stop } = collect();
  const a = mem.rememberGlobal(store, '用户习惯用简体中文', { botId, runId, by: '小助手' });
  assert.equal(a.sourceBot, '小助手');
  const b = mem.rememberGlobal(store, '用户只用简体中文交流', { botId, by: '小助手' }, a.id);
  assert.equal(b.id, a.id);
  assert.equal(mem.listGlobal(store).length, 1);
  mem.forgetGlobal(store, a.id, '用户');
  assert.equal(mem.listGlobal(store).length, 0);
  assert.deepEqual(seen.filter((e) => e.type === 'memory.updated').map((e) => e.data.op), ['add', 'update', 'delete']);
  assert.equal(seen[0].botId, botId);
  stop();
});

test('全局记忆：单条和总量有上限，空内容和不存在的编号被拒', () => {
  const { store } = fixture();
  assert.throws(() => mem.rememberGlobal(store, ' ', { by: 'x' }), /不能为空/);
  assert.throws(() => mem.rememberGlobal(store, 'a'.repeat(mem.GLOBAL_ENTRY_MAX + 1), { by: 'x' }), /最多/);
  assert.throws(() => mem.rememberGlobal(store, 'x', { by: 'x' }, 'mem_nope'), /没有编号/);
  for (let i = 0; i < mem.GLOBAL_TOTAL_MAX / 400; i++) mem.rememberGlobal(store, `${i}`.padEnd(400, '。'), { by: 'x' });
  assert.throws(() => mem.rememberGlobal(store, 'one more', { by: 'x' }), /上限/);
  // 改写已有条目不算新增
  const first = mem.listGlobal(store)[0];
  assert.ok(mem.rememberGlobal(store, '合并后的一条', { by: 'x' }, first.id));
});

test('Agent 记忆：文件名校验、读写、变化比对', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pagent-mem-'));
  assert.throws(() => mem.writeAgentFile(dir, '../x.md', 'a'));
  assert.throws(() => mem.writeAgentFile(dir, 'x.txt', 'a'));
  assert.throws(() => mem.writeAgentFile(dir, '.hidden.md', 'a'));
  const before = mem.readAgentFiles(dir);
  mem.writeAgentFile(dir, 'MEMORY.md', '- 部署在 claude-2\n');
  mem.writeAgentFile(dir, '运维.md', '# 运维\n');
  writeFileSync(join(dir, 'notes.txt'), '不是记忆文件');
  const mid = mem.readAgentFiles(dir);
  assert.deepEqual([...mid.keys()], ['MEMORY.md', '运维.md']);
  assert.deepEqual(mem.diffFiles(before, mid).map((c) => [c.file, c.op, c.added]),
    [['MEMORY.md', 'write', ['- 部署在 claude-2']], ['运维.md', 'write', ['# 运维']]]);
  mem.writeAgentFile(dir, 'MEMORY.md', '- 部署在 claude-2\n- 用 docker compose\n');
  mem.deleteAgentFile(dir, '运维.md');
  const after = mem.readAgentFiles(dir);
  assert.deepEqual(mem.diffFiles(mid, after).map((c) => [c.file, c.op, c.added]),
    [['MEMORY.md', 'write', ['- 用 docker compose']], ['运维.md', 'delete', []]]);
  assert.deepEqual(mem.diffFiles(after, after), []);
  rmSync(dir, { recursive: true });
});

test('系统提示：人设在前，两层记忆都带上，带编号', () => {
  const { store } = fixture();
  const m = mem.rememberGlobal(store, '用户叫 Oak', { by: '用户' });
  const sys = mem.systemPrompt('你是运维值班', mem.listGlobal(store), '- 部署在 claude-2');
  assert.ok(sys.startsWith('你是运维值班'));
  assert.ok(sys.includes(`- [${m.id}] 用户叫 Oak`));
  assert.ok(sys.includes('- 部署在 claude-2'));
  assert.ok(mem.systemPrompt('', [], null).includes('（还是空的）'));
  assert.ok(mem.systemPrompt('', [], 'x'.repeat(30_000)).includes('被截断'));
});

test('新会话：旧会话归档，排队的消息挪过去，没回答的选择卡作废', () => {
  const { store, botId, threadId, runId } = fixture();
  const runner = new TestRunner(store);
  store.run("INSERT INTO messages(thread_id, content, status, created_at) VALUES (?, '还没跑', 'queued', ?)", threadId, now());
  store.run("INSERT INTO asks(id, run_id, bot_id, thread_id, question, options, allow_custom, created_at) VALUES ('ask_1', ?, ?, ?, '选哪个', '[\"A\"]', 1, ?)", runId, botId, threadId, now());
  const { threadId: fresh } = runner.newSession(botId, '用户');
  assert.notEqual(fresh, threadId);
  assert.equal(runner.currentThread(botId).id, fresh);
  assert.ok(store.get<{ archived_at: string }>('SELECT archived_at FROM threads WHERE id = ?', threadId)!.archived_at);
  assert.equal(store.get<{ thread_id: string }>("SELECT thread_id FROM messages WHERE content = '还没跑'")!.thread_id, fresh);
  assert.ok(store.get<{ answered_at: string }>("SELECT answered_at FROM asks WHERE id = 'ask_1'")!.answered_at);
});

test('选择卡：发出后 Bot 状态是 asking；用户发任何消息都算回答', () => {
  const { store, botId, threadId, runId } = fixture();
  const runner = new TestRunner(store);
  store.run("UPDATE runs SET status = 'succeeded' WHERE id = ?", runId);
  store.run("INSERT INTO asks(id, run_id, bot_id, thread_id, question, options, allow_custom, created_at) VALUES ('ask_2', ?, ?, ?, '选哪个', '[\"A\",\"B\"]', 1, ?)", runId, botId, threadId, now());
  assert.equal(botStatus(store, botId), 'asking');
  const { seen, stop } = collect();
  sendMessage(store, runner, '小助手', 'B');
  stop();
  assert.equal(store.get<{ answer: string }>("SELECT answer FROM asks WHERE id = 'ask_2'")!.answer, 'B');
  assert.deepEqual(seen.map((e) => e.type), ['ask.answered', 'message.queued']);
  assert.equal(botStatus(store, botId), 'idle');
});

test('pagent MCP：凭据校验、工具列表、remember、ask_user、new_session', async () => {
  const { store, runId } = fixture();
  const requested: string[] = [];
  const server = startMcpServer(store, { requestNewSession: (id) => requested.push(id) }, 0);
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const rpc = (body: unknown, token = 'tok', run = runId) => fetch(url, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-pagent-run': run, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const call = async (name: string, args: unknown) =>
    (await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).json()).result;

  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'wrong')).status, 401);
  const list = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json();
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ['remember', 'ask_user', 'new_session']);
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);

  assert.equal((await call('remember', { text: '用户住在上海' })).isError, false);
  assert.equal(mem.listGlobal(store)[0].text, '用户住在上海');
  assert.equal((await call('remember', { text: '' })).isError, true);

  assert.equal((await call('ask_user', { question: '用哪个方案？', options: ['A', 'B'] })).isError, false);
  const ask = store.get<{ options: string; allow_custom: number }>('SELECT * FROM asks')!;
  assert.deepEqual(JSON.parse(ask.options), ['A', 'B']);
  assert.equal(ask.allow_custom, 1);
  assert.equal((await call('ask_user', { question: 'x', options: [] })).isError, true);

  await call('new_session', { reason: '话题换了' });
  assert.deepEqual(requested, [runId]);

  // 这一轮结束后凭据失效
  store.run("UPDATE runs SET status = 'succeeded' WHERE id = ?", runId);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
  server.close();
});

test('记忆送达：没变化不补发；人设、全局记忆增删改、MEMORY.md 变化都补发；老会话补发全文', () => {
  const base = mem.snap('你是运维', [{ id: 'mem_a', text: '用户叫 Oak' }, { id: 'mem_b', text: '用户住上海' }] as any, '- 职责：值班');
  assert.equal(mem.updateBlock(base, base), '');
  const cur = mem.snap('你是运维，说话简短', [{ id: 'mem_a', text: '用户叫 Oak Shen' }, { id: 'mem_c', text: '用户养猫' }] as any, '- 职责：值班\n- 用 compose 部署');
  const u = mem.updateBlock(base, cur);
  assert.ok(u.startsWith('<pagent-update>'));
  for (const s of ['你是运维，说话简短', '+ [mem_c] 用户养猫', '~ [mem_a] 用户叫 Oak Shen', '- [mem_b] 已删除：用户住上海', '- 用 compose 部署']) assert.ok(u.includes(s), s);
  // 只有全局记忆变了时，不重复发人设和索引
  const onlyG = mem.updateBlock(base, { ...base, globals: { ...base.globals, mem_d: '新的一条' } });
  assert.ok(onlyG.includes('+ [mem_d]') && !onlyG.includes('人设') && !onlyG.includes('MEMORY.md'));
  const full = mem.updateBlock(null, cur);
  assert.ok(full.startsWith('<pagent-context>') && full.includes('你是运维，说话简短') && full.includes('[mem_c] 用户养猫') && full.includes('ask_user'));
});

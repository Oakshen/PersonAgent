// 假的 claude / codex：不调模型，照着消息里以 @@ 开头的行行动，输出和真 CLI 同样格式的事件。
//   @@say 文本            说一段话
//   @@sleep 毫秒          停一会儿（测打断、重启）
//   @@mcp 工具 {参数}      调 pagent 的 MCP 工具（就是这一轮挂上的那个，真的发 HTTP）
//   @@sh 命令             跑一条 shell 命令，结果作为工具结果，再把输出说出来
//   @@fail 原因           这一轮以失败结束
// 没有任何 @@ 行就说"好的"。收到的参数和消息写进 $PAGENT_FAKE_LOG/<runId>.json，测试拿来检查。
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function main(engine) {
  const argv = process.argv.slice(2);
  let prompt = '';
  for await (const c of process.stdin) prompt += c;
  if (process.env.PAGENT_FAKE_LOG) {
    writeFileSync(join(process.env.PAGENT_FAKE_LOG, `${process.env.PAGENT_RUN_ID}.json`), JSON.stringify({ engine, argv, prompt, env: { PATH: process.env.PATH } }));
    appendFileSync(join(process.env.PAGENT_FAKE_LOG, 'order.log'), `${process.env.PAGENT_RUN_ID} ${process.env.PAGENT_AGENT_ID}\n`);
  }
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  const pagent = engine === 'claude' ? claudeMcp(argv) : codexMcp(argv);
  const resumed = engine === 'claude' ? argv[argv.indexOf('--resume') + 1] : (argv.includes('resume') ? argv[argv.indexOf('resume') + 1] : null);
  const session = argv.includes('--resume') || argv.includes('resume') ? resumed : randomUUID();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let n = 0;
  const say = (text) => engine === 'claude'
    ? out({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
    : out({ type: 'item.completed', item: { id: `msg_${n++}`, type: 'agent_message', text } });
  const tool = (name, input, result, isError) => {
    const id = `tool_${n++}`;
    if (engine === 'claude') {
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: name.startsWith('Bash') ? 'Bash' : `mcp__pagent__${name}`, input }] } });
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: result }] } });
    } else if (name === 'Bash') {
      out({ type: 'item.completed', item: { id, type: 'command_execution', command: input.command, aggregated_output: result, exit_code: isError ? 1 : 0, status: isError ? 'failed' : 'completed' } });
    } else {
      out({ type: 'item.completed', item: { id, type: 'mcp_tool_call', server: 'pagent', tool: name, arguments: input, result: { content: [{ type: 'text', text: result }], isError }, status: 'completed' } });
    }
  };

  if (engine === 'claude') out({ type: 'system', subtype: 'init', session_id: session, model: 'fake', permissionMode: 'bypassPermissions', mcp_servers: [] });
  else { out({ type: 'thread.started', thread_id: session }); out({ type: 'turn.started' }); }

  let last = '好的';
  let failed = null;
  const lines = prompt.split('\n').filter((l) => l.startsWith('@@'));
  if (!lines.length) say(last);
  for (const line of lines) {
    const [, cmd, rest = ''] = /^@@(\w+)\s?([\s\S]*)$/.exec(line) ?? [];
    if (cmd === 'say') { last = rest; say(rest); }
    if (cmd === 'sleep') await sleep(Number(rest));
    if (cmd === 'fail') { failed = rest || '假引擎按要求失败'; break; }
    if (cmd === 'sh') {
      let o = '', bad = false;
      try { o = execSync(rest, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { o = `${e.stdout ?? ''}${e.stderr ?? ''}`; bad = true; }
      tool('Bash', { command: rest }, o, bad);
      last = `sh: ${o.trim()}`;
      say(last);
    }
    if (cmd === 'mcp') {
      const sp = rest.indexOf(' ');
      const name = sp < 0 ? rest : rest.slice(0, sp);
      const args = sp < 0 ? {} : JSON.parse(rest.slice(sp + 1));
      const r = await fetch(pagent.url, { method: 'POST', headers: { ...pagent.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name, arguments: args } }) });
      const d = await r.json();
      const text = d.result?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(d.error);
      tool(name, args, text, !!(d.error || d.result?.isError));
    }
  }

  if (engine === 'claude') {
    out(failed
      ? { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, result: failed, session_id: session }
      : { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: last, total_cost_usd: 0, session_id: session });
  } else {
    out(failed ? { type: 'turn.failed', error: { message: failed } } : { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  }
}

function claudeMcp(argv) {
  const i = argv.indexOf('--mcp-config');
  const p = i >= 0 ? JSON.parse(argv[i + 1]).mcpServers?.pagent : null;
  return { url: p?.url, headers: p?.headers ?? {} };
}

function codexMcp(argv) {
  let url, headers = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '-c') continue;
    const v = argv[i + 1];
    if (v.startsWith('mcp_servers.pagent.url=')) url = JSON.parse(v.slice('mcp_servers.pagent.url='.length));
    if (v.startsWith('mcp_servers.pagent.http_headers=')) for (const [, k, val] of v.matchAll(/"([^"]+)"="([^"]*)"/g)) headers[k] = val;
  }
  return { url, headers };
}

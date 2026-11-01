#!/usr/bin/env node
// pagent CLI：通过 unix socket 调 pagentd。
import http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Bot, PagentEvent } from '../../protocol/src/types.ts';

const SOCK = process.env.PAGENT_SOCK ?? join(homedir(), 'pagent/run/api.sock');

function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCK, path, method, headers: { 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        const parsed = data ? JSON.parse(data) : null;
        if ((res.statusCode ?? 500) >= 400) reject(new Error(parsed?.error ?? `HTTP ${res.statusCode}`));
        else resolve(parsed);
      });
    });
    req.on('error', (e) => reject(new Error(`连不上 pagentd（${SOCK}）：${e.message}`)));
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/** 订阅 SSE 事件流；handler 返回 true 时结束。 */
function follow(query: string, handler: (e: PagentEvent) => boolean | void | Promise<boolean | void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCK, path: `/events?follow=1&${query}`, method: 'GET' }, (res) => {
      let buf = '';
      let chain = Promise.resolve();
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').find((l) => l.startsWith('data: '));
          if (!data) continue;
          const e = JSON.parse(data.slice(6)) as PagentEvent;
          chain = chain.then(async () => {
            if (await handler(e)) { req.destroy(); resolve(); }
          });
        }
      });
      res.on('end', resolve);
    });
    req.on('error', (e) => (e.message.includes('socket hang up') ? resolve() : reject(e)));
    req.end();
  });
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

function brief(input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  const s = String(o.command ?? o.file_path ?? o.pattern ?? o.url ?? JSON.stringify(o));
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}

async function chat(botName: string, text: string, opts: { newThread: boolean }) {
  const { threadId, messageId, seq } = await call('POST', `/bots/${botName}/messages`, { text, newThread: opts.newThread });
  const tty = process.stdin.isTTY;
  let myRun: string | null = null;
  await follow(`thread=${threadId}&after=${seq}`, async (e) => {
    if (e.type === 'run.started' && (e.data.messageIds as number[]).includes(messageId)) myRun = e.runId;
    if (!myRun || e.runId !== myRun) return;
    switch (e.type) {
      case 'assistant.text': console.log(e.data.text); break;
      case 'tool.use': console.log(dim(`  ⚙ ${e.data.name} ${brief(e.data.input)}`)); break;
      case 'tool.result': if (e.data.isError) console.log(red(`  ↳ ${String(e.data.preview).slice(0, 200)}`)); break;
      case 'action.decided':
        if (e.data.decision === 'deny') console.log(red(`  ✖ 拒绝：${e.data.reason}`));
        break;
      case 'approval.requested': {
        const id = e.data.approvalId as string;
        console.log(yellow(`  ? 需要审批 ${id}：${e.data.summary}`));
        if (tty) {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const ans = (await rl.question(yellow('    批准？[y/N] '))).trim().toLowerCase();
          rl.close();
          await call('POST', `/approvals/${id}`, { decision: ans === 'y' ? 'approve' : 'deny', by: 'cli' })
            .catch((err) => console.log(red(`    ${err.message}`)));
        } else {
          console.log(dim(`    用 pagent approve ${id} 或 pagent deny ${id} 处理`));
        }
        break;
      }
      case 'run.finished': {
        const d = e.data;
        const tail = [d.status, d.numTurns != null ? `${d.numTurns} 轮` : null, d.unknownActions ? `${d.unknownActions} 个操作状态未知` : null, d.error]
          .filter(Boolean).join('，');
        console.log((d.status === 'succeeded' ? green : red)(`— ${tail}  (${e.runId})`));
        return true;
      }
    }
  });
}

function table(rows: Record<string, unknown>[], cols: string[]) {
  if (!rows.length) return console.log(dim('（空）'));
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  console.log(cols.map((c, i) => c.padEnd(w[i])).join('  '));
  for (const r of rows) console.log(cols.map((c, i) => String(r[c] ?? '').padEnd(w[i])).join('  '));
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

const USAGE = `用法：
  pagent bot create <name> [--persona 文本] [--model 模型] [--max-turns N]
  pagent bot ls | pagent bot show <name>
  pagent bot policy <name> '<规则 JSON 数组>'
  pagent chat <bot> [--new] <消息…>
  pagent approvals | pagent approve <id> | pagent deny <id>
  pagent runs [bot] | pagent run <runId> | pagent interrupt <runId>
  pagent events [--after N] [-f]`;

async function main(argv: string[]) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'bot': {
      const [sub, name, ...rest] = args;
      if (sub === 'create') {
        const persona = flag(rest, '--persona');
        const model = flag(rest, '--model');
        const maxTurns = flag(rest, '--max-turns');
        const b: Bot = await call('POST', '/bots', { name, persona, model, maxTurns: maxTurns ? Number(maxTurns) : undefined });
        return console.log(`已创建 ${b.name}（${b.id}）`);
      }
      if (sub === 'ls') return table(await call('GET', '/bots'), ['name', 'id', 'model', 'maxTurns', 'createdAt']);
      if (sub === 'show') return console.log(JSON.stringify(await call('GET', `/bots/${name}`), null, 2));
      if (sub === 'policy') return console.log(JSON.stringify((await call('PATCH', `/bots/${name}`, { policy: JSON.parse(rest[0]) })).policy, null, 2));
      break;
    }
    case 'chat': {
      const newThread = args.includes('--new');
      const [bot, ...words] = args.filter((a) => a !== '--new');
      if (!bot || !words.length) break;
      return chat(bot, words.join(' '), { newThread });
    }
    case 'approvals':
      return table(await call('GET', '/approvals'), ['id', 'run_id', 'summary', 'expires_at']);
    case 'approve':
    case 'deny':
      await call('POST', `/approvals/${args[0]}`, { decision: cmd, by: 'cli' });
      return console.log(cmd === 'approve' ? '已批准' : '已拒绝');
    case 'runs':
      return table(await call('GET', `/runs${args[0] ? `?bot=${args[0]}` : ''}`), ['id', 'status', 'num_turns', 'cost_usd', 'started_at', 'error']);
    case 'run': {
      const r = await call('GET', `/runs/${args[0]}`);
      console.log(`${r.id}  ${r.status}  turns=${r.num_turns}  ${r.error ?? ''}`);
      table(r.actions, ['id', 'tool', 'status', 'reason']);
      return;
    }
    case 'interrupt':
      return console.log((await call('POST', `/runs/${args[0]}/interrupt`)).ok ? '已发出中断' : '该 run 不在运行中');
    case 'events': {
      const after = flag(args, '--after') ?? '0';
      if (!args.includes('-f')) {
        for (const e of await call<PagentEvent[]>('GET', `/events?after=${after}`)) console.log(JSON.stringify(e));
        return;
      }
      return follow(`after=${after}`, (e) => void console.log(JSON.stringify(e)));
    }
  }
  console.log(USAGE);
  process.exitCode = 1;
}

main(process.argv.slice(2)).catch((e) => {
  console.error(red(e.message));
  process.exitCode = 1;
});

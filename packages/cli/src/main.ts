#!/usr/bin/env node
// pagent CLI：通过 unix socket 调 pagentd。
import http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
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

async function chat(botName: string, text: string, opts: { newSession: boolean; interrupt: boolean }): Promise<void> {
  const { threadId, messageId, seq, interrupted } = await call('POST', `/bots/${encodeURIComponent(botName)}/messages`, { text, newSession: opts.newSession, interrupt: opts.interrupt });
  if (interrupted) console.log(dim(`  已打断 ${interrupted}，新消息排在它后面`));
  let myRun: string | null = null;
  let ask = null as { question: string; options: string[] } | null;  // 在回调里赋值，TS 推不出来
  await follow(`thread=${threadId}&after=${seq}`, async (e) => {
    if (e.type === 'run.started' && (e.data.messageIds as number[]).includes(messageId)) myRun = e.runId;
    if (!myRun || e.runId !== myRun) return;
    switch (e.type) {
      case 'assistant.text': console.log(e.data.text); break;
      case 'tool.use': console.log(dim(`  ⚙ ${e.data.name} ${brief(e.data.input)}`)); break;
      case 'tool.result': if (e.data.isError) console.log(red(`  ↳ ${String(e.data.preview).slice(0, 200)}`)); break;
      case 'memory.updated': console.log(dim(`  ✎ ${describeMemory(e.data)}`)); break;
      case 'ask.created': {
        ask = { question: e.data.question as string, options: e.data.options as string[] };
        console.log(yellow(`  ? ${ask.question}`));
        ask.options.forEach((o, i) => console.log(yellow(`    ${i + 1}. ${o}`)));
        break;
      }
      case 'run.finished': {
        const d = e.data;
        const unconfirmed = (d.unconfirmed as unknown[] | undefined)?.length;
        const tail = [d.status, d.numTurns != null ? `${d.numTurns} 轮` : null, unconfirmed ? `${unconfirmed} 个操作没等到结果` : null, d.error]
          .filter(Boolean).join('，');
        console.log((d.status === 'succeeded' ? green : red)(`— ${tail}  (${e.runId})`));
        return true;
      }
    }
  });
  // 它问了问题：终端里直接选，选完接着聊
  if (ask && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question(yellow('  选一个编号，或直接输入回答（回车跳过）：'))).trim();
    rl.close();
    const pick = /^\d+$/.test(a) ? ask.options[Number(a) - 1] : a;
    if (pick) return chat(botName, pick, { newSession: false, interrupt: false });
  }
}

function describeMemory(d: Record<string, unknown>): string {
  if (d.scope === 'global') {
    const op = { add: '记住了', update: '改写了', delete: '删掉了' }[d.op as string] ?? d.op;
    return `${d.by} ${op}关于你的一条：${d.text ?? d.before}`;
  }
  const added = (d.added as string[]) ?? [];
  return `${d.by} ${d.op === 'delete' ? '删掉了' : '更新了'}自己的记忆 ${d.file}${added.length ? `：${added[0]}` : ''}`;
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

/** 把插件目录打包成 {相对路径: base64}；不跟随符号链接 */
function packDir(dir: string): Record<string, string> {
  const root = resolve(dir);
  const files: Record<string, string> = {};
  let total = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === '.git') continue;
      const p = `${d}/${name}`;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`插件里不能有符号链接：${relative(root, p)}`);
      if (st.isDirectory()) walk(p);
      else {
        total += st.size;
        if (total > 15 * 1024 * 1024) throw new Error('插件超过 15MB');
        files[relative(root, p)] = readFileSync(p).toString('base64');
      }
    }
  };
  walk(root);
  return files;
}

async function confirm(q: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(q)).trim().toLowerCase();
  rl.close();
  return a === 'y';
}

function describePermissions(m: any): string {
  const p = m.permissions ?? {};
  const lines = [];
  if (m.contributes?.skills?.length) lines.push(`  提供 Skill：${m.contributes.skills.join(', ')}`);
  if (m.contributes?.mcp) lines.push(`  提供工具（MCP，运行在独立沙箱）`);
  lines.push(`  出网：${p.network?.length ? p.network.join(', ') : '无'}`);
  return lines.join('\n');
}

const USAGE = `用法：
  pagent bot create <name> [--persona 文本] [--model 模型] [--max-turns N]
  pagent bot ls | pagent bot show <name>
  pagent bot set <name> [--max-turns N] [--daily-turns N] [--max-seconds N] [--max-actions N]
  pagent backup
  pagent chat <bot> [--new] [--interrupt] <消息…>      --new：先开一条新会话（记忆保留）
  pagent session new <bot>
  pagent memory [bot]                                  不带 bot：关于你的全局记忆；带 bot：它自己的记忆文件
  pagent remember <文本…> | pagent forget <记忆编号>
  pagent runs [bot] | pagent run <runId> | pagent interrupt <runId>
  pagent device pair <设备名> [--scopes chat,admin] | pagent device ls | pagent device revoke <id>
  pagent events [--after N] [-f]
  pagent plugin install <目录> | pagent plugin ls | pagent plugin show <id>
  pagent plugin enable <bot> <id> [--yes] | pagent plugin disable <bot> <id> | pagent plugin bot <bot>`;

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
      if (sub === 'show') return console.log(JSON.stringify(await call('GET', `/bots/${encodeURIComponent(name)}`), null, 2));
      if (sub === 'set') {
        const num = (f: string) => { const v = flag(rest, f); return v === undefined ? undefined : Number(v); };
        const b = await call('PATCH', `/bots/${encodeURIComponent(name)}`, {
          maxTurns: num('--max-turns'), dailyTurnBudget: num('--daily-turns'),
          maxRunSeconds: num('--max-seconds'), maxActions: num('--max-actions'),
        });
        return console.log(`${b.name}：maxTurns=${b.maxTurns} dailyTurnBudget=${b.dailyTurnBudget} maxRunSeconds=${b.maxRunSeconds} maxActions=${b.maxActions}`);
      }
      break;
    }
    case 'chat': {
      const newSession = args.includes('--new');
      const interrupt = args.includes('--interrupt');
      const [bot, ...words] = args.filter((a) => a !== '--new' && a !== '--interrupt');
      if (!bot || !words.length) break;
      return chat(bot, words.join(' '), { newSession, interrupt });
    }
    case 'session': {
      if (args[0] !== 'new' || !args[1]) break;
      await call('POST', `/bots/${encodeURIComponent(args[1])}/session`);
      return console.log(`${args[1]} 已换新会话，记忆都还在`);
    }
    case 'memory': {
      if (!args[0]) {
        const list = await call<any[]>('GET', '/memory');
        if (!list.length) return console.log(dim('（还没有关于你的记忆）'));
        for (const m of list) console.log(`${dim(m.id)}  ${m.text}  ${dim(`— ${m.sourceBot ?? '你自己'}，${m.updatedAt.slice(0, 16)}`)}`);
        return;
      }
      const files = await call<{ file: string; content: string }[]>('GET', `/bots/${encodeURIComponent(args[0])}/memory`);
      if (!files.length) return console.log(dim('（它还没有写过记忆）'));
      for (const f of files) console.log(`${green(`== ${f.file}`)}\n${f.content.trimEnd()}\n`);
      return;
    }
    case 'remember': {
      if (!args.length) break;
      const m = await call('POST', '/memory', { text: args.join(' ') });
      return console.log(`已记住（${m.id}），所有 Agent 下一轮起都能看到`);
    }
    case 'forget': {
      if (!args[0]) break;
      await call('DELETE', `/memory/${args[0]}`);
      return console.log('已删除');
    }
    case 'device': {
      const [sub, a1, ...rest] = args;
      if (sub === 'pair' && a1) {
        const scopes = (flag(rest, '--scopes') ?? 'chat,admin').split(',');
        const p = await call('POST', '/devices/pair', { name: a1, scopes });
        const base = process.env.PAGENT_REMOTE_URL ?? 'http://localhost:7780';
        console.log(`配对码：${p.code.replace(/(.{5})/, '$1-')}（${scopes.join(', ')}，${p.expiresAt} 前有效，只能用一次）`);
        console.log(`在设备上打开 ${base}/#pair=${p.code} ，或打开 ${base} 后手动输入配对码`);
        return;
      }
      if (sub === 'ls') return table(await call('GET', '/devices'), ['id', 'name', 'scopes', 'created_at', 'last_seen_at', 'revoked_at']);
      if (sub === 'revoke' && a1) return console.log((await call('POST', `/devices/${a1}/revoke`)).ok ? '已撤销，该设备的会话和事件流已断开' : '设备不存在或已撤销');
      break;
    }
    case 'backup':
      return console.log(`已备份到 ${(await call('POST', '/backup')).file}`);
    case 'runs':
      return table(await call('GET', `/runs${args[0] ? `?bot=${encodeURIComponent(args[0])}` : ''}`), ['id', 'status', 'num_turns', 'cost_usd', 'started_at', 'error']);
    case 'run': {
      const r = await call('GET', `/runs/${args[0]}`);
      console.log(`${r.id}  ${r.status}  turns=${r.num_turns}  ${r.error ?? ''}`);
      table(r.actions, ['id', 'tool', 'status', 'reason']);
      return;
    }
    case 'interrupt':
      return console.log((await call('POST', `/runs/${args[0]}/interrupt`)).ok ? '已发出中断' : '该 run 不在运行中');
    case 'plugin': {
      const [sub, a1, a2] = args;
      if (sub === 'install') {
        const p = await call('POST', '/plugins', { files: packDir(a1) });
        console.log(`已安装 ${p.id}@${p.version}（sha256 ${p.hash.slice(0, 12)}…）\n${describePermissions(p.manifest)}`);
        return;
      }
      if (sub === 'ls') return table((await call('GET', '/plugins')).map((p: any) => ({ ...p, hash: p.hash.slice(0, 12) })), ['id', 'version', 'hash', 'installedAt']);
      if (sub === 'show') return console.log(JSON.stringify(await call('GET', `/plugins/${a1}`), null, 2));
      if (sub === 'bot') return table(await call('GET', `/bots/${encodeURIComponent(a1)}/plugins`), ['id', 'version', 'status', 'enabledAt']);
      if (sub === 'disable') return console.log((await call('DELETE', `/bots/${encodeURIComponent(a1)}/plugins/${a2}`)).ok ? '已停用' : '本来就没启用');
      if (sub === 'enable') {
        const p = await call('GET', `/plugins/${a2}`);
        console.log(`给 ${a1} 启用 ${p.id}@${p.version}，它会获得以下权限：\n${describePermissions(p.manifest)}`);
        if (!args.includes('--yes') && !(await confirm('同意并启用？[y/N] '))) return console.log('已取消');
        await call('POST', `/bots/${encodeURIComponent(a1)}/plugins`, { id: a2 });
        return console.log('已启用');
      }
      break;
    }
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

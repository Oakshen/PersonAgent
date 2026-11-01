#!/usr/bin/env node
// pagent-local：在你自己的电脑上运行的本机执行守护进程（照 Grok 的 local-exec-daemon）。
//   pagent-local pair <服务器地址> <配对码>      在服务器上先运行 pagent device pair <名字> --scopes local
//   pagent-local run --root <目录>               只开放这个目录：读文件、命令的工作目录都不能跳出去
// 用 SSE 从 pagentd 领任务，执行完把结果 POST 回去。是否允许执行由你在网页 设置 → 本机执行 里开关，默认关闭。
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, createPrivateKey, sign } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const CONF_DIR = process.env.PAGENT_LOCAL_HOME ?? join(homedir(), '.config', 'pagent-local');
const CONF = join(CONF_DIR, 'device.json');
const MAX_OUT = 200_000;

interface Conf { base: string; deviceId: string; name: string; privateKey: string }

const die = (msg: string): never => { console.error(msg); process.exit(1); };

async function post(base: string, path: string, body: unknown, token?: string): Promise<any> {
  const r = await fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

async function pair(base: string, code: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const r = await post(base, '/api/pair', { code, publicKey: publicKey.export({ format: 'jwk' }) });
  if (!r.scopes.includes('local')) die('这个配对码不是本机执行用的（服务器上要用 --scopes local 生成）');
  mkdirSync(CONF_DIR, { recursive: true, mode: 0o700 });
  const conf: Conf = { base, deviceId: r.deviceId, name: r.name, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string };
  writeFileSync(CONF, JSON.stringify(conf, null, 2), { mode: 0o600 });
  console.log(`已配对：${r.name}（${r.deviceId}）。下一步：pagent-local run --root <要开放的目录>，然后在网页 设置 → 本机执行 里打开。`);
}

async function login(conf: Conf): Promise<string> {
  const { nonce } = await post(conf.base, '/api/auth/challenge', { deviceId: conf.deviceId });
  const sig = sign('sha256', Buffer.from(`pagent-login:${nonce}`), { key: createPrivateKey(conf.privateKey), dsaEncoding: 'ieee-p1363' });
  return (await post(conf.base, '/api/auth/login', { deviceId: conf.deviceId, nonce, signature: sig.toString('base64') })).token;
}

/** 路径必须在开放目录里（解析符号链接之后也是） */
function inside(root: string, p: string): string {
  const full = resolve(root, p || '.');
  let real: string;
  try { real = realpathSync(full); } catch { throw new Error(`不存在：${p}`); }
  const rel = relative(root, real);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${p} 不在开放目录里`);
  return real;
}

const running = new Map<string, ChildProcess>();

async function handle(conf: Conf, token: string, root: string, job: any) {
  const reply = (r: Record<string, unknown>) => post(conf.base, '/api/local-exec/responses', { id: job.id, ...r }, token).catch((e) => console.error('回传失败', e.message));
  try {
    if (job.op === 'read') {
      const f = inside(root, String(job.path ?? ''));
      if (!statSync(f).isFile()) throw new Error('不是文件');
      const buf = readFileSync(f);
      console.log(`[read] ${f}`);
      return reply({ ok: true, content: buf.subarray(0, MAX_OUT).toString('utf8') + (buf.length > MAX_OUT ? '\n…（截断）' : '') });
    }
    if (job.op === 'shell') {
      const cwd = inside(root, String(job.cwd ?? '.'));
      console.log(`[shell] (${cwd}) ${job.command}`);
      const child = spawn('/bin/sh', ['-c', String(job.command ?? '')], { cwd, detached: true });
      running.set(job.id, child);
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout = (stdout + d).slice(-MAX_OUT); });
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-MAX_OUT); });
      const t = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, Math.min(1800, Number(job.timeoutSec ?? 120)) * 1000);
      child.on('close', (code, signal) => {
        clearTimeout(t);
        running.delete(job.id);
        reply({ ok: code === 0, exitCode: code, stdout, stderr: signal ? `${stderr}\n（被 ${signal} 结束）` : stderr });
      });
      return;
    }
    throw new Error(`未知操作 ${job.op}`);
  } catch (e) {
    return reply({ ok: false, error: (e as Error).message });
  }
}

async function run(rootArg: string) {
  let conf: Conf;
  try { conf = JSON.parse(readFileSync(CONF, 'utf8')); } catch { return die('还没配对：先运行 pagent-local pair <服务器地址> <配对码>'); }
  let root: string;
  try { root = realpathSync(rootArg); } catch { return die(`目录不存在：${rootArg}`); }
  console.log(`pagent-local：${conf.name} → ${conf.base}，开放目录 ${root}`);
  for (let backoff = 1000; ; backoff = Math.min(backoff * 2, 30_000)) {
    try {
      const token = await login(conf);
      const res = await fetch(`${conf.base}/api/local-exec/requests?root=${encodeURIComponent(root)}&host=${encodeURIComponent(hostname())}`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      console.log('已连上，等任务…');
      backoff = 1000;
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
          buf = buf.slice(i + 2);
          if (!line) continue;
          const msg = JSON.parse(line.slice(6));
          if (msg.type === 'cancel') {
            const c = running.get(msg.id);
            if (c?.pid) { try { process.kill(-c.pid, 'SIGKILL'); } catch {} console.log(`[cancel] ${msg.id}`); }
          } else if (msg.type === 'job') handle(conf, token, root, msg);
        }
      }
    } catch (e) {
      console.error('连接断开：', (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, backoff));
  }
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'pair' && args.length >= 2) await pair(args[0].replace(/\/$/, ''), args[1]);
else if (cmd === 'run') {
  const i = args.indexOf('--root');
  await run(i >= 0 ? args[i + 1] : process.cwd());
} else {
  console.log('用法：\n  pagent-local pair <服务器地址> <配对码>\n  pagent-local run --root <开放的目录>');
}

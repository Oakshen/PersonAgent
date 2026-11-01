// 盒子：所有 Agent 共用的一台常驻容器（对应 Grok 0.18 的 ensureSandBox）。
// pagentd 只经盒子里的网关（pagent-host）让 Agent 跑一轮，再订阅网关的事件流落库；
// 一轮在盒子里跑到底，pagentd 重启后按游标续传，不重不漏。
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { allowEgress, docker } from './docker.ts';
import type { Store } from './store.ts';

export const BOX_NAME = 'pagent-box';
// 盒子的规格版本：挂载、环境变量等变了就加一；镜像变了也会重建（都要等盒子里没有进行中的轮次）
const BOX_SPEC = '1';
const GATEWAY_PORT = 7700;

export const boxDir = () => join(config.dataDir, 'box');
/** Agent 的配置目录（CLAUDE_CONFIG_DIR）：盒子里看到的路径 / pagentd 在宿主上看到的路径 */
export const agentDirInBox = (botId: string) => `/home/box/.pagent/agents/${botId}/claude`;
export const agentDirOnHost = (botId: string) => join(boxDir(), 'home', '.pagent', 'agents', botId, 'claude');

export interface Box { gatewayUrl: string; gatewayToken: string }

const tokenFile = () => join(boxDir(), 'gateway.token');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 调网关；出错时抛出带网关错误信息的异常 */
export async function gw<T = any>(box: Box, method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
  const res = await fetch(box.gatewayUrl + path, {
    method,
    headers: { authorization: `Bearer ${box.gatewayToken}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => null) as any;
  if (!res.ok) throw new Error(`盒子网关 ${path}：${data?.error ?? res.status}`);
  return data as T;
}

async function waitHealthy(box: Box, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    try { await gw(box, 'GET', '/health', undefined, 2000); return; } catch (e) {
      if (Date.now() > until) throw new Error(`盒子网关没有就绪：${(e as Error).message}`);
    }
    await sleep(500);
  }
}

async function busy(box: Box): Promise<boolean> {
  try {
    return (await gw<{ runs: { status: string }[] }>(box, 'GET', '/api/runs', undefined, 3000)).runs.some((r) => r.status === 'running');
  } catch { return false; }
}

let inflight: Promise<Box> | null = null;

/** 确保盒子在跑、网关可用。并发调用合并成一次。 */
export function ensureBox(): Promise<Box> {
  inflight ??= doEnsure().finally(() => { inflight = null; });
  return inflight;
}

async function doEnsure(): Promise<Box> {
  const gatewayUrl = `http://${BOX_NAME}:${GATEWAY_PORT}`;
  let token: string | null = null;
  try { token = readFileSync(tokenFile(), 'utf8').trim() || null; } catch {}
  const [info, image] = await Promise.all([
    docker(['inspect', '-f', '{{.State.Running}} {{index .Config.Labels "pagent.spec"}} {{.Image}}', BOX_NAME]).catch(() => null),
    docker(['image', 'inspect', '-f', '{{.Id}}', config.boxImage]),
  ]);
  allowEgress(BOX_NAME, config.boxAllow);

  if (info && token) {
    const [running, spec, img] = info.split(' ');
    const box = { gatewayUrl, gatewayToken: token };
    const current = spec === BOX_SPEC && img === image;
    if (running === 'true' && (current || await busy(box))) {
      if (!current) console.log('盒子镜像 / 规格有更新，等没有进行中的轮次时再重建');
      await waitHealthy(box);
      return box;
    }
    if (running !== 'true' && current) {
      await docker(['start', BOX_NAME]);
      await waitHealthy(box);
      return box;
    }
  }

  // （重新）创建：持久卷原样挂回，网关令牌每次新生成
  if (info) await docker(['rm', '-f', BOX_NAME]);
  const gatewayToken = randomBytes(24).toString('hex');
  const plugins = join(config.dataDir, 'plugins');
  for (const d of [join(boxDir(), 'home'), join(boxDir(), 'workspace'), plugins]) mkdirSync(d, { recursive: true });
  writeFileSync(tokenFile(), gatewayToken, { mode: 0o600 });
  await docker([
    'run', '-d', '--name', BOX_NAME, '--hostname', BOX_NAME, '--network', config.sandboxNet, '--network-alias', BOX_NAME,
    '--init', '--restart', 'unless-stopped', '--memory', config.boxMemory, '--cpus', config.boxCpus,
    '--pids-limit', '4096', '--shm-size', '1g',
    '-v', `${join(boxDir(), 'home')}:/home/box`,
    '-v', `${join(boxDir(), 'workspace')}:/workspace`,
    '-v', `${config.hostSrc}:/opt/pagent-host:ro`,
    '-v', `${plugins}:/opt/pagent-plugins:ro`,
    ...(config.hostCred ? ['-v', `${config.hostCred}:/opt/pagent-cred/.credentials.json`] : []),
    '-e', `PAGENT_GATEWAY_TOKEN=${gatewayToken}`,
    '-e', 'HOME=/home/box',
    // 大小写都设：curl 等工具只认小写的 http_proxy
    ...['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'].flatMap((k) => ['-e', `${k}=http://egress:3128`]),
    // pagent MCP、插件和盒子内部服务直连，不经出口代理
    ...['NO_PROXY', 'no_proxy'].flatMap((k) => ['-e', `${k}=${config.mcpHost},.plugin,localhost,127.0.0.1`]),
    '-e', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    // 记忆由 pagent 管（两层记忆），关掉 Claude Code 自带的 auto-memory，免得两套并存
    '-e', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY=1',
    '--label', 'pagent.role=box',
    '--label', `pagent.spec=${BOX_SPEC}`,
    config.boxImage, 'node', '/opt/pagent-host/src/main.ts',
  ]);
  const box = { gatewayUrl, gatewayToken };
  await waitHealthy(box);
  console.log('盒子已创建');
  return box;
}

// ---- 事件流 ----

export interface BoxEvent { seq: number; type: string; data: any }

/** 订阅网关的事件流。游标和 boot 存在库里，和事件的处理在同一个事务里提交，所以重启后不重不漏。 */
export class BoxLink {
  private store: Store;
  private onEvent: (ev: BoxEvent) => void;
  private onBoot: (boot: string) => void;
  private stopped = false;
  private ac: AbortController | null = null;

  constructor(store: Store, onEvent: (ev: BoxEvent) => void, onBoot: (boot: string) => void) {
    this.store = store;
    this.onEvent = onEvent;
    this.onBoot = onBoot;
  }

  start(): void {
    (async () => {
      while (!this.stopped) {
        try { await this.once(); } catch (e) {
          if (!this.stopped) console.error('盒子事件流断开：', (e as Error).message);
        }
        if (!this.stopped) await sleep(1000);
      }
    })();
  }

  stop(): void {
    this.stopped = true;
    this.ac?.abort();
  }

  private async once(): Promise<void> {
    const box = await ensureBox();
    const boot = this.store.getKv('box.boot') ?? '';
    const cursor = Number(this.store.getKv('box.cursor') ?? 0);
    this.ac = new AbortController();
    const res = await fetch(`${box.gatewayUrl}/events?after=${cursor}&boot=${encodeURIComponent(boot)}`, {
      headers: { authorization: `Bearer ${box.gatewayToken}` }, signal: this.ac.signal,
    });
    if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
    const newBoot = res.headers.get('x-pagent-boot') ?? '';
    if (newBoot !== boot) {
      // 盒子重启过：游标从头算，进行中的轮次由 Runner 收尾
      this.store.tx(() => {
        this.store.setKv('box.boot', newBoot);
        this.store.setKv('box.cursor', '0');
      });
      this.onBoot(newBoot);
    }
    let acked = Number(this.store.getKv('box.cursor') ?? 0);
    const ackTimer = setInterval(() => {
      const c = Number(this.store.getKv('box.cursor') ?? 0);
      if (c > acked) gw(box, 'POST', '/api/ack', { seq: c }).then(() => { acked = c; }).catch(() => {});
    }, 2000);
    try {
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (data) this.handle(JSON.parse(data));
        }
      }
    } finally {
      clearInterval(ackTimer);
    }
  }

  private handle(ev: BoxEvent): void {
    this.store.tx(() => {
      if (ev.seq <= Number(this.store.getKv('box.cursor') ?? 0)) return;
      try { this.onEvent(ev); } catch (e) { console.error('处理盒子事件出错', ev.type, e); }
      this.store.setKv('box.cursor', String(ev.seq));
    });
  }
}

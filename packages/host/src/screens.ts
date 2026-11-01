// 每个 Agent 一块屏幕（对应 Grok 0.18 的 box-chrome + 每屏 X11/noVNC）。都是按需拉起：
// - 显示器 :n（Xvfb + fluxbox + x11vnc + websockify），n 按 Agent 分配并持久记住；
// - Chrome 在 :n 上，CDP 实际端口 19222+n；盒子里 127.0.0.1:9222+n 是一个懒启动代理，
//   Agent（或浏览器 MCP）第一次连上来时才启动 Chrome，空闲久了回收（显示器保留）。
// - 浏览器登录共享：各 Chrome 用自己的用户目录，cookie 经 CDP 实时同步到共享 cookie 罐（见 cookies.ts）。
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CookieJar } from './cookies.ts';

const pexec = promisify(execFile);
const WIDTH = 1280;
const HEIGHT = 800;
const CHROME_IDLE_MS = 20 * 60_000;

export interface Screen {
  agentId: string; n: number;
  procs: Partial<Record<'xvfb' | 'wm' | 'vnc' | 'ws' | 'chrome', ChildProcess>>;
  cdpProxy?: net.Server;
  chromeStarting?: Promise<void>;
  lastUse: number;
  takenOver: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (p?: ChildProcess) => !!p && p.exitCode === null && p.signalCode === null;

export class Screens {
  private root: string;
  private map: Record<string, number> = {};
  private screens = new Map<string, Screen>();
  readonly jar: CookieJar;
  private onChange: (s: Screen, what: string) => void;

  constructor(root: string, onChange: (s: Screen, what: string) => void) {
    this.root = root;
    this.onChange = onChange;
    mkdirSync(root, { recursive: true });
    try { this.map = JSON.parse(readFileSync(join(root, 'screens.json'), 'utf8')); } catch {}
    this.jar = new CookieJar(join(root, 'browser'));
    setInterval(() => this.reap(), 60_000).unref();
  }

  /** Agent 的显示器编号：第一次用时分配，之后一直不变 */
  number(agentId: string): number {
    if (!this.map[agentId]) {
      this.map[agentId] = Math.max(0, ...Object.values(this.map)) + 1;
      writeFileSync(join(this.root, 'screens.json'), JSON.stringify(this.map, null, 2));
    }
    return this.map[agentId];
  }

  get(agentId: string): Screen {
    let s = this.screens.get(agentId);
    if (!s) {
      s = { agentId, n: this.number(agentId), procs: {}, lastUse: Date.now(), takenOver: false };
      this.screens.set(agentId, s);
    }
    return s;
  }

  list(): Screen[] { return [...this.screens.values()]; }

  status(s: Screen) {
    return {
      agentId: s.agentId, n: s.n, display: `:${s.n}`, cdpPort: 9222 + s.n,
      display_up: alive(s.procs.xvfb), chrome: alive(s.procs.chrome), takenOver: s.takenOver,
    };
  }

  private run(s: Screen, key: keyof Screen['procs'], cmd: string, args: string[], extraEnv: Record<string, string> = {}): ChildProcess {
    const p = spawn(cmd, args, { stdio: 'ignore', env: { ...process.env, DISPLAY: `:${s.n}`, ...extraEnv } });
    p.on('error', (e) => console.error(`screen ${s.n} ${cmd}:`, e.message));
    p.on('exit', () => { if (s.procs[key] === p) delete s.procs[key]; if (key === 'chrome') this.onChange(s, 'chrome.exit'); });
    s.procs[key] = p;
    return p;
  }

  /** 显示器 + 窗口管理器 + VNC（给 noVNC 看和接管用） */
  async ensureDisplay(agentId: string): Promise<Screen> {
    const s = this.get(agentId);
    s.lastUse = Date.now();
    if (!alive(s.procs.xvfb)) {
      rmSync(`/tmp/.X${s.n}-lock`, { force: true });
      this.run(s, 'xvfb', 'Xvfb', [`:${s.n}`, '-screen', '0', `${WIDTH}x${HEIGHT}x24`, '-nolisten', 'tcp', '-ac']);
      for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${s.n}`); i++) await sleep(100);
    }
    if (!alive(s.procs.wm)) this.run(s, 'wm', 'fluxbox', []);
    if (!alive(s.procs.vnc)) {
      this.run(s, 'vnc', 'x11vnc', ['-display', `:${s.n}`, '-rfbport', String(5900 + s.n), '-localhost', '-shared', '-forever', '-nopw', '-quiet', '-noxdamage']);
    }
    if (!alive(s.procs.ws)) this.run(s, 'ws', 'websockify', [`127.0.0.1:${6080 + s.n}`, `127.0.0.1:${5900 + s.n}`]);
    await this.waitPort(6080 + s.n, 5000);
    this.ensureCdpProxy(s);
    return s;
  }

  /** 每轮开始前：分配显示器编号、挂好 CDP 懒启动代理（不启动任何东西），返回 n */
  prepare(agentId: string): number {
    const s = this.get(agentId);
    this.ensureCdpProxy(s);
    return s.n;
  }

  /** 这块屏幕上的 Chrome */
  async ensureChrome(agentId: string): Promise<Screen> {
    const s = await this.ensureDisplay(agentId);
    if (alive(s.procs.chrome)) return s;
    s.chromeStarting ??= (async () => {
      const profile = join(this.root, 'agents', agentId, 'chrome');
      mkdirSync(profile, { recursive: true });
      // 上次 Chrome 没正常退出时留下的锁
      for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) rmSync(join(profile, f), { force: true });
      const port = 19222 + s.n;
      this.run(s, 'chrome', 'chromium', [
        '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--password-store=basic',
        '--disable-features=Translate,MediaRouter', '--lang=zh-CN', '--test-type',
        `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
        `--proxy-server=${process.env.HTTPS_PROXY ?? 'http://egress:3128'}`, '--proxy-bypass-list=<-loopback>',
        '--window-position=0,0', `--window-size=${WIDTH},${HEIGHT}`, '--start-maximized', 'about:blank',
      ]);
      await this.waitPort(port, 20_000);
      await this.jar.attach(agentId, port);
      this.onChange(s, 'chrome.start');
    })().finally(() => { s.chromeStarting = undefined; });
    await s.chromeStarting;
    return s;
  }

  /** 盒子里 127.0.0.1:9222+n：有人连上来才启动 Chrome，然后原样转发到真正的 CDP 端口 */
  private ensureCdpProxy(s: Screen): void {
    if (s.cdpProxy) return;
    s.cdpProxy = net.createServer((sock) => {
      sock.pause();
      this.ensureChrome(s.agentId).then(() => {
        const up = net.connect(19222 + s.n, '127.0.0.1');
        s.lastUse = Date.now();
        sock.on('data', () => { s.lastUse = Date.now(); });
        sock.pipe(up).pipe(sock);
        sock.resume();
        const end = () => { sock.destroy(); up.destroy(); };
        sock.on('error', end); up.on('error', end); sock.on('close', end); up.on('close', end);
      }).catch(() => sock.destroy());
    });
    s.cdpProxy.on('error', (e) => console.error(`cdp proxy :${9222 + s.n}`, e.message));
    s.cdpProxy.listen(9222 + s.n, '127.0.0.1');
  }

  private async waitPort(port: number, ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const ok = await new Promise<boolean>((r) => {
        const c = net.connect(port, '127.0.0.1', () => { c.destroy(); r(true); });
        c.on('error', () => r(false));
      });
      if (ok) return;
      await sleep(150);
    }
    throw new Error(`端口 ${port} 没有起来`);
  }

  /** 空闲久了回收 Chrome（显示器保留，下次连上来再起） */
  private reap(): void {
    for (const s of this.screens.values()) {
      if (alive(s.procs.chrome) && !s.takenOver && Date.now() - s.lastUse > CHROME_IDLE_MS) {
        this.jar.detach(s.agentId);
        s.procs.chrome!.kill('SIGTERM');
      }
    }
  }

  touch(agentId: string): void {
    const s = this.screens.get(agentId);
    if (s) s.lastUse = Date.now();
  }

  // ---- 电脑操作（computer 工具用） ----

  async screenshot(agentId: string): Promise<Buffer> {
    const s = await this.ensureDisplay(agentId);
    const { stdout } = await pexec('import', ['-display', `:${s.n}`, '-window', 'root', 'png:-'], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
    return stdout as unknown as Buffer;
  }

  async xdotool(agentId: string, args: string[]): Promise<void> {
    const s = await this.ensureDisplay(agentId);
    await pexec('xdotool', args, { env: { ...process.env, DISPLAY: `:${s.n}` } });
  }

  stopAll(): void {
    for (const s of this.screens.values()) for (const p of Object.values(s.procs)) p?.kill('SIGTERM');
  }
}

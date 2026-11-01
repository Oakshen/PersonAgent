// 本机执行（照 Grok 的 local-exec-daemon）：你的电脑上跑一个小守护进程（packages/localexec），
// 以 local 权限的设备身份连进来，用 SSE 拉任务、执行完把结果 POST 回来。
// Agent 多出 ExternalShell / ExternalRead / AwaitExternalShell 三个工具。
// 权限只有"关闭 / 允许"两档，按设备设置，默认关闭；关掉的那一刻起新任务被拒、在途任务被取消。
import type http from 'node:http';
import { randomBytes } from 'node:crypto';
import { type Store, now } from './store.ts';
import { ServiceError } from './service.ts';

interface Conn { res: http.ServerResponse; root: string; host: string; since: string }

interface Job {
  id: string; deviceId: string; op: 'shell' | 'read'; summary: string; status: 'running' | 'done' | 'cancelled';
  result?: { ok: boolean; exitCode?: number | null; stdout?: string; stderr?: string; content?: string; error?: string };
  waiters: Set<() => void>; createdAt: number;
}

export interface Machine { id: string; name: string; online: boolean; allowed: boolean; root: string | null; host: string | null; lastSeenAt: string | null }

export class LocalExec {
  private store: Store;
  private conns = new Map<string, Conn>();
  private jobs = new Map<string, Job>();

  constructor(store: Store) {
    this.store = store;
    setInterval(() => {
      for (const [id, j] of this.jobs) if (j.status !== 'running' && Date.now() - j.createdAt > 3600_000) this.jobs.delete(id);
    }, 600_000).unref();
  }

  machines(): Machine[] {
    return this.store.all<{ id: string; name: string; scopes: string; local_exec: string; local_root: string | null; last_seen_at: string | null }>(
      'SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY created_at')
      .filter((d) => JSON.parse(d.scopes).includes('local'))
      .map((d) => {
        const c = this.conns.get(d.id);
        return { id: d.id, name: d.name, online: !!c, allowed: d.local_exec === 'allow', root: c?.root ?? d.local_root, host: c?.host ?? null, lastSeenAt: d.last_seen_at };
      });
  }

  /** 守护进程连上来：保持一条 SSE，任务从这里下发 */
  connect(deviceId: string, res: http.ServerResponse, root: string, host: string): () => void {
    this.conns.get(deviceId)?.res.end();
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    res.write(': hello\n\n');
    const conn = { res, root: root.slice(0, 500), host: host.slice(0, 100), since: now() };
    this.conns.set(deviceId, conn);
    this.store.run('UPDATE devices SET local_root = ? WHERE id = ?', conn.root, deviceId);
    const beat = setInterval(() => res.write(': ping\n\n'), 20_000);
    const close = () => {
      clearInterval(beat);
      if (this.conns.get(deviceId) === conn) this.conns.delete(deviceId);
      for (const j of this.jobs.values()) if (j.deviceId === deviceId && j.status === 'running') this.finish(j, { ok: false, error: '本机守护进程断开了' });
    };
    res.on('close', close);
    return () => res.end();
  }

  setAllowed(deviceId: string, allow: boolean, by: string) {
    const m = this.machines().find((x) => x.id === deviceId);
    if (!m) throw new ServiceError(404, '没有这台电脑');
    this.store.run('UPDATE devices SET local_exec = ? WHERE id = ?', allow ? 'allow' : 'off', deviceId);
    if (!allow) {
      // 立即失效：取消在途任务，通知守护进程停掉对应的命令
      for (const j of this.jobs.values()) {
        if (j.deviceId !== deviceId || j.status !== 'running') continue;
        this.conns.get(deviceId)?.res.write(`data: ${JSON.stringify({ type: 'cancel', id: j.id })}\n\n`);
        this.finish(j, { ok: false, error: '用户刚刚关闭了这台电脑的本机执行' }, 'cancelled');
      }
    }
    this.store.emit('device.paired', { deviceId, name: m.name, localExec: allow ? 'allow' : 'off', by });
    return this.machines().find((x) => x.id === deviceId)!;
  }

  private pick(machine: string): Machine {
    const all = this.machines();
    const m = all.find((x) => x.name === machine || x.id === machine) ?? (all.length === 1 && !machine ? all[0] : undefined);
    if (!m) throw new ServiceError(404, `没有叫 ${machine} 的电脑。可用的：${all.map((x) => x.name).join('、') || '（没有）'}`);
    if (!m.allowed) throw new ServiceError(403, `${m.name} 没有开启本机执行（用户可以在 设置 → 本机执行 里打开）`);
    if (!m.online) throw new ServiceError(409, `${m.name} 的守护进程现在不在线`);
    return m;
  }

  /** 下发一个任务；最多等 waitMs，没做完就返回 running 和任务编号 */
  async submit(machine: string, op: Job['op'], args: Record<string, unknown>, waitMs: number) {
    const m = this.pick(machine);
    const id = `job_${randomBytes(6).toString('hex')}`;
    const job: Job = { id, deviceId: m.id, op, summary: String(args.command ?? args.path ?? ''), status: 'running', waiters: new Set(), createdAt: Date.now() };
    this.jobs.set(id, job);
    this.conns.get(m.id)!.res.write(`data: ${JSON.stringify({ type: 'job', id, op, ...args })}\n\n`);
    await this.wait(job, waitMs);
    return this.view(job, m.name);
  }

  async await(jobId: string, waitMs: number) {
    const job = this.jobs.get(jobId);
    if (!job) throw new ServiceError(404, '没有这个任务（或已过期）');
    await this.wait(job, waitMs);
    return this.view(job, this.machines().find((x) => x.id === job.deviceId)?.name ?? job.deviceId);
  }

  respond(deviceId: string, body: any) {
    const job = this.jobs.get(String(body?.id ?? ''));
    if (!job || job.deviceId !== deviceId) throw new ServiceError(404, '没有这个任务');
    if (job.status === 'running') {
      const cap = (v: unknown) => (typeof v === 'string' ? v.slice(0, 200_000) : undefined);
      this.finish(job, {
        ok: !!body.ok, exitCode: typeof body.exitCode === 'number' ? body.exitCode : null,
        stdout: cap(body.stdout), stderr: cap(body.stderr), content: cap(body.content), error: cap(body.error),
      });
    }
    return { ok: true };
  }

  private finish(job: Job, result: NonNullable<Job['result']>, status: Job['status'] = 'done') {
    job.status = status;
    job.result = result;
    for (const w of job.waiters) w();
    job.waiters.clear();
  }

  private wait(job: Job, ms: number): Promise<void> {
    if (job.status !== 'running') return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => { job.waiters.delete(done); resolve(); }, ms);
      const done = () => { clearTimeout(t); resolve(); };
      job.waiters.add(done);
    });
  }

  private view(job: Job, machine: string) {
    return { jobId: job.id, machine, status: job.status, ...job.result };
  }
}

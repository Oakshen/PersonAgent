// Routine：定时（cron）或 webhook 触发，在该 Agent 当前的会话里跑一轮。
// 没有新内容时 Agent 只回 NO_NEWS：时间线上折叠成一行，不推送通知；有新内容才通知你。
// Agent 可以自己用 pagent MCP 的 create_routine 建（比如你说"每天 8 点给我盘前要闻"）。
import { randomBytes } from 'node:crypto';
import { type BotRow, type Store, newId, now } from './store.ts';
import type { Runner } from './runner.ts';
import { ServiceError } from './service.ts';

export const TZ = process.env.PAGENT_TZ || 'Asia/Shanghai';
export const NO_NEWS = 'NO_NEWS';

export interface RoutineRow {
  id: string; bot_id: string; name: string; prompt: string; schedule: string | null; webhook_token: string | null;
  enabled: number; created_by: string; created_at: string; last_fired_at: string | null; next_at: string | null;
}

// ---- cron（5 段：分 时 日 月 周，按 TZ 时区） ----

const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

function field(spec: string, [lo, hi]: [number, number], isDow: boolean): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new ServiceError(400, `cron 写法不对：${spec}`);
    let a = lo, b = hi;
    if (m[2] !== undefined) { a = Number(m[2]); b = m[3] !== undefined ? Number(m[3]) : (m[4] ? hi : a); }
    const step = m[4] ? Number(m[4]) : 1;
    if (isDow && b === 7) b = 6;
    if (a < lo || b > (isDow ? 7 : hi) || a > b || step < 1) throw new ServiceError(400, `cron 超出范围：${spec}`);
    for (let v = a; v <= b; v += step) out.add(isDow && v === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(expr: string) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new ServiceError(400, 'cron 要 5 段：分 时 日 月 周，例如 "0 8 * * *" 是每天 8 点');
  const [min, hour, dom, mon, dow] = parts.map((p, i) => field(p, RANGES[i], i === 4));
  return { min, hour, dom, mon, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short',
});
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function local(t: number) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { min: +p.minute, hour: +p.hour, dom: +p.day, mon: +p.month, dow: WD[p.weekday] };
}

/** from 之后（不含）下一次触发的时间 */
export function nextFire(expr: string, from: number): number | null {
  const c = parseCron(expr);
  let t = Math.floor(from / 60_000) * 60_000 + 60_000;
  const end = from + 400 * 86_400_000;
  while (t < end) {
    const l = local(t);
    // 日和周都限定时，按 cron 惯例任一满足即可
    const dayOk = c.domAny && c.dowAny ? true
      : c.domAny ? c.dow.has(l.dow) : c.dowAny ? c.dom.has(l.dom) : c.dom.has(l.dom) || c.dow.has(l.dow);
    if (!c.mon.has(l.mon) || !dayOk) { t += (24 * 60 - (l.hour * 60 + l.min)) * 60_000; continue; }
    if (!c.hour.has(l.hour)) { t += (60 - l.min) * 60_000; continue; }
    if (c.min.has(l.min)) return t;
    t += 60_000;
  }
  return null;
}

/** 给人看的说明 */
export function describe(expr: string | null): string {
  if (!expr) return '只由 webhook 触发';
  const m = /^(\d+) (\d+) \* \* \*$/.exec(expr);
  if (m) return `每天 ${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`;
  const w = /^(\d+) (\d+) \* \* 1-5$/.exec(expr);
  if (w) return `工作日 ${w[2].padStart(2, '0')}:${w[1].padStart(2, '0')}`;
  const hr = /^(\d+) \* \* \* \*$/.exec(expr);
  if (hr) return `每小时第 ${hr[1]} 分`;
  const ev = /^\*\/(\d+) \* \* \* \*$/.exec(expr);
  if (ev) return `每 ${ev[1]} 分钟`;
  return `cron ${expr}`;
}

// ---- 增删改查 ----

export function toRoutine(r: RoutineRow, bots?: Map<string, string>) {
  return {
    id: r.id, botId: r.bot_id, bot: bots?.get(r.bot_id) ?? null, name: r.name, prompt: r.prompt, schedule: r.schedule,
    when: describe(r.schedule), webhook: r.webhook_token ? `/hook/${r.webhook_token}` : null, enabled: !!r.enabled,
    createdBy: r.created_by, createdAt: r.created_at, lastFiredAt: r.last_fired_at, nextAt: r.next_at,
  };
}

export function listRoutines(store: Store, botId?: string) {
  const bots = new Map(store.all<BotRow>('SELECT id, name FROM bots').map((b) => [b.id, b.name]));
  const rows = botId
    ? store.all<RoutineRow>('SELECT * FROM routines WHERE bot_id = ? ORDER BY created_at', botId)
    : store.all<RoutineRow>('SELECT * FROM routines ORDER BY created_at');
  return rows.map((r) => toRoutine(r, bots));
}

interface RoutineInput { name?: unknown; prompt?: unknown; schedule?: unknown; webhook?: unknown; enabled?: unknown }

export function createRoutine(store: Store, botId: string, b: RoutineInput, by: string) {
  const name = String(b.name ?? '').trim().slice(0, 60);
  const prompt = String(b.prompt ?? '').trim().slice(0, 4000);
  const schedule = b.schedule ? String(b.schedule).trim() : null;
  if (!name || !prompt) throw new ServiceError(400, '名字和要做的事都不能为空');
  if (!schedule && !b.webhook) throw new ServiceError(400, '要么给定时（cron），要么开 webhook');
  const next = schedule ? nextFire(schedule, Date.now()) : null;
  if (schedule && next === null) throw new ServiceError(400, '这个 cron 一年内都不会触发');
  const id = newId('rtn');
  store.tx(() => {
    store.run(
      `INSERT INTO routines(id, bot_id, name, prompt, schedule, webhook_token, enabled, created_by, created_at, next_at)
       VALUES (?,?,?,?,?,?,1,?,?,?)`,
      id, botId, name, prompt, schedule, b.webhook ? randomBytes(18).toString('base64url') : null, by, now(),
      next ? new Date(next).toISOString() : null);
    store.emit('routine.changed', { op: 'create', id, name, when: describe(schedule), by }, { botId });
  });
  return toRoutine(store.get<RoutineRow>('SELECT * FROM routines WHERE id = ?', id)!);
}

export function updateRoutine(store: Store, id: string, b: RoutineInput, by: string) {
  const r = store.get<RoutineRow>('SELECT * FROM routines WHERE id = ?', id);
  if (!r) throw new ServiceError(404, '没有这个 Routine');
  const schedule = b.schedule === undefined ? r.schedule : (b.schedule ? String(b.schedule).trim() : null);
  const enabled = b.enabled === undefined ? !!r.enabled : !!b.enabled;
  const next = schedule ? nextFire(schedule, Date.now()) : null;
  store.tx(() => {
    store.run('UPDATE routines SET name = ?, prompt = ?, schedule = ?, enabled = ?, next_at = ? WHERE id = ?',
      b.name ? String(b.name).trim().slice(0, 60) : r.name, b.prompt ? String(b.prompt).trim().slice(0, 4000) : r.prompt,
      schedule, enabled ? 1 : 0, next ? new Date(next).toISOString() : null, id);
    store.emit('routine.changed', { op: 'update', id, name: r.name, enabled, by }, { botId: r.bot_id });
  });
  return toRoutine(store.get<RoutineRow>('SELECT * FROM routines WHERE id = ?', id)!);
}

export function deleteRoutine(store: Store, id: string, by: string): void {
  const r = store.get<RoutineRow>('SELECT * FROM routines WHERE id = ?', id);
  if (!r) throw new ServiceError(404, '没有这个 Routine');
  store.tx(() => {
    store.run('DELETE FROM routines WHERE id = ?', id);
    store.emit('routine.changed', { op: 'delete', id, name: r.name, by }, { botId: r.bot_id });
  });
}

// ---- 触发 ----

/** 把 Routine 作为一条消息放进 Agent 当前会话的队列 */
export function fireRoutine(store: Store, runner: Runner, r: RoutineRow, trigger: 'schedule' | 'webhook' | 'manual', payload?: string) {
  const text = [
    `[Routine「${r.name}」· ${{ schedule: '定时触发', webhook: 'webhook 触发', manual: '手动运行' }[trigger]}]`,
    r.prompt,
    payload ? `\n触发时附带的数据：\n${payload.slice(0, 16_000)}` : '',
    `\n（这是自动运行的任务，用户此刻不一定在看。如果和上次相比没有值得告诉用户的新内容，只回复 ${NO_NEWS} 这一个词，不要别的；有新内容就直接汇报结论。）`,
  ].filter(Boolean).join('\n');
  store.tx(() => {
    store.run('UPDATE routines SET last_fired_at = ? WHERE id = ?', now(), r.id);
    store.emit('routine.fired', { phase: 'start', routineId: r.id, name: r.name, trigger }, { botId: r.bot_id });
  });
  return runner.enqueue(r.bot_id, text, { routine: { id: r.id, name: r.name, trigger } });
}

export function fireByWebhook(store: Store, runner: Runner, token: string, payload: string) {
  const r = store.get<RoutineRow>('SELECT * FROM routines WHERE webhook_token = ? AND enabled = 1', token);
  if (!r) throw new ServiceError(404, 'not found');
  fireRoutine(store, runner, r, 'webhook', payload);
  return { ok: true };
}

/** 调度：每 20 秒看一次到点的 Routine。pagentd 停机期间错过的，回来后只补跑一次。 */
export function startScheduler(store: Store, runner: Runner): NodeJS.Timeout {
  const tick = () => {
    const due = store.all<RoutineRow>("SELECT * FROM routines WHERE enabled = 1 AND schedule IS NOT NULL AND next_at <= ?", now());
    for (const r of due) {
      try {
        const next = nextFire(r.schedule!, Date.now());
        store.run('UPDATE routines SET next_at = ? WHERE id = ?', next ? new Date(next).toISOString() : null, r.id);
        fireRoutine(store, runner, r, 'schedule');
      } catch (e) { console.error('routine', r.id, e); }
    }
  };
  tick();
  return setInterval(tick, 20_000);
}

// 审批：绑定到一次具体工具调用（action + 输入哈希），单次使用，有过期时间。
// 状态只能从 pending 转出一次（CAS），多设备同时点只有一个生效；超时、取消一律不放行。
import { createHash } from 'node:crypto';
import { type ApprovalRow, type Store, newId, now } from './store.ts';
import { summarize } from './policy.ts';
import type { ApprovalStatus } from '../../protocol/src/types.ts';

type Final = Exclude<ApprovalStatus, 'pending'>;

export class Approvals {
  private waiters = new Map<string, (s: Final) => void>();
  private timers = new Map<string, NodeJS.Timeout>();

  private store: Store;
  private ttlSec: number;

  constructor(store: Store, ttlSec: number) {
    this.store = store;
    this.ttlSec = ttlSec;
  }

  /** 创建审批并等待结果。调用方不在事务里。 */
  request(ref: { runId: string; botId: string; threadId: string; actionId: string }, tool: string, input: Record<string, unknown>): Promise<Final> {
    const id = newId('apv');
    const expiresAt = new Date(Date.now() + this.ttlSec * 1000).toISOString();
    const summary = summarize(tool, input);
    const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const result = new Promise<Final>((resolve) => this.waiters.set(id, resolve));
    this.store.tx(() => {
      this.store.run(
        `INSERT INTO approvals(id, run_id, action_id, tool, input_hash, summary, status, expires_at, created_at)
         VALUES (?,?,?,?,?,?, 'pending', ?, ?)`,
        id, ref.runId, ref.actionId, tool, inputHash, summary, expiresAt, now(),
      );
      this.store.emit('approval.requested', { approvalId: id, actionId: ref.actionId, tool, summary, expiresAt }, ref);
    });
    this.timers.set(id, setTimeout(() => this.settle(id, 'expired', 'system'), this.ttlSec * 1000));
    return result;
  }

  /** 用户（或系统）给出决定。返回是否由这次调用完成了状态转换。 */
  settle(id: string, status: Final, by: string): { ok: boolean; current: string | null } {
    const changed = this.store.tx(() => {
      const r = this.store.run(
        `UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?
         WHERE id = ? AND status = 'pending' AND (? != 'approved' OR expires_at > ?)`,
        status, by, now(), id, status, now(),
      );
      if (r.changes === 0) return false;
      const a = this.store.get<ApprovalRow & { bot_id: string; thread_id: string }>(
        'SELECT a.*, r.bot_id, r.thread_id FROM approvals a JOIN runs r ON r.id = a.run_id WHERE a.id = ?', id,
      )!;
      this.store.emit('approval.resolved', { approvalId: id, actionId: a.action_id, status, by },
        { runId: a.run_id, botId: a.bot_id, threadId: a.thread_id });
      return true;
    });
    const current = this.store.get<{ status: string }>('SELECT status FROM approvals WHERE id = ?', id)?.status ?? null;
    if (changed) {
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      this.waiters.get(id)?.(status);
      this.waiters.delete(id);
    } else if (current === 'pending') {
      // 批准时已过期：转成 expired，这次批准不生效
      this.settle(id, 'expired', 'system');
      return { ok: false, current: 'expired' };
    }
    return { ok: changed, current };
  }

  /** 一轮结束 / 被中断：所有待审批取消，等待中的 hook 立即得到拒绝。 */
  cancelRun(runId: string): void {
    const pending = this.store.all<{ id: string }>("SELECT id FROM approvals WHERE run_id = ? AND status = 'pending'", runId);
    for (const { id } of pending) this.settle(id, 'cancelled', 'system');
  }
}

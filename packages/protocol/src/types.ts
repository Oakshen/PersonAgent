// 控制面对外（CLI / Web / 手机）共享的类型。

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'interrupted' | 'unknown';
export type ActionStatus = 'pending_approval' | 'approved' | 'denied' | 'succeeded' | 'failed' | 'unknown';
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
export type Decision = 'allow' | 'ask' | 'deny';

export interface PolicyRule {
  tool: string;          // 工具名正则（整体匹配），如 "Bash" / "Write|Edit" / "mcp__github__.*"
  field?: string;        // 匹配 tool_input 的某个字段
  match?: string;        // 该字段值的正则
  decision: Decision;
  reason?: string;
}

export interface Bot {
  id: string;
  name: string;
  persona: string;
  model: string | null;
  policy: PolicyRule[];
  maxTurns: number;
  createdAt: string;
}

export interface PagentEvent {
  seq: number;
  ts: string;
  botId: string | null;
  threadId: string | null;
  runId: string | null;
  type: EventType;
  data: Record<string, unknown>;
}

export type EventType =
  | 'bot.created'
  | 'message.queued'
  | 'run.started'
  | 'run.init'
  | 'run.finished'
  | 'assistant.text'
  | 'tool.use'
  | 'tool.result'
  | 'action.decided'
  | 'action.completed'
  | 'approval.requested'
  | 'approval.resolved'
  | 'plugin.needs_consent';

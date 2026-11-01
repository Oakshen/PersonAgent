// 控制面对外（CLI / Web / 手机）共享的类型。

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'interrupted';
// 工具调用记录直接取自 claude 的输出流：tool_use 记 running，tool_result 回来定成败；
// 这一轮被打断时还没回结果的记 unknown（只写时间线，下一轮告诉 Agent，不打扰用户）
export type ActionStatus = 'running' | 'succeeded' | 'failed' | 'unknown';

export interface Bot {
  id: string;
  name: string;
  persona: string;
  model: string | null;
  maxTurns: number;          // 单轮 claude 内部最大轮次（--max-turns）
  dailyTurnBudget: number;   // 每天（UTC）累计轮次上限；订阅模式算不准费用，按轮次限
  maxRunSeconds: number;     // 单轮最长时长，超时自动中断
  maxActions: number;        // 单轮工具调用次数上限
  createdAt: string;
}

/** 全局记忆（关于用户）的一条 */
export interface MemoryEntry {
  id: string;
  text: string;
  sourceBot: string | null;  // 写入它的 Agent 名；用户自己写的为 null
  sourceRun: string | null;
  createdAt: string;
  updatedAt: string;
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
  | 'session.new'
  | 'session.compacted'
  | 'message.queued'
  | 'run.started'
  | 'run.init'
  | 'run.finished'
  | 'assistant.text'
  | 'tool.use'
  | 'tool.result'
  | 'memory.updated'
  | 'ask.created'
  | 'ask.answered'
  | 'plugin.needs_consent'
  | 'device.paired'
  | 'device.revoked';

/** Bot 在名单上的状态（印章角标）。asking：它问了你一个问题，还没回答 */
export type BotStatus = 'idle' | 'working' | 'asking' | 'failed';

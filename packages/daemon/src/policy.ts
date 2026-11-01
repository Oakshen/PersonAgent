// 策略引擎：Bot 自定义规则优先，其次是默认规则；第一条命中的规则生效。
import type { Decision, PolicyRule } from '../../protocol/src/types.ts';

export const DEFAULT_RULES: PolicyRule[] = [
  { tool: 'Bash', field: 'run_in_background', match: 'true', decision: 'deny', reason: '后台任务不受中断控制，已禁用；请在前台运行' },
  { tool: 'Read|Glob|Grep|LS|ToolSearch|TodoWrite|TaskOutput|NotebookRead', decision: 'allow' },
  { tool: 'Write|Edit|MultiEdit|NotebookEdit', field: 'file_path', match: '/work/.*', decision: 'allow' },
  { tool: 'Write|Edit|MultiEdit|NotebookEdit', decision: 'deny', reason: '只允许写入 /work' },
  { tool: '.*', decision: 'ask' },
];

// 不产生外部副作用的工具：执行中断时不会进入 unknown
const READ_ONLY = /^(Read|Glob|Grep|LS|ToolSearch|TodoWrite|TaskOutput|NotebookRead|WebSearch)$/;
export const hasSideEffect = (tool: string) => !READ_ONLY.test(tool);

export interface Verdict { decision: Decision; reason: string; rule: PolicyRule }

export function evaluate(botRules: PolicyRule[], tool: string, input: Record<string, unknown>): Verdict {
  for (const rule of [...botRules, ...DEFAULT_RULES]) {
    if (!fullMatch(rule.tool, tool)) continue;
    if (rule.field !== undefined) {
      const v = input[rule.field];
      if (v === undefined || !fullMatch(rule.match ?? '.*', String(v))) continue;
    }
    return { decision: rule.decision, reason: rule.reason ?? `规则 ${describe(rule)}`, rule };
  }
  throw new Error('unreachable: 默认规则以 .* 结尾');
}

const fullMatch = (pattern: string, s: string) => new RegExp(`^(?:${pattern})$`, 's').test(s);
const describe = (r: PolicyRule) => `${r.tool}${r.field ? `[${r.field}~${r.match}]` : ''} → ${r.decision}`;

/** 给审批界面看的一行摘要 */
export function summarize(tool: string, input: Record<string, unknown>): string {
  const pick = input.command ?? input.file_path ?? input.url ?? input.query ?? JSON.stringify(input);
  const s = String(pick);
  return `${tool}: ${s.length > 200 ? s.slice(0, 200) + '…' : s}`;
}

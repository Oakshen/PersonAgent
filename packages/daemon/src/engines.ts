// 引擎：claude（Claude Code，claude -p）和 codex（Codex CLI，codex exec，用 ChatGPT 订阅）。
// 两者都在盒子里跑；Runner 按 Claude 的 stream-json 处理输出，所以 Codex 的 JSONL 事件先在这里翻译成同样的形状。
export type Engine = 'claude' | 'codex';
export const ENGINES: Engine[] = ['claude', 'codex'];

export const engineOf = (v: unknown): Engine => (v === 'codex' ? 'codex' : 'claude');

/** 一轮 Codex 输出的翻译状态（哪些条目已经发过 tool_use、最后一段回复） */
export interface CodexState { started: Set<string>; lastText: string; turns: number }
export const codexState = (): CodexState => ({ started: new Set(), lastText: '', turns: 0 });

interface Item {
  id: string; type: string; text?: string; command?: string; aggregated_output?: string; exit_code?: number | null;
  status?: string; server?: string; tool?: string; arguments?: unknown; result?: any; error?: any;
  changes?: { path: string; kind: string }[]; query?: string; items?: unknown;
}

function toolOf(it: Item): { name: string; input: Record<string, unknown> } | null {
  switch (it.type) {
    case 'command_execution': return { name: 'Bash', input: { command: it.command ?? '' } };
    case 'mcp_tool_call': return { name: `mcp__${it.server}__${it.tool}`, input: (it.arguments ?? {}) as Record<string, unknown> };
    case 'file_change': return { name: 'Edit', input: { file_path: (it.changes ?? []).map((c) => `${c.kind} ${c.path}`).join(', ') } };
    case 'web_search': return { name: 'WebSearch', input: { query: it.query ?? '' } };
    default: return null;
  }
}

function resultOf(it: Item): { text: string; isError: boolean } {
  if (it.type === 'command_execution') {
    return { text: it.aggregated_output ?? '', isError: it.status === 'failed' || (it.exit_code ?? 0) !== 0 };
  }
  if (it.type === 'mcp_tool_call') {
    const content = it.result?.content;
    const text = Array.isArray(content) ? content.map((c: any) => c.text ?? `[${c.type}]`).join('\n') : JSON.stringify(it.result ?? it.error ?? '');
    return { text: it.error ? String(it.error?.message ?? it.error) : text, isError: it.status === 'failed' || !!it.error || !!it.result?.isError };
  }
  return { text: it.status ?? '', isError: it.status === 'failed' };
}

/** 一条 Codex 事件 → 零到多条 Claude 形状的消息 */
export function fromCodex(ev: any, st: CodexState): any[] {
  const out: any[] = [];
  const it: Item | undefined = ev.item;
  const use = (i: Item) => {
    const t = toolOf(i);
    if (!t || st.started.has(i.id)) return;
    st.started.add(i.id);
    out.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: i.id, name: t.name, input: t.input }] } });
  };
  switch (ev.type) {
    case 'thread.started':
      out.push({ type: 'system', subtype: 'init', session_id: ev.thread_id, model: 'codex', permissionMode: 'bypassPermissions', mcp_servers: [] });
      break;
    case 'turn.started':
      st.turns++;
      break;
    case 'item.started':
      if (it) use(it);
      break;
    case 'item.completed':
      if (!it) break;
      if (it.type === 'agent_message' && it.text) {
        st.lastText = it.text;
        out.push({ type: 'assistant', message: { content: [{ type: 'text', text: it.text }] } });
      } else if (toolOf(it)) {
        use(it);
        const r = resultOf(it);
        out.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: it.id, is_error: r.isError, content: r.text.slice(0, 4000) }] } });
      }
      break;
    case 'turn.completed':
      out.push({ type: 'result', subtype: 'success', is_error: false, num_turns: st.turns || 1, usage: ev.usage ?? null, result: st.lastText });
      break;
    case 'turn.failed':
      out.push({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: st.turns || 1, result: String(ev.error?.message ?? 'Codex 这一轮失败了') });
      break;
    case 'error':
      // 非致命的错误（比如重连）codex 会接着跑；致命的会跟着 turn.failed
      break;
  }
  return out;
}

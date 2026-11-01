// claude 的 PreToolUse / PostToolUse hook：把工具调用转给控制面，由控制面决定放行、拒绝或等审批。
// 控制面不可达时 fail-closed：pre 一律拒绝。
const event = process.argv[2];
let body = '';
for await (const chunk of process.stdin) body += chunk;

const deny = (reason) => JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});

try {
  const res = await fetch(`${process.env.PAGENT_HOOK_URL}/hook/${event}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-pagent-run': process.env.PAGENT_RUN_ID ?? '',
      'x-pagent-token': process.env.PAGENT_HOOK_TOKEN ?? '',
    },
    body,
    signal: AbortSignal.timeout(590_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text}`);
  process.stdout.write(text);
} catch (e) {
  if (event === 'pre') process.stdout.write(deny(`pagent 控制面不可达，默认拒绝（${e.message}）`));
}

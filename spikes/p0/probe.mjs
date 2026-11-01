// P0 探针：以 stream-json 双向协议驱动官方 claude CLI，验证权限回调 / 中断 / resume。
// 用法：node probe.mjs <basic|perm|interrupt|resume> [sessionId]
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const [scenario = 'basic', resumeId] = process.argv.slice(2);
const cwd = process.env.PROBE_CWD ?? mkdtempSync(join(tmpdir(), 'pagent-p0-'));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const args = [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--permission-prompt-tool', 'stdio', '--permission-mode', 'default',
  ...(resumeId ? ['--resume', resumeId] : []),
  ...(process.env.PROBE_MCP ? ['--mcp-config', process.env.PROBE_MCP, '--strict-mcp-config'] : []),
];
// 白名单环境：不继承宿主（如桌面 App）的 CLAUDE_CODE_* / ANTHROPIC_* 变量
const env = Object.fromEntries(
  ['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'TMPDIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
   'CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL']
    .filter((k) => process.env[k]).map((k) => [k, process.env[k]]),
);
const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'inherit'] });
const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
const userMsg = (text) => send({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' });
let reqSeq = 0;
const control = (request) => send({ type: 'control_request', request_id: `host-${++reqSeq}`, request });

const prompts = {
  basic: '记住暗号 "蓝鲸42"。只回复：好的。',
  perm: '用 Bash 执行 `echo hi > a.txt`，再用 Write 工具创建 b.txt 内容为 x。两步都要尝试，然后告诉我结果。',
  mcp: '用 demo 插件的 http_get 依次抓取 https://api.github.com/zen 和 https://example.com ，分别报告结果。',
  escape: '依次用 Bash 执行这些命令并原样报告输出：`curl -sS -m 5 https://example.com -o /dev/null -w %{http_code}`；`curl -sS -m 5 --noproxy "*" https://example.com -o /dev/null -w %{http_code}`；`curl -sS -m 3 http://169.254.169.254/`；`id`；`touch /usr/x`；`ls /home/agent/.claude`。',
  interrupt: '用 Bash 执行 `sleep 40 && echo done > slept.txt`，等它结束后告诉我。',
  resume: '我之前让你记住的暗号是什么？只回复暗号。',
};

control({ subtype: 'initialize', hooks: null });
userMsg(prompts[scenario]);

let interrupted = false;
createInterface({ input: child.stdout }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return log('RAW', line); }
  switch (m.type) {
    case 'system':
      if (m.subtype === 'init') log('INIT session', m.session_id, 'model', m.model, 'tools', m.tools?.length, 'mcp', JSON.stringify(m.mcp_servers));
      else log('SYSTEM', m.subtype);
      break;
    case 'assistant':
      for (const c of m.message.content) {
        if (c.type === 'text') log('TEXT', c.text);
        if (c.type === 'tool_use') {
          log('TOOL_USE', c.name, JSON.stringify(c.input));
          if (scenario === 'interrupt' && !interrupted) {
            interrupted = true;
            setTimeout(() => { log('>>> send interrupt'); control({ subtype: 'interrupt' }); }, 4000);
            setTimeout(() => {
              log('sleep 进程:', execSync('ps -eo pid,comm,args | awk \'$2=="sleep"\' || true').toString().trim() || '(无)');
              log('slept.txt 存在?', existsSync(join(cwd, 'slept.txt')));
            }, 8000);
          }
        }
      }
      break;
    case 'user':
      for (const c of m.message.content ?? []) if (c.type === 'tool_result') log('TOOL_RESULT', c.is_error ? 'ERR' : 'OK', JSON.stringify(c.content).slice(0, 160));
      break;
    case 'control_request': {
      const r = m.request;
      log('CAN_USE_TOOL?', r.subtype, r.tool_name, JSON.stringify(r.input));
      // 策略：Bash 放行，其余拒绝
      const allow = r.tool_name === 'Bash' || r.tool_name.startsWith('mcp__demo__');
      send({
        type: 'control_response',
        response: {
          subtype: 'success', request_id: m.request_id,
          response: allow ? { behavior: 'allow', updatedInput: r.input } : { behavior: 'deny', message: 'pagent 策略拒绝：' + r.tool_name },
        },
      });
      break;
    }
    case 'control_response':
      log('CTRL_RESP', JSON.stringify(m.response).slice(0, 200));
      break;
    case 'result':
      log('RESULT', m.subtype, 'is_error', m.is_error, 'turns', m.num_turns, 'cost', m.total_cost_usd, 'session', m.session_id);
      child.stdin.end();
      break;
    default:
      log('EVT', m.type, line.slice(0, 160));
  }
});
child.on('exit', (code, sig) => { log('EXIT', code, sig, 'cwd', cwd); });
setTimeout(() => { log('TIMEOUT kill'); child.kill('SIGTERM'); }, 120_000).unref();

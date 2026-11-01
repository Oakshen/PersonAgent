// 出口代理：按来源容器（DNS 名 → IP）做目标白名单，支持 CONNECT 和明文 HTTP 转发。
// 规则文件 RULES_FILE：{"<容器名>": ["host:port", "*.suffix:443"]}，由 pagentd 写入，这里每 2 秒重读。
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { readFileSync } from 'node:fs';

let rules = {};
let ipToName = new Map();
async function refresh() {
  try { rules = JSON.parse(readFileSync(process.env.RULES_FILE, 'utf8')); } catch {}
  const next = new Map();
  for (const name of Object.keys(rules)) {
    try { for (const { address } of await dns.lookup(name, { all: true })) next.set(address, name); } catch {}
  }
  ipToName = next;
}
await refresh();
setInterval(refresh, 2000);

const BLOCKED_NETS = [/^169\.254\./, /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];
function decide(srcIp, host, port) {
  const who = ipToName.get(srcIp.replace(/^::ffff:/, '')) ?? 'unknown';
  const target = `${host}:${port}`;
  const allowed = (rules[who] ?? []).some((p) =>
    p === target || (p.startsWith('*.') && target.endsWith(p.slice(1))));
  // 白名单里没显式写出的内网 / 元数据地址一律拒绝
  const ok = allowed && !(BLOCKED_NETS.some((re) => re.test(host)) && !(rules[who] ?? []).includes(target));
  console.log(JSON.stringify({ t: new Date().toISOString(), who, target, decision: ok ? 'allow' : 'deny' }));
  return ok;
}

const server = http.createServer((req, res) => {
  // 明文 HTTP 代理：req.url 是绝对 URL
  let u;
  try { u = new URL(req.url); } catch { res.writeHead(400).end(); return; }
  const port = u.port || 80;
  if (!decide(req.socket.remoteAddress, u.hostname, port)) { res.writeHead(403).end('pagent egress: denied\n'); return; }
  // 凭据注入：worker 只持有占位 token，真实凭据由代理在出口处替换
  const headers = { ...req.headers };
  const inj = process.env.INJECT_TARGET === `${u.hostname}:${port}` && process.env.INJECT_TOKEN;
  if (inj) { delete headers['x-api-key']; headers.authorization = `Bearer ${inj}`; }
  const up = http.request({ host: u.hostname, port, path: u.pathname + u.search, method: req.method, headers }, (r) => {
    res.writeHead(r.statusCode, r.headers); r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.on('error', () => up.destroy());
  req.pipe(up);
});
server.on('connect', (req, sock, head) => {
  sock.on('error', () => {}); // 客户端在拒绝后重置连接不能拖垮代理
  const [host, port = '443'] = req.url.split(':');
  if (!decide(sock.remoteAddress, host, port)) { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const up = net.connect(+port, host, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.write(head); up.pipe(sock); sock.pipe(up); });
  up.on('error', () => sock.destroy());
  sock.on('error', () => up.destroy());
  sock.on('close', () => up.destroy());
});
server.on('clientError', (_e, sock) => sock.destroy());
process.on('uncaughtException', (e) => console.error(JSON.stringify({ t: new Date().toISOString(), uncaught: e.code ?? e.message })));
server.listen(3128, () => console.log('egress proxy :3128', process.env.RULES_FILE));

// 出口代理：按来源容器（DNS 名 → IP）放行目标，支持 CONNECT 和明文 HTTP 转发。
// 规则文件 RULES_FILE：{"<容器名>": ["*"] 或 ["host:port", "*.suffix:443"]}，由 pagentd 写入，这里每 2 秒重读。
// - "*"：放行整个公网（Agent 的 worker 用这个）。
// - 不管规则怎么写，目标解析出的地址落在局域网、回环、链路本地（含云元数据）、CGNAT 等私有段就拒绝，
//   除非规则里逐字写了这个 host:port。连接用的就是校验过的那个 IP，防 DNS 重绑定。
// - 家里路由器常用 fake-ip（Clash / sing-box，默认 198.18.0.0/15）：域名都解析成假地址，由路由器代连。
//   这类地址本身放行，但要再用 DoH 查一次真实地址，真实地址是内网的照样拒绝（防 192.168.0.1.nip.io 这种）。
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { readFileSync } from 'node:fs';

let rules = {};
let ipToName = new Map();
// 可选的上游代理（按容器名）：比如让盒子的公网流量走家里的住宅线路。目标照样先在这里校验过。
let upstreams = {};
async function refresh() {
  try { rules = JSON.parse(readFileSync(process.env.RULES_FILE, 'utf8')); } catch {}
  try { upstreams = process.env.UPSTREAMS_FILE ? JSON.parse(readFileSync(process.env.UPSTREAMS_FILE, 'utf8')) : {}; } catch { upstreams = {}; }
  const next = new Map();
  for (const name of Object.keys(rules)) {
    try { for (const { address } of await dns.lookup(name, { all: true })) next.set(address, name); } catch {}
  }
  ipToName = next;
}

const blockList = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['224.0.0.0', 3]]) blockList.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blockList.addSubnet(a, p, 'ipv6');

/** 地址是否属于私有 / 保留网段（IPv4 映射的 IPv6 按 IPv4 判断） */
export function isPrivate(ip) {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (v4) return blockList.check(v4, 'ipv4');
  return blockList.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4');
}

const fakeIp = new net.BlockList();
for (const cidr of (process.env.FAKE_IP_NETS ?? '198.18.0.0/15').split(',').filter(Boolean)) {
  const [a, p] = cidr.split('/');
  fakeIp.addSubnet(a, Number(p), net.isIPv6(a) ? 'ipv6' : 'ipv4');
}
const isFake = (ip) => net.isIPv4(ip) && fakeIp.check(ip, 'ipv4');

/** 用 DoH 查真实地址（路由器劫持了 53 端口，普通 DNS 查到的也是假地址）。查不到返回 null。 */
const dohCache = new Map();
async function doh(host) {
  const hit = dohCache.get(host);
  if (hit && hit.exp > Date.now()) return hit.ips;
  let ips = null;
  try {
    const q = async (type) => {
      const r = await fetch(`${process.env.DOH_URL ?? 'https://1.1.1.1/dns-query'}?name=${encodeURIComponent(host)}&type=${type}`,
        { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(4000) });
      return ((await r.json()).Answer ?? []).filter((a) => a.type === 1 || a.type === 28).map((a) => a.data);
    };
    ips = (await Promise.all([q('A'), q('AAAA')])).flat();
  } catch {}
  dohCache.set(host, { ips, exp: Date.now() + 60_000 });
  return ips;
}

const whoOf = (srcIp) => ipToName.get(String(srcIp).replace(/^::ffff:/, '')) ?? 'unknown';

/** 这个来源要不要经上游代理出去；返回 { host, port, auth } 或 null */
function upstreamFor(srcIp) {
  const u = upstreams[whoOf(srcIp)];
  if (!u) return null;
  try {
    const url = new URL(u);
    const auth = url.username ? Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64') : null;
    return { host: url.hostname, port: Number(url.port || 80), auth };
  } catch { return null; }
}

/** 决定是否放行；放行时返回要连接的 IP。 */
export async function decide(srcIp, host, port, lookup = dns.lookup, realLookup = doh) {
  const who = whoOf(srcIp);
  const target = `${host}:${port}`;
  const list = rules[who] ?? [];
  const exact = list.includes(target);
  const matched = exact || list.includes('*') || list.some((p) => p.startsWith('*.') && target.endsWith(p.slice(1)));
  let ip = null;
  let reason = matched ? null : 'not_allowed';
  if (matched) {
    try {
      const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
      // 显式写出的 host:port 可以是内网（如插件要访问的局域网服务），否则任一地址是私有的就拒绝
      if (!exact && addrs.some((a) => isPrivate(a.address))) reason = 'private_address';
      else if (!exact && addrs.some((a) => isFake(a.address)) && (await realLookup(host) ?? []).some(isPrivate)) reason = 'private_address_behind_fake_ip';
      else ip = addrs[0]?.address ?? null;
      if (!ip && !reason) reason = 'no_address';
    } catch { reason = 'dns_failed'; }
  }
  console.log(JSON.stringify({ t: new Date().toISOString(), who, target, ip, decision: ip ? 'allow' : 'deny', reason, via: ip && upstreams[who] ? 'upstream' : undefined }));
  return ip;
}

function start() {
  const server = http.createServer(async (req, res) => {
    // 明文 HTTP 代理：req.url 是绝对 URL
    let u;
    try { u = new URL(req.url); } catch { res.writeHead(400).end(); return; }
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const port = u.port || 80;
    const ip = await decide(req.socket.remoteAddress, host, port);
    if (!ip) { res.writeHead(403).end('pagent egress: denied\n'); return; }
    // 凭据注入：worker 只持有占位 token，真实凭据由代理在出口处替换
    const headers = { ...req.headers };
    const inj = process.env.INJECT_TARGET === `${host}:${port}` && process.env.INJECT_TOKEN;
    if (inj) { delete headers['x-api-key']; headers.authorization = `Bearer ${inj}`; }
    const via = upstreamFor(req.socket.remoteAddress);
    if (via?.auth) headers['proxy-authorization'] = `Basic ${via.auth}`;
    const target = via
      ? { host: via.host, port: via.port, path: `http://${net.isIPv6(ip) ? `[${ip}]` : ip}:${port}${u.pathname}${u.search}` }
      : { host: ip, port, path: u.pathname + u.search };
    const up = http.request({ ...target, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers); r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('error', () => up.destroy());
    req.pipe(up);
  });
  server.on('connect', async (req, sock, head) => {
    sock.on('error', () => {}); // 客户端在拒绝后重置连接不能拖垮代理
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url) ?? [null, req.url, '443'];
    const [, host, port] = m;
    const ip = await decide(sock.remoteAddress, host, port);
    if (!ip) { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const via = upstreamFor(sock.remoteAddress);
    const dest = `${net.isIPv6(ip) ? `[${ip}]` : ip}:${port}`;
    const up = via ? net.connect(via.port, via.host) : net.connect(+port, ip);
    const established = () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.write(head); up.pipe(sock); sock.pipe(up); };
    up.on('connect', () => {
      if (!via) return established();
      // 经上游代理：先对上游发 CONNECT（用校验过的 IP，不让上游再解析一遍）
      up.write(`CONNECT ${dest} HTTP/1.1\r\nHost: ${dest}\r\n${via.auth ? `Proxy-Authorization: Basic ${via.auth}\r\n` : ''}\r\n`);
      let buf = Buffer.alloc(0);
      const onData = (d) => {
        buf = Buffer.concat([buf, d]);
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        up.off('data', onData);
        if (!/^HTTP\/1\.[01] 200/.test(buf.toString('latin1', 0, 16))) { sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); up.destroy(); return; }
        const rest = buf.subarray(end + 4);
        established();
        if (rest.length) sock.write(rest);
      };
      up.on('data', onData);
    });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
    sock.on('close', () => up.destroy());
  });
  server.on('clientError', (_e, sock) => sock.destroy());
  process.on('uncaughtException', (e) => console.error(JSON.stringify({ t: new Date().toISOString(), uncaught: e.code ?? e.message })));
  server.listen(3128, () => console.log('egress proxy :3128', process.env.RULES_FILE));
}

export const _test = { setRules: (r, map) => { rules = r; ipToName = map; } };

if (process.env.RULES_FILE) {
  await refresh();
  setInterval(refresh, 2000);
  start();
}

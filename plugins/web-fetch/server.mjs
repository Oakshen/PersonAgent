// 零依赖 MCP server（Streamable HTTP，JSON 响应模式）。出网经 egress 代理，只能到清单声明的站点。
import http from 'node:http';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('./pagent-plugin.json', import.meta.url)));
const TOOLS = [
  {
    name: 'fetch',
    description: '抓取一个 URL，返回状态码和前 1000 个字符',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'allowed_hosts',
    description: '列出本插件被允许访问的站点',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name, args) {
  if (name === 'allowed_hosts') return text(manifest.permissions.network.join('\n'));
  if (name === 'fetch') {
    try {
      const r = await fetch(args.url, { signal: AbortSignal.timeout(10_000) });
      return text(`HTTP ${r.status}\n${(await r.text()).slice(0, 1000)}`);
    } catch (e) {
      // 代理拒绝时 fetch 只会报一个笼统的错误，这里翻译成明确的权限提示
      const host = (() => { try { return new URL(args.url).host; } catch { return args.url; } })();
      return text(`抓取失败：${host} 不在本插件声明的出网范围内，或网络不可达（${e.cause?.code ?? e.message}）`, true);
    }
  }
  throw Object.assign(new Error(`未知工具 ${name}`), { code: -32602 });
}
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], isError });

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return null; // 通知，无需响应
  try {
    let result;
    if (method === 'initialize') {
      result = {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: manifest.id, version: manifest.version },
      };
    } else if (method === 'tools/list') result = { tools: TOOLS };
    else if (method === 'tools/call') result = await callTool(params.name, params.arguments ?? {});
    else if (method === 'ping') result = {};
    else return { jsonrpc: '2.0', id, error: { code: -32601, message: `不支持的方法 ${method}` } };
    return { jsonrpc: '2.0', id, result };
  } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: e.code ?? -32603, message: e.message } };
  }
}

http.createServer(async (req, res) => {
  if (req.url !== '/mcp') return res.writeHead(404).end();
  if (req.method !== 'POST') return res.writeHead(405).end();
  let body = '';
  for await (const c of req) body += c;
  const msg = JSON.parse(body);
  const out = Array.isArray(msg) ? (await Promise.all(msg.map(handle))).filter(Boolean) : await handle(msg);
  if (!out || (Array.isArray(out) && !out.length)) return res.writeHead(202).end();
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
}).listen(Number(process.env.PORT ?? 8080), () => console.log(`${manifest.id} MCP :${process.env.PORT ?? 8080}/mcp`));

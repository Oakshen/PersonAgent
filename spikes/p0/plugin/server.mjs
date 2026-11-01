// 示例插件：HTTP MCP server，暴露 http_get。出网只能走 egress 代理（NODE_USE_ENV_PROXY=1）。
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

function build() {
  const mcp = new McpServer({ name: 'plugin-demo', version: '0.0.1' });
  mcp.tool('http_get', '抓取 URL 的前 300 字节', { url: z.string().url() }, async ({ url }) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      return { content: [{ type: 'text', text: `HTTP ${r.status}\n${(await r.text()).slice(0, 300)}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `失败：${e.cause?.message ?? e.message}` }], isError: true };
    }
  });
  return mcp;
}

http.createServer(async (req, res) => {
  if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => transport.close());
  await build().connect(transport);
  await transport.handleRequest(req, res, body);
}).listen(8080, () => console.log('plugin-demo MCP :8080/mcp'));

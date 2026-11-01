// 几个 HTTP 服务共用的小工具。
import type http from 'node:http';

export function readBody(req: http.IncomingMessage, limit = 5 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function send(res: http.ServerResponse, code: number, body: unknown): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }).end(text);
}

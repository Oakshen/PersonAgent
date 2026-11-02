// "screen" MCP：Agent 操作它自己那块屏幕（截图、点击、输入），自动绑定到它的显示器。
// 浏览器里的事优先用 browser MCP（Playwright 经 CDP 连它自己的 Chrome），这里管浏览器以外的、或要看画面的。
import type { Screens } from './screens.ts';

const TOOLS = [
  { name: 'screenshot', description: '截取你这块屏幕（1280×800）的当前画面', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'open_browser', description: '在你的屏幕上打开（或切到）Chrome，可选打开一个网址。浏览器登录状态和其他 Agent 共享。',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
  },
  {
    name: 'click', description: '在屏幕坐标 (x, y) 点击',
    inputSchema: {
      type: 'object', required: ['x', 'y'],
      properties: { x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string', enum: ['left', 'right', 'middle'] }, double: { type: 'boolean' } },
    },
  },
  { name: 'move', description: '把鼠标移到 (x, y)', inputSchema: { type: 'object', required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } } },
  { name: 'type', description: '在当前焦点处输入文字', inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
  {
    name: 'key', description: '按键或组合键，xdotool 写法，例如 Return、ctrl+l、ctrl+shift+t、Escape',
    inputSchema: { type: 'object', required: ['keys'], properties: { keys: { type: 'string' } } },
  },
  {
    name: 'fill_secret', description: '把保险箱里的一条凭据（例如 GITHUB_PASSWORD）直接输入到当前焦点处。值不会出现在对话里；先点中输入框再调用。',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, enter: { type: 'boolean', description: '输完是否按回车' } } },
  },
  {
    name: 'scroll', description: '在 (x, y) 处滚动',
    inputSchema: {
      type: 'object', required: ['direction'],
      properties: { x: { type: 'number' }, y: { type: 'number' }, direction: { type: 'string', enum: ['up', 'down'] }, amount: { type: 'number' } },
    },
  },
];

const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], isError });

export async function screenTool(screens: Screens, agentId: string, name: string, a: any, getSecret: (name: string) => Promise<string>): Promise<unknown> {
  const s = screens.get(agentId);
  if (s.takenOver) return text('用户正在接管你的屏幕，屏幕工具暂停。等用户交还后再继续。', true);
  screens.touch(agentId);
  const xy = () => [String(Math.round(Number(a.x))), String(Math.round(Number(a.y)))];
  switch (name) {
    case 'screenshot': {
      const png = await screens.screenshot(agentId);
      return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] };
    }
    case 'open_browser': {
      const sc = await screens.ensureChrome(agentId);
      if (a.url) {
        const r = await fetch(`http://127.0.0.1:${19222 + sc.n}/json/new?${encodeURI(String(a.url))}`, { method: 'PUT' });
        if (!r.ok) return text(`打开网址失败：${r.status}`, true);
      }
      return text(`Chrome 已在你的屏幕上打开${a.url ? `：${a.url}` : ''}。CDP 端口 127.0.0.1:${9222 + sc.n}。`);
    }
    case 'click': {
      const btn = { left: '1', middle: '2', right: '3' }[String(a.button ?? 'left')] ?? '1';
      await screens.xdotool(agentId, ['mousemove', ...xy(), 'click', ...(a.double ? ['--repeat', '2'] : []), btn]);
      return text('已点击');
    }
    case 'move':
      await screens.xdotool(agentId, ['mousemove', ...xy()]);
      return text('已移动');
    case 'type':
      await screens.xdotool(agentId, ['type', '--delay', '20', '--', String(a.text ?? '')]);
      return text('已输入');
    case 'fill_secret': {
      let v: string;
      try { v = await getSecret(String(a.name ?? '')); } catch (e) { return text((e as Error).message, true); }
      await screens.xdotool(agentId, ['type', '--delay', '20', '--', v]);
      if (a.enter) await screens.xdotool(agentId, ['key', 'Return']);
      return text(`已输入 ${a.name}（值没有显示）`);
    }
    case 'key':
      await screens.xdotool(agentId, ['key', '--', ...String(a.keys ?? '').split(/\s+/).filter(Boolean)]);
      return text('已按键');
    case 'scroll': {
      const btn = a.direction === 'up' ? '4' : '5';
      const pre = a.x !== undefined && a.y !== undefined ? ['mousemove', ...xy()] : [];
      await screens.xdotool(agentId, [...pre, 'click', '--repeat', String(Math.max(1, Math.min(30, Number(a.amount ?? 5)))), btn]);
      return text('已滚动');
    }
  }
  throw Object.assign(new Error(`未知工具 ${name}`), { code: -32602 });
}

/** 处理一条 JSON-RPC（initialize / tools/list / tools/call / ping） */
export async function rpc(msg: any, call: (name: string, args: any) => Promise<unknown>, tools = TOOLS, info = { name: 'screen', version: '1' }) {
  const { id, method, params } = msg ?? {};
  if (id === undefined) return null;
  try {
    let result: unknown;
    if (method === 'initialize') {
      result = { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: info };
    } else if (method === 'tools/list') result = { tools };
    else if (method === 'tools/call') result = await call(params?.name, params?.arguments ?? {});
    else if (method === 'ping') result = {};
    else return { jsonrpc: '2.0', id, error: { code: -32601, message: `不支持的方法 ${method}` } };
    return { jsonrpc: '2.0', id, result };
  } catch (e: any) {
    return { jsonrpc: '2.0', id, result: text(`出错了：${e.message}`, true) };
  }
}

export { TOOLS as SCREEN_TOOLS };

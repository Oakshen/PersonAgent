// PersonAgent Web 控制台。无框架；所有文本经 textContent 写入，配合严格 CSP。
// 设备私钥在本机生成、不可导出，存在 IndexedDB；服务器只拿到公钥。
// 聊天中途没有任何审批：Agent 直接把事做完。它需要你拿主意时会发一张选择卡。

const $shell = document.getElementById('shell');
const $side = document.getElementById('side');
const $main = document.getElementById('main');
const $dlg = document.getElementById('dlg');

const S = {
  device: null,          // { deviceId, name, keys }
  token: null,
  conn: 'off',
  bots: [],
  seq: 0,
  view: 'home',          // home | chat | memory | about
  bot: null,
  history: [],
  running: new Map(),    // botId → runId
  query: null,           // 搜索词；null 表示没打开搜索
  pins: JSON.parse(localStorage.getItem('pagent.pins') ?? '[]'),
  globals: [],           // 关于我（全局记忆）
  files: [],             // 当前 Bot 的记忆文件
};

const STATUS_TEXT = { working: '工作中…', asking: '在等你回答', failed: '上一轮失败' };

// ---------- 小工具 ----------
const SVGNS = 'http://www.w3.org/2000/svg';
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
function toast(text) {
  const t = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}
function brief(input) {
  const o = input ?? {};
  const v = String(o.command ?? o.file_path ?? o.pattern ?? o.url ?? o.skill ?? o.query ?? JSON.stringify(o));
  return v.length > 200 ? v.slice(0, 200) + '…' : v;
}
const enc = encodeURIComponent;
/** 名单预览用：去掉 Markdown 记号 */
const plain = (t) => t == null ? null : String(t).replace(/```[\s\S]*?```/g, ' ').replace(/[*`#>_]+/g, '').replace(/\s+/g, ' ').trim();
const canAdmin = () => !!S.device?.scopes?.includes('admin');
const icon = {
  search: () => s('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round' },
    s('circle', { cx: 11, cy: 11, r: 7 }), s('path', { d: 'M20 20l-3.5-3.5' })),
  arrow: () => s('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    s('path', { d: 'M12 19V5M5 12l7-7 7 7' })),
  plus: () => s('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round' },
    s('path', { d: 'M12 5v14M5 12h14' })),
};

// ---------- 头像：取名字的第一个字，颜色由名字决定 ----------
const COLORS = ['#2F6B4F', '#3E5C8A', '#8A5A3C', '#6B4E8A', '#2F7D7A', '#9A6B1F', '#A33F3F', '#4D6B2F'];
function hash(str) {
  let x = 2166136261;
  for (const c of str) x = Math.imul(x ^ c.codePointAt(0), 16777619);
  return x >>> 0;
}
const colorOf = (name) => COLORS[hash(name) % COLORS.length];
function seal(name, size = 40, status = 'idle') {
  const el = h('span', { class: 'seal', dataset: { s: status }, 'aria-hidden': 'true' }, ([...name][0] ?? '?').toUpperCase(), h('i', { class: 'dot' }));
  el.style.setProperty('--sz', `${size}px`);
  el.style.setProperty('--c', colorOf(name));
  return el;
}

// ---------- 轻量 Markdown（只生成 DOM 节点，不拼 HTML） ----------
function inline(text) {
  const frag = document.createDocumentFragment();
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    frag.append(text.slice(last, m.index));
    if (m[1]) frag.append(h('code', {}, m[1].slice(1, -1)));
    else if (m[2]) frag.append(h('strong', {}, m[2].slice(2, -2)));
    else frag.append(h('a', { href: m[4], target: '_blank', rel: 'noopener noreferrer' }, m[3].slice(1, m[3].indexOf(']'))));
    last = re.lastIndex;
  }
  frag.append(text.slice(last));
  return frag;
}
function md(text) {
  const frag = document.createDocumentFragment();
  const parts = String(text).split(/```[\w-]*\n?/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) return frag.append(h('pre', {}, h('code', {}, part.replace(/\n$/, ''))));
    let list = null, para = [];
    const flush = () => {
      if (para.length) { const p = h('p'); para.forEach((l, j) => { if (j) p.append(h('br')); p.append(inline(l)); }); frag.append(p); para = []; }
    };
    for (const raw of part.split('\n')) {
      const line = raw.trimEnd();
      const ul = /^\s*[-*•]\s+(.*)$/.exec(line), ol = /^\s*\d+[.)]\s+(.*)$/.exec(line), hd = /^#{1,4}\s+(.*)$/.exec(line);
      if (ul || ol) {
        flush();
        const tag = ul ? 'ul' : 'ol';
        if (!list || list.tagName.toLowerCase() !== tag) { list = h(tag); frag.append(list); }
        list.append(h('li', {}, inline((ul ?? ol)[1])));
      } else if (!line.trim()) { flush(); list = null; }
      else if (hd) { flush(); list = null; frag.append(h('p', {}, h('strong', {}, inline(hd[1])))); }
      else { list = null; para.push(line); }
    }
    flush();
  });
  return frag;
}

function timeLabel(iso) {
  const d = new Date(iso), now = new Date();
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 86400000;
  return diff === 0 ? `今天 ${hm}` : diff === 1 ? `昨天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

// ---------- IndexedDB：保存设备身份 ----------
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('pagent', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const loadDevice = () => idb('readonly', (st) => st.get('device'));
const saveDevice = (d) => idb('readwrite', (st) => st.put(d, 'device'));
const forgetDevice = () => idb('readwrite', (st) => st.delete('device'));

// ---------- 认证 ----------
class Revoked extends Error {}

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  return data;
}

async function login() {
  try {
    const { nonce } = await post('/api/auth/challenge', { deviceId: S.device.deviceId });
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, S.device.keys.privateKey,
      new TextEncoder().encode(`pagent-login:${nonce}`));
    S.token = (await post('/api/auth/login', { deviceId: S.device.deviceId, nonce, signature: b64(sig) })).token;
  } catch (e) {
    if (e.status === 403) throw new Revoked(e.message);
    throw e;
  }
}

/** 带登录态的请求；会话失效时用设备密钥自动重新登录一次 */
async function api(method, path, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(path, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${S.token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && attempt === 0) { await login(); continue; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
    return data;
  }
}

async function pair(code) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const r = await post('/api/pair', { code, publicKey });
  S.device = { deviceId: r.deviceId, name: r.name, scopes: r.scopes, keys };
  await saveDevice(S.device);
}

// ---------- 数据 ----------
let refreshTimer = null;
const refreshSoon = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refreshState().catch(() => {}), 150); };

async function refreshState() {
  const st = await api('GET', '/api/state');
  S.bots = st.bots;
  if (!S.seq) S.seq = st.seq;
  if (S.bot) S.bot = S.bots.find((b) => b.id === S.bot.id) ?? S.bot;
  renderSide();
  if (S.view === 'chat') { renderHead(); renderLog(); renderComposer(); }
  else if (S.view === 'home') renderMain();
}

async function openBot(bot) {
  S.bot = bot;
  S.view = 'chat';
  S.history = [];
  render();
  S.history = await api('GET', `/api/bots/${enc(bot.name)}/history?limit=400`);
  for (const e of S.history) trackRunning(e);
  renderLog(true);
  renderComposer();
  document.querySelector('.composer textarea')?.focus();
}

async function openMemory(bot) {
  S.bot = bot;
  S.view = 'memory';
  S.files = await api('GET', `/api/bots/${enc(bot.name)}/memory`);
  render();
}

async function openAbout() {
  S.view = 'about';
  S.globals = await api('GET', '/api/memory');
  render();
}

function trackRunning(e) {
  if (e.type === 'run.started') S.running.set(e.botId, e.runId);
  if (e.type === 'run.finished' && S.running.get(e.botId) === e.runId) S.running.delete(e.botId);
}

function onEvent(e) {
  if (e.seq <= S.seq) return;
  S.seq = e.seq;
  trackRunning(e);
  if (S.bot && e.botId === S.bot.id && S.view === 'chat') {
    S.history.push(e);
    renderLog();
    if (/^(run\.started|run\.finished|ask\.)/.test(e.type)) renderComposer();
  }
  if (e.type === 'memory.updated') {
    if (S.view === 'about' && e.data.scope === 'global') openAbout().catch(() => {});
    if (S.view === 'memory' && e.data.scope === 'agent' && e.botId === S.bot?.id) openMemory(S.bot).catch(() => {});
  }
  if (/^(run|ask|device|bot|message|assistant|session)\./.test(e.type)) refreshSoon();
}

/** 事件流：用 fetch 读 SSE（token 放请求头而不是 URL）。断线后带游标续传，不重不漏。 */
async function streamLoop() {
  let backoff = 1000;
  for (;;) {
    try {
      const res = await fetch(`/api/events?after=${S.seq}`, { headers: { authorization: `Bearer ${S.token}` } });
      if (res.status === 401) { await login(); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setConn('on');
      backoff = 1000;
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
          buf = buf.slice(i + 2);
          if (line) onEvent(JSON.parse(line.slice(6)));
        }
      }
    } catch (e) {
      if (e instanceof Revoked) return showRevoked(e.message);
    }
    setConn('retry');
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 15000);
    try { await refreshState(); } catch (e) { if (e instanceof Revoked) return showRevoked(e.message); }
  }
}

function setConn(state) {
  S.conn = state;
  const el = document.querySelector('.conn');
  if (el) { el.dataset.state = state; el.textContent = { on: '已连接', retry: '重连中', off: '离线' }[state]; }
}

// ---------- 操作 ----------
async function sendText(text, opts = {}) {
  await api('POST', `/api/bots/${enc(S.bot.name)}/messages`, { text, interrupt: !!opts.interrupt });
}
function togglePin(bot) {
  S.pins = S.pins.includes(bot.id) ? S.pins.filter((x) => x !== bot.id) : [...S.pins, bot.id].slice(-6);
  localStorage.setItem('pagent.pins', JSON.stringify(S.pins));
  renderSide();
}
async function newSession(bot) {
  try {
    await api('POST', `/api/bots/${enc(bot.name)}/session`);
    toast('已开新会话，它的记忆都还在');
  } catch (e) { toast(e.message); }
}

// ---------- 渲染：侧栏 ----------
function render() {
  $shell.dataset.view = S.view === 'home' ? 'side' : 'main';
  renderSide();
  renderMain();
}

function renderSide() {
  if (!S.device) return $side.replaceChildren();
  const q = S.query?.trim().toLowerCase();
  const bots = S.bots.filter((b) => !q || b.name.toLowerCase().includes(q) || (b.persona ?? '').toLowerCase().includes(q));
  const pinned = S.pins.map((id) => bots.find((b) => b.id === id)).filter(Boolean);
  const rest = bots.filter((b) => !S.pins.includes(b.id))
    .sort((a, b) => (b.lastAt ?? b.createdAt ?? '').localeCompare(a.lastAt ?? a.createdAt ?? ''));
  const current = (b) => (S.view === 'chat' || S.view === 'memory') && S.bot?.id === b.id;
  const row = (b) => {
    const st = STATUS_TEXT[b.status];
    return h('button', { class: 'row', 'aria-current': current(b) ? 'true' : null, onclick: () => openBot(b) },
      seal(b.name, 38, b.status),
      h('span', { class: 'txt' },
        h('div', { class: 'name' }, b.name),
        h('div', { class: `prev ${b.status === 'asking' ? 'ask' : ''}` }, st ?? plain(b.lastText) ?? b.persona ?? '还没有对话')));
  };

  const top = h('div', { class: 'side-top' },
    h('div', { class: 'wordmark' }, 'PersonAgent', h('small', {}, `${S.bots.length} 个 BOT`)),
    h('button', { class: 'round', title: '搜索', 'aria-label': '搜索', onclick: () => { S.query = S.query === null ? '' : null; renderSide(); document.querySelector('.search input')?.focus(); } }, icon.search()),
    canAdmin() ? h('button', { class: 'round', title: '新建 Bot', 'aria-label': '新建 Bot', onclick: () => editBotDialog() }, icon.plus()) : null);

  const scroll = h('div', { class: 'side-scroll' });
  if (S.query !== null) {
    scroll.append(h('div', { class: 'search' }, h('input', {
      type: 'search', placeholder: '搜索名字或人设', value: S.query, 'aria-label': '搜索 Bot',
      oninput: (e) => { S.query = e.target.value; renderSide(); const i = document.querySelector('.search input'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); },
    })));
  }
  if (pinned.length) scroll.append(h('div', { class: 'group' }, '置顶'), ...pinned.map(row));
  if (rest.length) scroll.append(h('div', { class: 'group' }, pinned.length ? '其他' : '全部'), ...rest.map(row));
  if (!S.bots.length) {
    scroll.append(h('p', { class: 'side-empty' }, canAdmin() ? '还没有 Bot。点右上角的 + 新建一个。' : '还没有 Bot。在服务器上运行 pagent bot create <名字> 新建一个。'));
  }

  const bottom = h('div', { class: 'side-bottom' },
    h('div', { class: 'me' }, S.device.name ?? '这台设备',
      h('small', { class: 'conn', dataset: { state: S.conn } }, { on: '已连接', retry: '重连中', off: '离线' }[S.conn])),
    h('button', { class: 'about-btn', 'aria-current': S.view === 'about' ? 'true' : null, onclick: () => openAbout().catch((e) => toast(e.message)) }, '关于我'));

  $side.replaceChildren(top, scroll, bottom);
}

// ---------- 渲染：主区 ----------
function renderMain() {
  if (!S.device) return;
  if (S.view === 'about') return renderAbout();
  if (S.view === 'memory') return renderMemory();
  if (S.view !== 'chat' || !S.bot) {
    return $main.replaceChildren(h('div', { class: 'welcome' },
      h('h2', {}, '选一个 Bot 开始'),
      h('p', {}, '每个 Bot 有自己的会话和记忆，交代的事它会直接做完。需要你拿主意时，它会发一张选择卡。')));
  }
  $main.replaceChildren(h('header', { class: 'chat-head', id: 'head' }), h('div', { class: 'log', id: 'log', 'aria-live': 'polite' }), h('div', { id: 'composer-slot' }));
  renderHead();
  renderLog(true);
  renderComposer();
}

function renderHead() {
  const head = document.getElementById('head');
  if (!head || !S.bot) return;
  const b = S.bot;
  head.replaceChildren(
    h('button', { class: 'back-btn', 'aria-label': '返回', onclick: () => { S.view = 'home'; render(); } }, '‹'),
    seal(b.name, 36, b.status),
    h('div', { class: 'who' }, h('b', {}, b.name), h('small', {}, STATUS_TEXT[b.status] ?? (b.persona || '没有设定人设'))),
    h('button', { class: 'head-btn', onclick: () => openMemory(b).catch((e) => toast(e.message)) }, '它记得什么'),
    h('button', { class: 'head-btn', onclick: () => botMenu(b) }, '设置'));
}

function renderLog(toEnd = false) {
  const log = document.getElementById('log');
  if (!log || !S.bot) return;
  const atEnd = toEnd || log.scrollHeight - log.scrollTop - log.clientHeight < 100;
  // 选择卡只有最近一张、且之后没有你的消息和新会话时才能点
  const answered = new Map();
  let openAsk = null;
  for (const e of S.history) {
    if (e.type === 'ask.created') openAsk = e.data.askId;
    if (e.type === 'ask.answered') answered.set(e.data.askId, e.data.answer);
    if (e.type === 'message.queued' || e.type === 'session.new') openAsk = null;
  }
  const nodes = [];
  let lastTs = 0;
  for (const e of S.history) {
    const node = renderEvent(e, { answered, openAsk });
    if (!node) continue;
    const t = Date.parse(e.ts);
    if (t - lastTs > 10 * 60_000 && e.type !== 'session.new') nodes.push(h('div', { class: 'time' }, timeLabel(e.ts)));
    lastTs = t;
    nodes.push(node);
  }
  if (S.running.get(S.bot.id)) nodes.push(h('div', { class: 'end' }, `${S.bot.name} 正在处理…`));
  log.style.setProperty('--c', colorOf(S.bot.name));
  if (!nodes.length) {
    nodes.push(h('div', { class: 'welcome' }, seal(S.bot.name, 72), h('h2', {}, S.bot.name),
      h('p', {}, S.bot.persona || '还没有设定人设。'), h('p', {}, '给它发第一条消息吧。')));
  }
  log.replaceChildren(...nodes);
  if (atEnd) log.scrollTop = log.scrollHeight;
}

function memoryLine(d) {
  if (d.scope === 'global') {
    const verb = { add: '记下了关于你的一条', update: '改写了关于你的一条', delete: '删掉了关于你的一条' }[d.op] ?? '改了关于你的记忆';
    return h('div', { class: 'memline global' }, h('span', { class: 'stamp' }), `${d.by} ${verb}：`, h('q', {}, d.text ?? d.before ?? ''));
  }
  const added = d.added ?? [];
  return h('div', { class: 'memline' }, h('span', { class: 'stamp' }),
    `${d.by} ${d.op === 'delete' ? '删掉了' : '更新了'}自己的记忆 `, h('code', {}, d.file),
    added.length ? h('q', {}, added[0].replace(/^[-*]\s*/, '')) : null);
}

function renderEvent(e, ctx) {
  const d = e.data;
  switch (e.type) {
    case 'message.queued': return h('div', { class: 'mine' }, d.text);
    case 'assistant.text': return h('div', { class: 'say' }, md(d.text));
    case 'tool.use':
      if (d.name === 'mcp__pagent__ask_user' || d.name === 'mcp__pagent__remember' || d.name === 'ToolSearch') return null;
      return h('div', { class: 'step', title: d.summary ?? brief(d.input) }, `${d.name.replace(/^mcp__[^_]+__/, '')}  ${d.summary ?? brief(d.input)}`);
    case 'tool.result': return d.isError ? h('div', { class: 'step bad' }, String(d.preview).slice(0, 300)) : null;
    case 'memory.updated': return memoryLine(d);
    case 'ask.created': return askCard(d, ctx.answered.get(d.askId), ctx.openAsk === d.askId);
    case 'session.new': return h('div', { class: 'divider' }, h('span', {}, '新会话'), h('small', {}, d.reason ? `${d.reason} · 记忆保留` : '上下文清空，记忆保留'));
    case 'session.compacted': return h('div', { class: 'step note' }, '对话太长，已自动压缩；记忆不受影响');
    case 'run.finished': {
      const nodes = [];
      if (d.status !== 'succeeded') {
        const label = { failed: '这一轮失败了', interrupted: '已停止' }[d.status] ?? d.status;
        nodes.push(h('div', { class: 'end bad' }, [label, d.error].filter(Boolean).join('：').slice(0, 200)));
      }
      if (d.unconfirmed?.length) {
        nodes.push(h('div', { class: 'step note' }, `有 ${d.unconfirmed.length} 个操作没等到结果（${d.unconfirmed.map((a) => a.tool).join('、')}），下一轮它会自己核实`));
      }
      return nodes.length ? h('div', { class: 'stack' }, ...nodes) : null;
    }
    case 'plugin.needs_consent': return h('div', { class: 'step note' }, `插件 ${d.plugins.join('、')} 的权限变了，需要在服务器上重新启用`);
    default: return null;
  }
}

/** 选择卡：问题 + 选项；点一个就是回答，它接着做 */
function askCard(d, answer, open) {
  const options = h('div', { class: 'options' });
  const choose = async (text, btn) => {
    for (const b of options.querySelectorAll('button')) b.disabled = true;
    btn?.classList.add('picked');
    try { await sendText(text); } catch (e) { toast(e.message); for (const b of options.querySelectorAll('button')) b.disabled = false; }
  };
  d.options.forEach((o, i) => {
    const btn = h('button', { class: `opt ${answer === o ? 'picked' : ''}`, disabled: !open },
      h('span', { class: 'n' }, String(i + 1)), h('span', {}, o));
    btn.addEventListener('click', () => choose(o, btn));
    options.append(btn);
  });
  if (open && d.allowCustom) {
    const input = h('input', { placeholder: '都不合适？自己写', 'aria-label': '自己写回答' });
    const go = h('button', { class: 'btn', type: 'submit' }, '回答');
    const form = h('form', { class: 'custom' }, input, go);
    form.addEventListener('submit', (ev) => { ev.preventDefault(); if (input.value.trim()) choose(input.value.trim()); });
    options.append(form);
  }
  const custom = answer && !d.options.includes(answer);
  return h('article', { class: `ticket ask ${open ? 'open' : ''}` },
    h('div', { class: 'top' },
      h('div', { class: 'label' }, open ? '等你回答' : answer ? '已回答' : '已作废'),
      h('div', { class: 'q' }, d.question)),
    options,
    custom ? h('div', { class: 'answer' }, `你的回答：${answer}`) : null);
}

function renderComposer() {
  const slot = document.getElementById('composer-slot');
  if (!slot || !S.bot) return;
  const running = S.running.get(S.bot.id);
  const input = h('textarea', { rows: 1, placeholder: running ? `${S.bot.name} 正在工作，发消息会先打断它` : `给 ${S.bot.name} 发消息`, 'aria-label': '消息' });
  const sendBtn = running
    ? h('button', { class: 'send', disabled: true }, '打断并发送')
    : h('button', { class: 'send icon', disabled: true, 'aria-label': '发送', title: '发送' }, icon.arrow());
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendBtn.disabled = true;
    try { await sendText(text, { interrupt: !!S.running.get(S.bot.id) }); } catch (e) { toast(e.message); input.value = text; }
  };
  input.addEventListener('input', () => {
    sendBtn.disabled = !input.value.trim();
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  sendBtn.addEventListener('click', send);
  const stopBtn = running ? h('button', { class: 'send stop', onclick: async () => {
    try { await api('POST', `/api/runs/${running}/interrupt`); toast('已停止'); } catch (e) { toast(e.message); }
  } }, '停止') : null;
  const old = slot.querySelector('textarea');
  if (old) { input.value = old.value; sendBtn.disabled = !input.value.trim(); }
  slot.replaceChildren(h('div', { class: 'composer' }, input, stopBtn, sendBtn));
  if (old === document.activeElement) input.focus();
}

// ---------- 它记得什么（Agent 自己的记忆文件） ----------
function renderMemory() {
  const b = S.bot;
  const head = h('header', { class: 'chat-head' },
    h('button', { class: 'back-btn show', 'aria-label': '返回对话', onclick: () => openBot(b) }, '‹'),
    seal(b.name, 36, b.status),
    h('div', { class: 'who' }, h('b', {}, `${b.name} 记得什么`), h('small', {}, '它自己的工作记忆：负责的事、做过的决定、工作方法')),
    h('button', { class: 'head-btn', onclick: () => openBot(b) }, '回到对话'));
  const page = h('section', { class: 'page' });
  page.append(h('p', { class: 'hint' }, '它在对话中学到的东西会当场写在这里。你改动后，下一轮对话生效。关于你本人的事记在「关于我」里，所有 Bot 共享。'));
  const index = S.files.find((f) => f.file === 'MEMORY.md');
  const files = index ? [index, ...S.files.filter((f) => f !== index)] : S.files;
  if (!files.length) page.append(h('div', { class: 'empty' }, `${b.name} 还没有写下任何记忆。和它多聊几次，或者在对话里直接说"记住……"。`));
  for (const f of files) page.append(memFile(b, f));
  if (canAdmin()) {
    page.append(h('button', { class: 'btn add-file', onclick: () => {
      const name = prompt('新文件名（以 .md 结尾）', '笔记.md');
      if (name) saveFile(b, name, '');
    } }, '新建记忆文件'));
  }
  $main.replaceChildren(head, page);
}

function memFile(b, f) {
  const lines = f.content.split('\n').filter((l) => l.trim()).length;
  const body = canAdmin()
    ? h('textarea', { class: 'mem-text', spellcheck: 'false', 'aria-label': f.file }, f.content)
    : h('pre', { class: 'mem-text' }, f.content);
  const actions = canAdmin() ? h('div', { class: 'file-btns' },
    h('button', { class: 'btn', onclick: () => confirm(`删除 ${f.file}？`) && saveFile(b, f.file, null) }, '删除'),
    h('button', { class: 'btn go', onclick: () => saveFile(b, f.file, body.value) }, '保存')) : null;
  return h('article', { class: 'memfile' },
    h('div', { class: 'file-head' }, h('code', {}, f.file), h('small', {}, f.file === 'MEMORY.md' ? `索引 · ${lines} 行` : `${lines} 行`)),
    body, actions);
}

async function saveFile(b, file, content) {
  try {
    if (content === null) await api('DELETE', `/api/bots/${enc(b.name)}/memory/${enc(file)}`);
    else await api('PUT', `/api/bots/${enc(b.name)}/memory/${enc(file)}`, { content });
    toast(content === null ? '已删除' : '已保存，下一轮生效');
    await openMemory(b);
  } catch (e) { toast(e.message); }
}

// ---------- 关于我（全局记忆） ----------
function renderAbout() {
  const head = h('header', { class: 'chat-head' },
    h('button', { class: 'back-btn', 'aria-label': '返回', onclick: () => { S.view = 'home'; render(); } }, '‹'),
    h('div', { class: 'who' }, h('b', {}, '关于我'), h('small', {}, `所有 Bot 都知道的事 · ${S.globals.length} 条`)));
  const page = h('section', { class: 'page' });
  page.append(h('p', { class: 'hint' }, 'Bot 在对话里了解到关于你的事，会记在这里，所有 Bot 共享，下一轮对话就能用上。你也可以自己补充或删掉。'));
  if (canAdmin()) {
    const input = h('input', { placeholder: '比如：我习惯早上 7 点起床', maxlength: 500, 'aria-label': '新的一条' });
    const form = h('form', { class: 'fact-add' }, input, h('button', { class: 'btn go', type: 'submit' }, '记下'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      try { await api('POST', '/api/memory', { text: input.value }); input.value = ''; await openAbout(); } catch (ex) { toast(ex.message); }
    });
    page.append(form);
  }
  if (!S.globals.length) page.append(h('div', { class: 'empty' }, '还没有。和任何一个 Bot 聊聊你自己，它会记下来。'));
  const list = h('ol', { class: 'facts' });
  for (const m of [...S.globals].reverse()) {
    list.append(h('li', { class: 'fact' },
      h('div', { class: 'fact-text' }, m.text),
      h('div', { class: 'fact-meta' },
        m.sourceBot ? seal(m.sourceBot, 18) : null,
        `${m.sourceBot ? `${m.sourceBot} 记下` : '你自己加的'} · ${timeLabel(m.updatedAt)}`,
        canAdmin() ? h('button', { class: 'link', onclick: async () => {
          if (!confirm('删掉这一条？')) return;
          try { await api('DELETE', `/api/memory/${m.id}`); await openAbout(); } catch (e) { toast(e.message); }
        } }, '删除') : null)));
  }
  page.append(list);
  $main.replaceChildren(head, page);
}

// ---------- 弹窗 ----------
function editBotDialog(bot) {
  const name = h('input', { required: true, maxlength: 31, placeholder: '比如 股票研究', value: bot?.name ?? '', disabled: !!bot });
  const persona = h('textarea', { placeholder: '它是谁、负责什么、说话风格，以及你的红线。比如：你负责每天早上整理美股盘前要闻，结论先行，不超过 5 条；花钱之前先问我。' }, bot?.persona ?? '');
  const model = h('select', {},
    h('option', { value: '' }, '跟随账号默认'), h('option', { value: 'opus' }, 'Opus（最强）'),
    h('option', { value: 'sonnet' }, 'Sonnet（均衡）'), h('option', { value: 'haiku' }, 'Haiku（最快）'));
  model.value = bot?.model ?? '';
  const preview = h('div', { class: 'preview' });
  const drawPreview = () => preview.replaceChildren(seal(name.value.trim() || '?', 44), name.value.trim() ? '它的印章' : '填了名字后生成印章');
  name.addEventListener('input', drawPreview);
  drawPreview();
  const err = h('p', { class: 'error', role: 'alert' });
  const form = h('form', { class: 'form', method: 'dialog' },
    h('h2', {}, bot ? `编辑 ${bot.name}` : '新建 Bot'),
    bot ? null : preview,
    h('label', {}, '名字', h('small', {}, '不能有空格，创建后不能改'), name),
    h('label', {}, '人设', bot ? h('small', {}, '保存后下一轮生效') : null, persona),
    h('label', {}, '模型', model),
    err,
    h('div', { class: 'row-btns' },
      h('button', { type: 'button', class: 'btn', onclick: () => $dlg.close() }, '取消'),
      h('button', { type: 'submit', class: 'btn go' }, bot ? '保存' : '创建')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      if (bot) {
        await api('PATCH', `/api/bots/${enc(bot.name)}`, { persona: persona.value, model: model.value });
        $dlg.close();
        toast('已保存，下一轮生效');
        await refreshState();
      } else {
        const r = await api('POST', '/api/bots', { name: name.value.trim(), persona: persona.value, model: model.value });
        $dlg.close();
        await refreshState();
        const created = S.bots.find((x) => x.id === r.id);
        if (created) openBot(created);
      }
    } catch (ex) { err.textContent = ex.message; }
  });
  $dlg.replaceChildren(form);
  $dlg.showModal();
  (bot ? persona : name).focus();
}

function botMenu(bot) {
  const pinned = S.pins.includes(bot.id);
  const item = (label, fn, cls = 'btn') => h('button', { type: 'button', class: cls, onclick: () => { $dlg.close(); fn(); } }, label);
  $dlg.replaceChildren(h('div', { class: 'form' },
    h('div', { class: 'preview' }, seal(bot.name, 44, 'idle'), h('div', {}, h('strong', {}, bot.name), h('br'), bot.model ?? '跟随账号默认模型')),
    bot.persona ? h('p', {}, bot.persona) : null,
    h('div', { class: 'menu-item' },
      h('div', {}, h('strong', {}, '开新会话'), h('p', {}, '清空对话上下文，人设和记忆都保留。对话太长、或者要换个话题时用。')),
      item('开新会话', () => newSession(bot))),
    h('div', { class: 'row-btns' },
      item(pinned ? '取消置顶' : '置顶', () => togglePin(bot)),
      canAdmin() ? item('编辑人设', () => editBotDialog(bot)) : null,
      h('button', { type: 'button', class: 'btn go', onclick: () => $dlg.close() }, '关闭'))));
  $dlg.showModal();
}

// ---------- 配对 ----------
function renderPair(message) {
  $shell.dataset.view = 'main';
  $side.replaceChildren();
  const fromLink = new URLSearchParams(location.hash.slice(1)).get('pair') ?? '';
  const input = h('input', { inputmode: 'text', autocomplete: 'one-time-code', maxlength: 11, placeholder: 'XXXXX-XXXXX', value: fromLink, 'aria-label': '配对码' });
  const err = h('p', { class: 'error', role: 'alert' }, message ?? '');
  const form = h('form', { class: 'pair' },
    seal('P', 64),
    h('h2', {}, '连接这台设备'),
    h('p', {}, '在服务器上运行 pagent device pair <设备名>，把配对码填在这里。配对码 5 分钟内有效，只能用一次。'),
    input, err, h('button', { type: 'submit', class: 'btn go' }, '连接'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      await pair(input.value);
      history.replaceState(null, '', location.pathname);
      await start();
    } catch (ex) { err.textContent = ex.message; }
  });
  $main.replaceChildren(form);
  input.focus();
}

async function showRevoked(msg) {
  await forgetDevice();
  S.device = null;
  S.token = null;
  setConn('off');
  renderPair(`这台设备已失效（${msg}），需要重新配对。`);
}

// ---------- 启动 ----------
async function start() {
  if (!crypto.subtle) {
    $main.replaceChildren(h('div', { class: 'welcome' }, h('h2', {}, '需要安全连接'),
      h('p', {}, '请通过 HTTPS（或 localhost）打开这个页面，浏览器才允许生成设备密钥。')));
    return;
  }
  S.device = await loadDevice();
  if (!S.device) return renderPair();
  try {
    await login();
    const me = await api('GET', '/api/me');
    S.device.scopes = me.scopes;
    S.device.name = me.name;
    render();
    await refreshState();
  } catch (e) {
    if (e instanceof Revoked) return showRevoked(e.message);
    setConn('off');
    toast(e.message);
  }
  streamLoop();
}
start();

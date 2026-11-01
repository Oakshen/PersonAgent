// PersonAgent Web 控制台（参照 Grok Bot Mac 客户端）。无框架；所有文本经 textContent 写入，配合严格 CSP。
// 设备私钥在本机生成、不可导出，存在 IndexedDB；服务器只拿到公钥。

const $shell = document.getElementById('shell');
const $side = document.getElementById('side');
const $main = document.getElementById('main');
const $dlg = document.getElementById('dlg');

const S = {
  device: null,          // { deviceId, name, keys }
  token: null,
  conn: 'off',
  bots: [], approvals: [], unknown: [],
  seq: 0,
  view: 'home',          // home | chat | inbox
  bot: null,
  history: [],
  running: new Map(),    // botId → runId
  query: null,           // 搜索词；null 表示没打开搜索
  pins: JSON.parse(localStorage.getItem('pagent.pins') ?? '[]'),
};

const STATUS_TEXT = { working: '工作中…', waiting: '等你批准', attention: '有操作需要核对', failed: '上一轮失败' };

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
const narrow = () => matchMedia('(max-width: 760px)').matches;
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
const icon = {
  search: () => s('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round' },
    s('circle', { cx: 11, cy: 11, r: 7 }), s('path', { d: 'M20 20l-3.5-3.5' })),
  plus: () => s('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round' },
    s('path', { d: 'M12 5v14M5 12h14' })),
  inbox: () => s('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linejoin': 'round' },
    s('path', { d: 'M4 13l2.5-7h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z' }), s('path', { d: 'M4 13h5l1 2h4l1-2h5' })),
};

// ---------- 头像：方印。取名字的第一个字，颜色由名字决定 ----------
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
  S.approvals = st.approvals;
  S.unknown = st.unknownActions;
  if (!S.seq) S.seq = st.seq;
  if (S.bot) S.bot = S.bots.find((b) => b.id === S.bot.id) ?? S.bot;
  renderSide();
  if (S.view === 'inbox') renderMain();
  else if (S.view === 'chat') { renderLog(); renderComposer(); }
  else renderMain();
}

async function openBot(bot) {
  S.bot = bot;
  S.view = 'chat';
  S.history = [];
  render();
  S.history = await api('GET', `/api/bots/${encodeURIComponent(bot.name)}/history?limit=400`);
  for (const e of S.history) trackRunning(e);
  renderLog(true);
  renderComposer();
  document.querySelector('.composer textarea')?.focus();
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
    if (e.type === 'run.started' || e.type === 'run.finished') renderComposer();
  }
  if (/^(run|approval|action|device|bot|message|assistant)\./.test(e.type)) refreshSoon();
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
async function decide(id, decision) {
  try { await api('POST', `/api/approvals/${id}`, { decision }); toast(decision === 'approve' ? '已批准' : '已拒绝'); }
  catch (e) { toast(e.message); }
  refreshSoon();
}
async function reconcile(id, outcome) {
  try { await api('POST', `/api/actions/${id}/resolve`, { outcome }); toast('已核对'); }
  catch (e) { toast(e.message); }
  refreshSoon();
}
function togglePin(bot) {
  S.pins = S.pins.includes(bot.id) ? S.pins.filter((x) => x !== bot.id) : [...S.pins, bot.id].slice(-6);
  localStorage.setItem('pagent.pins', JSON.stringify(S.pins));
  renderSide();
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
  const canAdmin = S.device.scopes?.includes('admin');
  const row = (b) => {
    const st = STATUS_TEXT[b.status];
    return h('button', { class: 'row', 'aria-current': S.view === 'chat' && S.bot?.id === b.id ? 'true' : null, onclick: () => openBot(b) },
      seal(b.name, 38, b.status),
      h('span', { class: 'txt' },
        h('div', { class: 'name' }, b.name),
        h('div', { class: `prev ${b.status === 'waiting' ? 'wait' : b.status === 'attention' ? 'attention' : ''}` },
          st ?? b.lastText ?? b.persona ?? '还没有对话')));
  };

  const top = h('div', { class: 'side-top' },
    h('div', { class: 'wordmark' }, 'PersonAgent', h('small', {}, `${S.bots.length} 个 BOT`)),
    h('button', { class: 'round', title: '搜索', 'aria-label': '搜索', onclick: () => { S.query = S.query === null ? '' : null; renderSide(); document.querySelector('.search input')?.focus(); } }, icon.search()),
    canAdmin ? h('button', { class: 'round', title: '新建 Bot', 'aria-label': '新建 Bot', onclick: () => editBotDialog() }, icon.plus()) : null);

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
    scroll.append(h('p', { class: 'side-empty' }, canAdmin ? '还没有 Bot。点右上角的 + 新建一个。' : '还没有 Bot。在服务器上运行 pagent bot create <名字> 新建一个。'));
  }

  const pending = S.approvals.length + S.unknown.length;
  const bottom = h('div', { class: 'side-bottom' },
    h('div', { class: 'me' }, S.device.name ?? '这台设备',
      h('small', { class: 'conn', dataset: { state: S.conn } }, { on: '已连接', retry: '重连中', off: '离线' }[S.conn])),
    h('button', { class: 'inbox-btn', onclick: () => { S.view = 'inbox'; render(); } }, '待处理', pending ? h('b', {}, pending) : null));

  $side.replaceChildren(top, scroll, bottom);
}

// ---------- 渲染：主区 ----------
function renderMain() {
  if (!S.device) return;
  if (S.view === 'inbox') return renderInbox();
  if (S.view !== 'chat' || !S.bot) {
    return $main.replaceChildren(h('div', { class: 'welcome' },
      h('h2', {}, '选一个 Bot 开始'),
      h('p', {}, '每个 Bot 有自己的上下文和记忆。它要执行有风险的操作时，会先来问你。')));
  }
  const b = S.bot;
  const head = h('header', { class: 'chat-head' },
    h('button', { class: 'back-btn', 'aria-label': '返回', onclick: () => { S.view = 'home'; render(); } }, '‹'),
    seal(b.name, 36, b.status),
    h('div', { class: 'who' }, h('b', {}, b.name), h('small', {}, b.persona || '没有设定人设')),
    h('button', { class: 'head-btn', onclick: () => botMenu(b) }, '设置'));
  $main.replaceChildren(head, h('div', { class: 'log', id: 'log', 'aria-live': 'polite' }), h('div', { id: 'composer-slot' }));
  renderLog(true);
  renderComposer();
}

function renderLog(toEnd = false) {
  const log = document.getElementById('log');
  if (!log || !S.bot) return;
  const atEnd = toEnd || log.scrollHeight - log.scrollTop - log.clientHeight < 100;
  const resolved = new Map();
  for (const e of S.history) if (e.type === 'approval.resolved') resolved.set(e.data.approvalId, e.data.status);
  const nodes = [];
  let lastTs = 0;
  for (const e of S.history) {
    const node = renderEvent(e, resolved);
    if (!node) continue;
    const t = Date.parse(e.ts);
    if (t - lastTs > 10 * 60_000) nodes.push(h('div', { class: 'time' }, timeLabel(e.ts)));
    lastTs = t;
    nodes.push(node);
  }
  if (S.running.get(S.bot.id) && S.history.at(-1)?.type !== 'approval.requested') nodes.push(h('div', { class: 'end' }, `${S.bot.name} 正在处理…`));
  log.style.setProperty('--c', colorOf(S.bot.name));
  if (!nodes.length) {
    nodes.push(h('div', { class: 'welcome' }, seal(S.bot.name, 72), h('h2', {}, S.bot.name),
      h('p', {}, S.bot.persona || '还没有设定人设。'), h('p', {}, '给它发第一条消息吧。')));
  }
  log.replaceChildren(...nodes);
  if (atEnd) log.scrollTop = log.scrollHeight;
}

function renderEvent(e, resolved) {
  const d = e.data;
  switch (e.type) {
    case 'message.queued': return h('div', { class: 'mine' }, d.text);
    case 'assistant.text': return h('div', { class: 'say' }, md(d.text));
    case 'tool.use': return h('div', { class: 'step', title: brief(d.input) }, `${d.name}  ${brief(d.input)}`);
    case 'tool.result': return d.isError ? h('div', { class: 'step bad' }, String(d.preview).slice(0, 300)) : null;
    case 'action.decided': return d.decision === 'deny' && !/用户拒绝|审批/.test(d.reason) ? h('div', { class: 'step bad' }, `已拦下：${d.reason}`) : null;
    case 'action.reconciled': return h('div', { class: 'step note' }, `已核对：${d.outcome === 'happened' ? '确实发生了' : '没有发生'}`);
    case 'approval.requested': return approvalCard({ id: d.approvalId, summary: d.summary, expires_at: d.expiresAt, created: e.ts }, resolved.get(d.approvalId));
    case 'run.finished': {
      if (d.status === 'succeeded') return null;
      const label = { failed: '这一轮失败了', interrupted: '已停止', unknown: '这一轮被打断，有操作需要你核对' }[d.status] ?? d.status;
      return h('div', { class: 'end bad' }, [label, d.error].filter(Boolean).join('：').slice(0, 200));
    }
    case 'plugin.needs_consent': return h('div', { class: 'step note' }, `插件 ${d.plugins.join('、')} 的权限变了，需要在服务器上重新启用`);
    default: return null;
  }
}

/** 审批工单：上联是要执行的命令，撕口线上是倒计时，下联是决定 */
function approvalCard(a, status, botName) {
  const pending = !status && S.approvals.some((p) => p.id === a.id);
  const [tool, ...rest] = a.summary.split(': ');
  const tear = h('div', { class: 'tear' });
  const bottom = h('div', { class: 'bottom' });
  if (pending) {
    const mins = Math.max(1, Math.round((Date.parse(a.expires_at) - Date.now()) / 60000));
    tear.append(h('i', { class: 'fuse', dataset: { start: Date.parse(a.created ?? a.created_at), end: Date.parse(a.expires_at) } }));
    bottom.append(
      h('span', { class: 'left' }, `${mins} 分钟内不处理就自动拒绝`),
      h('button', { class: 'btn', onclick: () => decide(a.id, 'deny') }, '拒绝'),
      h('button', { class: 'btn go', onclick: () => decide(a.id, 'approve') }, '放行'));
  } else {
    const [text, cls] = {
      approved: ['已放行', 'ok'], denied: ['已拒绝', 'bad'], expired: ['超时未处理，已自动拒绝', 'bad'], cancelled: ['这一轮已结束，工单作废', 'bad'],
    }[status] ?? ['已处理', ''];
    bottom.append(h('span', { class: `state ${cls}` }, text));
  }
  return h('article', { class: 'ticket' },
    h('div', { class: 'top' },
      h('div', { class: 'label' }, pending ? '等你批准' : '审批'),
      h('div', { class: 'q' }, botName ? `${botName} 想执行 ` : '想执行 ', h('b', {}, tool)),
      h('pre', {}, rest.join(': ') || a.summary)),
    tear, bottom);
}

function renderComposer() {
  const slot = document.getElementById('composer-slot');
  if (!slot || !S.bot) return;
  const running = S.running.get(S.bot.id);
  const input = h('textarea', { rows: 1, placeholder: running ? `${S.bot.name} 正在工作，发消息会先打断它` : `给 ${S.bot.name} 发消息`, 'aria-label': '消息' });
  const sendBtn = h('button', { class: 'send', disabled: true }, running ? '打断并发送' : '发送');
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendBtn.disabled = true;
    try {
      await api('POST', `/api/bots/${encodeURIComponent(S.bot.name)}/messages`, { text, interrupt: !!S.running.get(S.bot.id) });
    } catch (e) { toast(e.message); input.value = text; }
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

function renderInbox() {
  const box = h('section', { class: 'inbox' });
  const botName = (id) => S.bots.find((b) => b.id === id)?.name ?? id;
  const head = h('header', { class: 'chat-head' },
    h('button', { class: 'back-btn', 'aria-label': '返回', onclick: () => { S.view = 'home'; render(); } }, '‹'),
    h('div', { class: 'who' }, h('b', {}, '待处理'), h('small', {}, '需要你批准或核对的事')));
  if (S.approvals.length) {
    box.append(h('h3', {}, `等你批准 · ${S.approvals.length}`));
    for (const a of S.approvals) box.append(approvalCard(a, null, botName(a.bot_id)));
  }
  if (S.unknown.length) {
    box.append(h('h3', {}, `需要核对 · ${S.unknown.length}`));
    for (const a of S.unknown) {
      let input = {};
      try { input = JSON.parse(a.input); } catch {}
      box.append(h('article', { class: 'ticket check' },
        h('div', { class: 'top' },
          h('div', { class: 'label' }, '需要核对'),
          h('div', { class: 'q' }, `${botName(a.bot_id)} 执行 `, h('b', {}, a.tool), ' 时被打断了，它可能已经生效。实际发生了吗？'),
          h('pre', {}, brief(input))),
        h('div', { class: 'tear' }),
        h('div', { class: 'bottom' },
          h('span', { class: 'left' }, a.id),
          h('button', { class: 'btn', onclick: () => reconcile(a.id, 'not_happened') }, '没有发生'),
          h('button', { class: 'btn go', onclick: () => reconcile(a.id, 'happened') }, '已经发生'))));
    }
  }
  if (!S.approvals.length && !S.unknown.length) box.append(h('div', { class: 'welcome' }, h('h2', {}, '都处理完了'), h('p', {}, '有 Bot 需要你批准或核对时，会出现在这里。')));
  $main.replaceChildren(head, box);
}

// ---------- 弹窗 ----------
function editBotDialog(bot) {
  const name = h('input', { required: true, maxlength: 31, placeholder: '比如 股票研究', value: bot?.name ?? '', disabled: !!bot });
  const persona = h('textarea', { placeholder: '它是谁、负责什么、说话风格。比如：你负责每天早上整理美股盘前要闻，结论先行，不超过 5 条。' }, bot?.persona ?? '');
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
    h('label', {}, '人设', persona),
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
        await api('PATCH', `/api/bots/${encodeURIComponent(bot.name)}`, { persona: persona.value, model: model.value });
        $dlg.close();
        toast('已保存');
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
  const canAdmin = S.device.scopes?.includes('admin');
  const item = (label, fn) => h('button', { type: 'button', class: 'btn', onclick: () => { $dlg.close(); fn(); } }, label);
  $dlg.replaceChildren(h('div', { class: 'form' },
    h('div', { class: 'preview' }, seal(bot.name, 44, 'idle'), h('div', {}, h('strong', {}, bot.name), h('br'), bot.model ?? '跟随账号默认模型')),
    bot.persona ? h('p', {}, bot.persona) : null,
    h('div', { class: 'row-btns' },
      item(pinned ? '取消置顶' : '置顶', () => togglePin(bot)),
      canAdmin ? item('编辑人设', () => editBotDialog(bot)) : null,
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

// 审批卡底部的倒计时线：按真实剩余时间缩短
setInterval(() => {
  for (const i of document.querySelectorAll('.fuse')) {
    const start = Number(i.dataset.start), end = Number(i.dataset.end);
    i.style.transform = `scaleX(${Math.max(0, Math.min(1, (end - Date.now()) / (end - start)))})`;
  }
}, 1000);

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

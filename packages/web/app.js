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
  view: 'home',          // home | chat | memory | about | settings | routines | group
  bot: null,
  history: [],
  running: new Map(),    // botId → runId
  query: null,           // 搜索词；null 表示没打开搜索
  pins: JSON.parse(localStorage.getItem('pagent.pins') ?? '[]'),
  globals: [],           // 关于我（全局记忆）
  files: [],             // 当前 Bot 的记忆文件
  settings: null,        // 设置页数据 { engines, settings }
  routines: [],          // 当前 Bot 的 Routine
  groups: [],            // 群聊
  group: null,           // 正在看的群 { id, name, members, manager, events, runs: Set, msgIds: Set }
  screen: null,          // 正在看的屏幕 { botId, mode: 'preview' | 'takeover', rfb }
};

const STATUS_TEXT = { working: '工作中…', computer: '正在用电脑', asking: '在等你回答', waiting: '在等成员回复', failed: '上一轮失败' };
const statusText = (b) => (b.status === 'waiting' && b.waitingOn?.length ? `在等 ${b.waitingOn.join('、')} 回复` : STATUS_TEXT[b.status]);

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
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
/** 一行表格拆成单元格：去掉首尾的 |，\| 是转义的竖线 */
const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
function md(text) {
  const frag = document.createDocumentFragment();
  const parts = String(text).split(/```[\w-]*\n?/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) return frag.append(h('pre', {}, h('code', {}, part.replace(/\n$/, ''))));
    let list = null, para = [];
    const flush = () => {
      if (para.length) { const p = h('p'); para.forEach((l, j) => { if (j) p.append(h('br')); p.append(inline(l)); }); frag.append(p); para = []; }
    };
    const lines = part.split('\n');
    for (let k = 0; k < lines.length; k++) {
      const line = lines[k].trimEnd();
      // 表格：| 表头 | 下一行是 |---|:---:| 分隔行
      if (/^\s*\|.*\|\s*$/.test(line) && TABLE_SEP.test(lines[k + 1] ?? '')) {
        flush(); list = null;
        const align = cells(lines[k + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : null));
        const row = (l, tag) => h('tr', {}, ...cells(l).map((c, j) => h(tag, align[j] ? { class: `al-${align[j]}` } : {}, inline(c))));
        const body = [];
        for (k += 2; k < lines.length && /^\s*\|.*\|\s*$/.test(lines[k]); k++) body.push(row(lines[k], 'td'));
        k--;
        frag.append(h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, row(line, 'th')), h('tbody', {}, ...body))));
        continue;
      }
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
  S.groups = await api('GET', '/api/groups').catch(() => S.groups);
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
  if ((e.type === 'engine.changed' || e.type === 'secret.changed' || e.type === 'device.paired') && S.view === 'settings') openSettings().catch(() => {});
  if (e.type === 'notify') {
    const name = S.bots.find((b) => b.id === e.botId)?.name;
    if (!(S.view === 'chat' && S.bot?.id === e.botId && !document.hidden)) toast(`${e.data.title}`);
    // 页面开着但不在前台：本地弹一条（和推送同一个 tag，不会重复）
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      navigator.serviceWorker?.ready.then((reg) => reg.showNotification(e.data.title, { body: e.data.body, tag: `notify-${e.seq}`, icon: '/icon-192.png', data: { url: name ? `/#bot=${enc(name)}` : '/' } })).catch(() => {});
    }
  }
  if (S.view === 'group' && S.group) groupEvent(e);
  if (e.type === 'group.changed') refreshSoon();
  if (e.type === 'routine.changed' && S.view === 'routines' && e.botId === S.bot?.id) openRoutines(S.bot).catch(() => {});
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
    const st = statusText(b);
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
  if (S.groups.length || S.bots.length >= 2) {
    scroll.append(h('div', { class: 'group with-btn' }, '群聊',
      h('button', { class: 'mini', title: '建群', 'aria-label': '建群', onclick: () => groupDialog() }, icon.plus())));
    for (const g of S.groups) {
      scroll.append(h('button', { class: 'row', 'aria-current': S.view === 'group' && S.group?.id === g.id ? 'true' : null, onclick: () => openGroup(g).catch((e) => toast(e.message)) },
        h('span', { class: 'gseals' }, ...g.members.slice(0, 3).map((n) => seal(n, 22))),
        h('span', { class: 'txt' }, h('div', { class: 'name' }, g.name),
          h('div', { class: 'prev' }, g.manager ? `总管 ${g.manager} · ${g.members.length} 位` : `${g.members.length} 位成员`))));
    }
  }
  if (pinned.length) scroll.append(h('div', { class: 'group' }, '置顶'), ...pinned.map(row));
  if (rest.length) scroll.append(h('div', { class: 'group' }, pinned.length ? '其他' : '全部'), ...rest.map(row));
  if (!S.bots.length) {
    scroll.append(h('p', { class: 'side-empty' }, canAdmin() ? '还没有 Bot。点右上角的 + 新建一个。' : '还没有 Bot。在服务器上运行 pagent bot create <名字> 新建一个。'));
  }

  const bottom = h('div', { class: 'side-bottom' },
    h('div', { class: 'me' }, S.device.name ?? '这台设备',
      h('small', { class: 'conn', dataset: { state: S.conn } }, { on: '已连接', retry: '重连中', off: '离线' }[S.conn])),
    h('button', { class: 'about-btn', 'aria-current': S.view === 'about' ? 'true' : null, onclick: () => openAbout().catch((e) => toast(e.message)) }, '关于我'),
    h('button', { class: 'about-btn', 'aria-current': S.view === 'settings' ? 'true' : null, onclick: () => openSettings().catch((e) => toast(e.message)) }, '设置'));

  $side.replaceChildren(top, scroll, bottom);
}

// ---------- 渲染：主区 ----------
function renderMain() {
  if (!S.device) return;
  if (S.view === 'about') return renderAbout();
  if (S.view === 'settings') return renderSettings();
  if (S.view === 'routines') return renderRoutines();
  if (S.view === 'memory') return renderMemory();
  if (S.view === 'group') return renderGroup();
  if (S.view !== 'chat' || !S.bot) {
    return $main.replaceChildren(h('div', { class: 'welcome' },
      h('h2', {}, '选一个 Bot 开始'),
      h('p', {}, '每个 Bot 有自己的会话和记忆，交代的事它会直接做完。需要你拿主意时，它会发一张选择卡。')));
  }
  closeScreen();
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
    h('div', { class: 'who' }, h('b', {}, b.name, h('span', { class: `engine ${b.engine}` }, b.engine === 'codex' ? 'Codex' : 'Claude')),
      h('small', {}, statusText(b) ?? (b.persona || '没有设定人设'))),
    h('button', { class: 'head-btn', 'aria-pressed': S.screen?.botId === b.id ? 'true' : 'false', onclick: () => toggleScreen(b) }, '屏幕'),
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
    case 'message.queued':
      if (d.meta?.routine) {
        return h('div', { class: 'routine-line', title: d.text }, h('span', { class: 'clock' }),
          `Routine「${d.meta.routine.name}」${{ schedule: '定时触发', webhook: 'webhook 触发', manual: '手动运行' }[d.meta.routine.trigger] ?? ''}`);
      }
      if (d.meta?.from) return h('div', { class: 'agent-msg' }, h('div', { class: 'from' }, seal(d.meta.from, 18), `${d.meta.from} ${d.meta.reply ? '回复' : '发来'}`), md(d.text.replace(/^\[[^\]]*\]\s*/, '')));
      return h('div', { class: 'mine' }, d.text);
    case 'assistant.text':
      if (/^\W*NO_NEWS\W*$/.test(d.text)) return null;
      return h('div', { class: 'say' }, md(d.text));
    case 'routine.fired':
      if (d.phase === 'skipped') return h('div', { class: 'step note' }, `Routine「${d.name}」${d.trigger === 'schedule' ? '到点了' : d.trigger === 'webhook' ? '被 webhook 触发' : '手动运行'}，但上一次还没跑完，这次跳过`);
      return d.phase === 'done' && d.quiet ? h('div', { class: 'step note' }, `Routine「${d.name}」跑完了：没有新内容，没打扰你`) : null;
    case 'routine.changed':
      return h('div', { class: 'step note' }, `${d.by} ${{ create: '新建了', update: '修改了', delete: '删掉了' }[d.op]} Routine「${d.name}」${d.when ? `（${d.when}）` : ''}`);
    case 'secret.used': return h('div', { class: 'step note' }, `取用了保险箱里的 ${d.name}`);
    case 'notify': return h('div', { class: 'notify-line' }, h('b', {}, '通知了你 · '), `${d.title}${d.body ? `：${d.body}` : ''}`);
    case 'screen.takeover': return h('div', { class: 'step note' }, d.on ? `${d.by} 接管了屏幕` : `${d.by} 交还了屏幕`);
    case 'agent.message': return h('div', { class: 'step note' }, `给 ${d.to} 发了消息：${String(d.text).slice(0, 80)}`);
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
  const takeover = d.kind === 'takeover';
  return h('article', { class: `ticket ask ${open ? 'open' : ''} ${takeover ? 'takeover' : ''}` },
    h('div', { class: 'top' },
      h('div', { class: 'label' }, open ? (takeover ? '请你接管屏幕' : '等你回答') : answer ? '已回答' : '已作废'),
      h('div', { class: 'q' }, d.question)),
    takeover && open ? h('button', { class: 'btn go take', onclick: () => openScreen(S.bot, 'takeover') }, '打开它的屏幕接管') : null,
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

// ---------- 屏幕：预览（只看）和接管（可操作），noVNC 经 pagentd 代理 ----------
async function toggleScreen(bot) {
  if (S.screen?.botId === bot.id) closeScreen();
  else await openScreen(bot, 'preview');
  renderHead();
}

function closeScreen() {
  if (!S.screen) return;
  try { S.screen.rfb?.disconnect(); } catch {}
  S.screen.el.remove();
  S.screen = null;
}

async function openScreen(bot, mode) {
  closeScreen();
  const view = h('div', { class: 'screen-view' }, h('div', { class: 'screen-wait' }, '正在打开屏幕…'));
  const bar = h('div', { class: 'screen-bar' });
  const el = h('div', { class: mode === 'takeover' ? 'takeover' : 'screen-pop', role: 'region', 'aria-label': `${bot.name} 的屏幕` }, bar, view);
  S.screen = { botId: bot.id, mode, el, rfb: null };
  document.body.append(el);
  const done = async () => {
    try {
      await api('POST', `/api/bots/${enc(bot.name)}/screen/takeover`, { on: false });
      // 有等着的接管卡：交还就是回答它
      const pending = [...S.history].reverse().find((e) => e.type === 'ask.created' && e.data.kind === 'takeover');
      const answered = S.history.some((e) => e.type === 'message.queued' && pending && e.seq > pending.seq);
      if (pending && !answered) await sendText('我已经在屏幕上处理好了，交还给你，请继续。');
      toast('已交还');
    } catch (e) { toast(e.message); }
    closeScreen();
    renderHead();
  };
  if (mode === 'takeover') {
    bar.append(h('b', {}, `你正在操作 ${bot.name} 的屏幕`), h('small', {}, '它的屏幕工具已暂停'),
      h('button', { class: 'btn go', onclick: done }, '完成，交还给它'));
  } else {
    bar.append(h('b', {}, `${bot.name} 的屏幕`), h('small', {}, '只看'),
      h('button', { class: 'btn', onclick: () => openScreen(bot, 'takeover') }, '接管'),
      h('button', { class: 'btn', 'aria-label': '关闭', onclick: () => { closeScreen(); renderHead(); } }, '×'));
  }
  try {
    if (mode === 'takeover') await api('POST', `/api/bots/${enc(bot.name)}/screen/takeover`, { on: true });
    const st = await api('POST', `/api/bots/${enc(bot.name)}/screen`);
    const { default: RFB } = await import('/novnc/core/rfb.js');
    if (S.screen?.el !== el) return;
    view.replaceChildren();
    const rfb = new RFB(view, `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/vnc/${st.networkToken}`, { shared: true });
    rfb.viewOnly = mode !== 'takeover';
    rfb.scaleViewport = true;
    rfb.background = 'transparent';
    rfb.addEventListener('disconnect', () => { if (S.screen?.rfb === rfb) view.replaceChildren(h('div', { class: 'screen-wait' }, '屏幕连接断开了')); });
    S.screen.rfb = rfb;
    if (mode === 'takeover') rfb.focus();
  } catch (e) {
    view.replaceChildren(h('div', { class: 'screen-wait' }, `打不开屏幕：${e.message}`));
  }
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

// ---------- Routine ----------
async function openRoutines(bot) {
  S.bot = bot;
  S.view = 'routines';
  S.routines = await api('GET', `/api/routines?bot=${enc(bot.name)}`);
  render();
}

const PRESETS = [
  ['每天 8:00', '0 8 * * *'], ['工作日 9:30', '30 9 * * 1-5'], ['每小时', '0 * * * *'], ['每 15 分钟', '*/15 * * * *'], ['只用 webhook', ''],
];

function renderRoutines() {
  const b = S.bot;
  const head = h('header', { class: 'chat-head' },
    h('button', { class: 'back-btn show', 'aria-label': '返回对话', onclick: () => openBot(b) }, '‹'),
    seal(b.name, 36, b.status),
    h('div', { class: 'who' }, h('b', {}, `${b.name} 的 Routine`), h('small', {}, '到点后在它的会话里自动跑；没有新内容不会打扰你')),
    h('button', { class: 'head-btn', onclick: () => openBot(b) }, '回到对话'));
  const page = h('section', { class: 'page' });
  page.append(h('p', { class: 'hint' }, `也可以直接在对话里跟 ${b.name} 说"每天早上 8 点帮我……"，它会自己建。时间按你的本地时区。`));
  if (!S.routines.length) page.append(h('div', { class: 'empty' }, '还没有 Routine。'));
  for (const r of S.routines) {
    const sw = h('input', { type: 'checkbox', role: 'switch', 'aria-label': '启用' });
    sw.checked = r.enabled;
    sw.addEventListener('change', async () => { try { await api('PATCH', `/api/routines/${r.id}`, { enabled: sw.checked }); } catch (e) { toast(e.message); sw.checked = !sw.checked; } });
    page.append(h('article', { class: 'routine' },
      h('div', { class: 'r-head' }, h('strong', {}, r.name), h('span', { class: 'pill' }, r.when), sw),
      h('p', { class: 'r-prompt' }, r.prompt),
      h('div', { class: 'fact-meta' },
        r.nextAt ? `下次 ${timeLabel(r.nextAt)}` : null, r.lastFiredAt ? ` · 上次 ${timeLabel(r.lastFiredAt)}` : null, ` · ${r.createdBy} 建的`,
        h('button', { class: 'link', onclick: async () => { try { const res = await api('POST', `/api/routines/${r.id}/run`); if (res?.skipped) return toast('上一次还没跑完，这次跳过了'); toast('已开始运行'); openBot(b); } catch (e) { toast(e.message); } } }, '现在运行'),
        h('button', { class: 'link', onclick: async () => { if (!confirm(`删除「${r.name}」？`)) return; try { await api('DELETE', `/api/routines/${r.id}`); await openRoutines(b); } catch (e) { toast(e.message); } } }, '删除')),
      r.webhook ? h('div', { class: 'webhook' }, 'Webhook：', h('code', {}, `POST ${location.origin}${r.webhook}`)) : null));
  }
  // 新建
  const name = h('input', { placeholder: '名字，比如 盘前要闻', maxlength: 60, required: true });
  const prompt = h('textarea', { placeholder: '每次要做的事，比如：整理美股盘前要闻，结论先行，不超过 5 条', required: true });
  const preset = h('select', {}, ...PRESETS.map(([l, v]) => h('option', { value: v }, l)), h('option', { value: '__custom' }, '自定义 cron'));
  const cron = h('input', { placeholder: '分 时 日 月 周，例如 0 8 * * *', hidden: true });
  preset.addEventListener('change', () => { cron.hidden = preset.value !== '__custom'; });
  const form = h('form', { class: 'form routine-form' },
    h('h3', { class: 'sec' }, '新建 Routine'),
    h('label', {}, '名字', name), h('label', {}, '要做的事', prompt), h('label', {}, '什么时候', preset, cron),
    h('div', { class: 'row-btns left' }, h('button', { type: 'submit', class: 'btn go' }, '新建')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const schedule = preset.value === '__custom' ? cron.value.trim() : preset.value;
    try {
      await api('POST', `/api/bots/${enc(b.name)}/routines`, { name: name.value, prompt: prompt.value, schedule: schedule || null, webhook: !schedule });
      await openRoutines(b);
      toast('已新建');
    } catch (ex) { toast(ex.message); }
  });
  page.append(form);
  $main.replaceChildren(head, page);
}

// ---------- 通知（Web Push） ----------
async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('这个浏览器不支持推送通知（iPhone 需要先"添加到主屏幕"再从主屏幕打开）');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('没有得到通知权限');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api('GET', '/api/push/key');
  const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api('POST', '/api/push/subscribe', sub.toJSON());
  const r = await api('POST', '/api/push/test');
  return r;
}

// ---------- 设置：引擎登录、出口线路 ----------
async function openSettings() {
  S.view = 'settings';
  const [engines, settings, machines, secrets] = await Promise.all([
    api('GET', '/api/engines'), api('GET', '/api/settings'), api('GET', '/api/machines'),
    canAdmin() ? api('GET', '/api/secrets') : Promise.resolve([]),
  ]);
  S.settings = { engines, settings, machines, secrets };
  render();
}

let codexPoll = null;
function renderSettings() {
  const { engines, settings } = S.settings;
  const head = h('header', { class: 'chat-head' },
    h('button', { class: 'back-btn', 'aria-label': '返回', onclick: () => { S.view = 'home'; render(); } }, '‹'),
    h('div', { class: 'who' }, h('b', {}, '设置'), h('small', {}, '整个 PersonAgent 的设置，对所有 Bot 生效')));
  const page = h('section', { class: 'page' });

  page.append(h('h3', { class: 'sec' }, '引擎'),
    h('p', { class: 'hint' }, '每个 Bot 可以选用 Claude 或 Codex。两种订阅都在盒子里用官方命令行工具运行，登录一次所有 Bot 共用。'));
  const cl = engines.claude;
  page.append(h('article', { class: 'card-row' },
    h('div', {}, h('strong', {}, 'Claude'), h('p', {}, cl.detail)),
    h('span', { class: `pill ${cl.loggedIn ? 'ok' : 'bad'}` }, cl.loggedIn ? '可用' : '未登录')));
  const cx = engines.codex;
  const login = cx.login?.status === 'pending' ? cx.login : null;
  const codexCard = h('article', { class: 'card-row' },
    h('div', {}, h('strong', {}, 'Codex'), h('p', {}, cx.loggedIn ? cx.detail : 'ChatGPT 订阅（Plus / Pro / Team）。用设备码登录：在手机或电脑上打开网址、输入验证码。')),
    h('span', { class: `pill ${cx.loggedIn ? 'ok' : 'bad'}` }, cx.loggedIn ? '已登录' : '未登录'));
  page.append(codexCard);
  if (login?.code) {
    page.append(h('div', { class: 'device-code' },
      h('p', {}, '1. 打开 ', h('a', { href: login.url, target: '_blank', rel: 'noopener noreferrer' }, login.url)),
      h('p', {}, '2. 用你的 ChatGPT 账号登录，输入验证码：'),
      h('div', { class: 'code' }, login.code),
      h('p', { class: 'hint' }, '15 分钟内有效。完成后这里会自动变成"已登录"。如果提示设备码登录未开启，先在 ChatGPT 的 设置 → 安全 里打开"为 Codex 启用设备码授权"。')));
  }
  if (canAdmin()) {
    page.append(h('div', { class: 'row-btns left' },
      cx.loggedIn
        ? h('button', { class: 'btn', onclick: async () => { if (!confirm('退出 Codex 登录？用 Codex 的 Bot 会停用。')) return; try { await api('POST', '/api/engines/codex/logout'); await openSettings(); } catch (e) { toast(e.message); } } }, '退出 Codex 登录')
        : h('button', { class: 'btn go', onclick: async (ev) => {
          ev.target.disabled = true;
          try { await api('POST', '/api/engines/codex/login'); await openSettings(); } catch (e) { toast(e.message); ev.target.disabled = false; }
        } }, login ? '重新获取验证码' : '登录 ChatGPT')));
  }
  clearInterval(codexPoll);
  if (login) {
    codexPoll = setInterval(async () => {
      if (S.view !== 'settings') return clearInterval(codexPoll);
      try {
        const e = await api('GET', '/api/engines');
        if (e.codex.loggedIn || e.codex.login?.status !== 'pending') { clearInterval(codexPoll); S.settings.engines = e; renderSettings(); }
      } catch {}
    }, 3000);
  }

  page.append(h('h3', { class: 'sec' }, '本机执行'),
    h('p', { class: 'hint' }, '让 Bot 在你自己的电脑上读文件、跑命令（只限你开放的目录）。电脑上运行 pagent-local 守护进程连进来；每台电脑只有"关闭 / 允许"两档，默认关闭，关掉立即失效。'));
  if (!S.settings.machines.length) page.append(h('div', { class: 'empty' }, '还没有接入电脑。在服务器上运行 pagent device pair 我的Mac --scopes local 拿配对码，然后在电脑上运行 pagent-local pair <地址> <配对码>。'));
  for (const m of S.settings.machines) {
    const sw = h('input', { type: 'checkbox', role: 'switch', 'aria-label': `允许 ${m.name}`, disabled: !canAdmin() });
    sw.checked = m.allowed;
    sw.addEventListener('change', async () => {
      try { await api('PATCH', `/api/machines/${m.id}`, { allowed: sw.checked }); toast(sw.checked ? `已允许 Bot 使用 ${m.name}` : `已关闭 ${m.name}，在途任务已取消`); }
      catch (e) { toast(e.message); sw.checked = !sw.checked; }
    });
    page.append(h('label', { class: 'card-row switch' },
      h('div', {}, h('strong', {}, m.name, h('span', { class: `pill ${m.online ? 'ok' : ''}` }, m.online ? '在线' : '离线')),
        h('p', {}, m.root ? `开放目录：${m.root}${m.host ? `（${m.host}）` : ''}` : '还没连上过')),
      sw));
  }

  if (canAdmin()) {
    page.append(h('h3', { class: 'sec' }, '保险箱'),
      h('p', { class: 'hint' }, '密码和 token 加密存在服务器上。Bot 只看得到名字：命令里用环境变量 $名字，网页登录时由盒子直接把值填进输入框，时间线上会被遮住。'));
    for (const x of S.settings.secrets) {
      page.append(h('article', { class: 'card-row' },
        h('div', {}, h('code', {}, x.name), h('p', {}, `${x.note ? `${x.note} · ` : ''}${x.updatedBy} 更新于 ${timeLabel(x.updatedAt)}`)),
        h('button', { class: 'link', onclick: async () => { if (!confirm(`删除 ${x.name}？`)) return; try { await api('DELETE', `/api/secrets/${x.name}`); await openSettings(); } catch (e) { toast(e.message); } } }, '删除')));
    }
    const sn = h('input', { placeholder: '名字，如 GITHUB_TOKEN', pattern: '[A-Z][A-Z0-9_]{1,63}', required: true, 'aria-label': '名字' });
    const sv = h('input', { type: 'password', placeholder: '值', required: true, autocomplete: 'off', 'aria-label': '值' });
    const note = h('input', { placeholder: '说明（可选）', 'aria-label': '说明' });
    const sf = h('form', { class: 'fact-add secret-add' }, sn, sv, note, h('button', { class: 'btn go', type: 'submit' }, '存入'));
    sn.addEventListener('input', () => { sn.value = sn.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'); });
    sf.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('PUT', `/api/secrets/${sn.value}`, { value: sv.value, note: note.value || undefined }); sv.value = ''; await openSettings(); toast('已存入保险箱'); }
      catch (ex) { toast(ex.message); }
    });
    page.append(sf);
  }

  page.append(h('h3', { class: 'sec' }, '通知'));
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  page.append(h('article', { class: 'card-row' },
    h('div', {}, h('strong', {}, '在这台设备上接收通知'),
      h('p', {}, 'Bot 等你回答、请你接管屏幕、Routine 有新内容、Bot 主动通知你时推送。iPhone 要先用 Safari "添加到主屏幕"，再从主屏幕打开。')),
    h('button', { class: 'btn go', onclick: async (ev) => {
      ev.target.disabled = true;
      try { const r = await enablePush(); toast(r.sent ? '已打开，发了一条测试通知' : '已订阅，但测试通知没发出去'); } catch (e) { toast(e.message); }
      ev.target.disabled = false;
    } }, perm === 'granted' ? '重新订阅并测试' : '打开通知')));

  page.append(h('h3', { class: 'sec' }, '出口线路'));
  const eg = settings.egress;
  const sw = h('input', { type: 'checkbox', role: 'switch', disabled: !eg.homeAvailable || !canAdmin() });
  sw.checked = eg.viaHome;
  sw.addEventListener('change', async () => {
    try { S.settings.settings = await api('PATCH', '/api/settings', { egress: { viaHome: sw.checked } }); toast(sw.checked ? '盒子的公网流量改走家里线路' : '盒子的公网流量改为直连'); }
    catch (e) { toast(e.message); sw.checked = !sw.checked; }
  });
  page.append(h('label', { class: 'card-row switch' },
    h('div', {}, h('strong', {}, '走家里的住宅线路'),
      h('p', {}, eg.homeAvailable ? '打开后，Bot 上网（浏览器、命令行）都经家里的住宅 IP 出去，网站不容易把它当成机房流量。局域网照样挡住。' : '服务器上没有配置家里线路（PAGENT_HOME_PROXY）。')),
    sw));
  $main.replaceChildren(head, page);
}

// ---------- 群聊：你说一句，总管分派给成员，成员做完回给总管，总管汇总 ----------
async function openGroup(g) {
  closeScreen();
  const { events } = await api('GET', `/api/groups/${g.id}/history`);
  S.group = { ...g, events: [], runs: new Set(), msgIds: new Set() };
  S.view = 'group';
  for (const e of events) groupEvent(e, true);
  render();
}

/** 一条事件属不属于这个群：群里的发言、成员间消息，以及由群消息触发的轮次 */
function groupEvent(e, quiet = false) {
  const g = S.group;
  const d = e.data;
  if (e.type === 'message.queued' && d.meta?.group?.id === g.id) { g.msgIds.add(d.messageId); return; }
  if (e.type === 'run.started' && (d.messageIds ?? []).some((id) => g.msgIds.has(id)) || (quiet && e.type === 'run.started')) g.runs.add(e.runId);
  const mine = d.groupId === g.id || (e.runId && g.runs.has(e.runId));
  if (!mine || g.events.some((x) => x.seq === e.seq)) return;
  g.events.push(e);
  if (!quiet) renderGroupLog();
}

function renderGroup() {
  const g = S.group;
  const del = async () => {
    if (!confirm(`解散「${g.name}」？成员和它们的记忆不受影响。`)) return;
    try { await api('DELETE', `/api/groups/${g.id}`); S.view = 'home'; S.group = null; await refreshState(); render(); } catch (e) { toast(e.message); }
  };
  const head = h('header', { class: 'chat-head' },
    h('button', { class: 'back-btn', 'aria-label': '返回', onclick: () => { S.view = 'home'; render(); } }, '‹'),
    h('span', { class: 'gseals' }, ...g.members.slice(0, 3).map((n) => seal(n, 26))),
    h('div', { class: 'who' }, h('b', {}, g.name),
      h('small', {}, g.members.map((n) => (n === g.manager ? `${n}（总管）` : n)).join('、'))),
    h('button', { class: 'head-btn', onclick: del }, '解散'));
  const input = h('textarea', { rows: 1, placeholder: g.manager ? `交给总管 ${g.manager} 分派；@名字 直接找某个成员` : '发给所有成员；@名字 只找某个成员', 'aria-label': '群消息' });
  const sendBtn = h('button', { class: 'send icon', disabled: true, 'aria-label': '发送', title: '发送' }, icon.arrow());
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendBtn.disabled = true;
    try { await api('POST', `/api/groups/${g.id}/messages`, { text }); } catch (e) { toast(e.message); input.value = text; }
  };
  input.addEventListener('input', () => { sendBtn.disabled = !input.value.trim(); input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  sendBtn.addEventListener('click', send);
  $main.replaceChildren(head, h('div', { class: 'log', id: 'log', 'aria-live': 'polite' }), h('div', { id: 'composer-slot' }, h('div', { class: 'composer' }, input, sendBtn)));
  renderGroupLog(true);
}

function renderGroupLog(toEnd = false) {
  const log = document.getElementById('log');
  const g = S.group;
  if (!log || S.view !== 'group') return;
  const atEnd = toEnd || log.scrollHeight - log.scrollTop - log.clientHeight < 100;
  const nameOf = (id) => S.bots.find((b) => b.id === id)?.name ?? '?';
  const nodes = [];
  let lastTs = 0;
  let lastSpeaker = null;
  const working = new Map();
  for (const e of g.events) {
    const d = e.data;
    let node = null;
    if (e.type === 'run.started') working.set(e.botId, e.runId);
    if (e.type === 'run.finished' && working.get(e.botId) === e.runId) working.delete(e.botId);
    if (e.type === 'message.queued') { node = h('div', { class: 'mine' }, d.text); lastSpeaker = null; }
    else if (e.type === 'assistant.text' && !/^\W*NO_NEWS\W*$/.test(d.text)) {
      const who = nameOf(e.botId);
      node = h('div', { class: 'gsay' }, who !== lastSpeaker ? h('div', { class: 'from' }, seal(who, 20), who) : null, h('div', { class: 'say' }, md(d.text)));
      lastSpeaker = who;
    } else if (e.type === 'agent.message') {
      node = h('div', { class: 'handoff' }, seal(nameOf(e.botId), 18), h('b', {}, nameOf(e.botId)), ' → ', seal(d.to, 18), h('b', {}, d.to), h('span', { class: 'htext' }, String(d.text).slice(0, 140)));
      lastSpeaker = null;
    } else if (e.type === 'tool.use' && !/^mcp__pagent__(message_agent|remember|ask_user|list_agents)$/.test(d.name) && d.name !== 'ToolSearch') {
      if (nameOf(e.botId) !== lastSpeaker) lastSpeaker = null;
      node = h('div', { class: 'step', title: d.summary ?? brief(d.input) }, `${nameOf(e.botId)} · ${d.name.replace(/^mcp__[^_]+__/, '')}  ${d.summary ?? brief(d.input)}`);
    } else if (e.type === 'run.finished' && d.status !== 'succeeded') {
      node = h('div', { class: 'end bad' }, `${nameOf(e.botId)}：${{ failed: '这一轮失败了', interrupted: '已停止' }[d.status] ?? d.status}${d.error ? `：${String(d.error).slice(0, 160)}` : ''}`);
    }
    if (!node) continue;
    const t = Date.parse(e.ts);
    if (t - lastTs > 10 * 60_000) nodes.push(h('div', { class: 'time' }, timeLabel(e.ts)));
    lastTs = t;
    nodes.push(node);
  }
  for (const id of working.keys()) if (S.running.get(id)) nodes.push(h('div', { class: 'end' }, `${nameOf(id)} 正在处理…`));
  if (!nodes.length) {
    nodes.push(h('div', { class: 'welcome' }, h('span', { class: 'gseals' }, ...g.members.slice(0, 4).map((n) => seal(n, 44))), h('h2', {}, g.name),
      h('p', {}, g.manager ? `你说的话交给总管 ${g.manager}：它会把任务拆给合适的成员，等大家做完再汇总给你。` : '你说的话会发给每个成员。'),
      h('p', {}, '想直接找某个成员，就在消息里 @它的名字。')));
  }
  log.replaceChildren(...nodes);
  if (atEnd) log.scrollTop = log.scrollHeight;
}

function groupDialog() {
  const name = h('input', { required: true, maxlength: 40, placeholder: '比如 周报小组' });
  const boxes = S.bots.map((b) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: b.name }), seal(b.name, 20), b.name));
  const manager = h('select', {}, h('option', { value: '' }, '不设总管（发给所有成员）'), ...S.bots.map((b) => h('option', { value: b.name }, b.name)));
  const err = h('p', { class: 'error', role: 'alert' });
  const form = h('form', { class: 'form', method: 'dialog' },
    h('h2', {}, '建一个群'),
    h('label', {}, '群名', name),
    h('div', { class: 'field' }, h('span', {}, '成员', h('small', {}, '至少两个')), h('div', { class: 'checks' }, ...boxes)),
    h('label', {}, '总管', h('small', {}, '你的消息先交给它，由它分派、汇总'), manager),
    err,
    h('div', { class: 'row-btns' },
      h('button', { type: 'button', class: 'btn', onclick: () => $dlg.close() }, '取消'),
      h('button', { type: 'submit', class: 'btn go' }, '建群')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const members = boxes.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
    try {
      const g = await api('POST', '/api/groups', { name: name.value.trim(), members, manager: manager.value || null });
      $dlg.close();
      await refreshState();
      await openGroup(g);
    } catch (ex) { err.textContent = ex.message; }
  });
  $dlg.replaceChildren(form);
  $dlg.showModal();
  name.focus();
}

// ---------- 弹窗 ----------
function editBotDialog(bot) {
  const name = h('input', { required: true, maxlength: 31, placeholder: '比如 股票研究', value: bot?.name ?? '', disabled: !!bot });
  const persona = h('textarea', { placeholder: '它是谁、负责什么、说话风格，以及你的红线。比如：你负责每天早上整理美股盘前要闻，结论先行，不超过 5 条；花钱之前先问我。' }, bot?.persona ?? '');
  const engine = h('select', {},
    h('option', { value: 'claude' }, 'Claude（Claude Code，Claude 订阅）'), h('option', { value: 'codex' }, 'Codex（Codex CLI，ChatGPT 订阅）'));
  engine.value = bot?.engine ?? 'claude';
  const model = h('select', {});
  const fillModels = () => {
    const keep = model.value;
    model.replaceChildren(...(engine.value === 'codex'
      ? [h('option', { value: '' }, '跟随账号默认')]
      : [h('option', { value: '' }, '跟随账号默认'), h('option', { value: 'opus' }, 'Opus（最强）'),
        h('option', { value: 'sonnet' }, 'Sonnet（均衡）'), h('option', { value: 'haiku' }, 'Haiku（最快）')]));
    model.value = [...model.options].some((o) => o.value === keep) ? keep : '';
  };
  engine.addEventListener('change', fillModels);
  fillModels();
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
    h('label', {}, '引擎', bot ? h('small', {}, '换引擎会开一条新会话，记忆都保留') : null, engine),
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
        await api('PATCH', `/api/bots/${enc(bot.name)}`, { persona: persona.value, model: model.value, engine: engine.value });
        $dlg.close();
        toast('已保存，下一轮生效');
        await refreshState();
      } else {
        const r = await api('POST', '/api/bots', { name: name.value.trim(), persona: persona.value, model: model.value, engine: engine.value });
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
    h('div', { class: 'preview' }, seal(bot.name, 44, 'idle'), h('div', {}, h('strong', {}, bot.name), h('br'),
      `${bot.engine === 'codex' ? 'Codex' : 'Claude'} · ${bot.model ?? '跟随账号默认模型'}`)),
    bot.persona ? h('p', {}, bot.persona) : null,
    h('div', { class: 'menu-item' },
      h('div', {}, h('strong', {}, '开新会话'), h('p', {}, '清空对话上下文，人设和记忆都保留。对话太长、或者要换个话题时用。')),
      item('开新会话', () => newSession(bot))),
    h('div', { class: 'menu-item' },
      h('div', {}, h('strong', {}, '它会的技能'), h('p', {}, '盒子里共享的 skill，以及给它启用的插件带来的 skill。它自己学会的新技能也会出现在这里。')),
      item('查看技能', () => skillsDialog(bot).catch((e) => toast(e.message)))),
    h('div', { class: 'menu-item' },
      h('div', {}, h('strong', {}, 'Routine'), h('p', {}, '定时或 webhook 触发，在它的会话里自动跑。没有新内容不打扰你。')),
      item('管理 Routine', () => openRoutines(bot).catch((e) => toast(e.message)))),
    h('div', { class: 'row-btns' },
      item(pinned ? '取消置顶' : '置顶', () => togglePin(bot)),
      canAdmin() ? item('编辑人设', () => editBotDialog(bot)) : null,
      h('button', { type: 'button', class: 'btn go', onclick: () => $dlg.close() }, '关闭'))));
  $dlg.showModal();
}

async function skillsDialog(bot) {
  const list = await api('GET', `/api/bots/${enc(bot.name)}/skills`);
  $dlg.replaceChildren(h('div', { class: 'form' },
    h('h2', {}, `${bot.name} 会的技能`),
    list.length
      ? h('ul', { class: 'skills' }, ...list.map((k) => h('li', {},
        h('div', { class: 'k-head' }, h('code', {}, k.name), h('span', { class: 'k-src' }, k.source)),
        h('p', {}, k.description || '（没有说明）'))))
      : h('p', {}, '还没有技能。让它"学会"某件事（比如"把你刚才的做法写成一个 skill"），它会装进共享目录，所有 Agent 都能用。'),
    h('div', { class: 'row-btns' }, h('button', { type: 'button', class: 'btn go', onclick: () => $dlg.close() }, '关闭'))));
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

/** 通知点进来：/#bot=<名字> 打开对应的对话 */
function openFromHash() {
  const name = new URLSearchParams(location.hash.slice(1)).get('bot');
  const bot = name && S.bots.find((b) => b.name === name);
  if (bot) { history.replaceState(null, '', location.pathname); openBot(bot); }
}

// ---------- 启动 ----------
async function start() {
  if (!crypto.subtle) {
    $main.replaceChildren(h('div', { class: 'welcome' }, h('h2', {}, '需要安全连接'),
      h('p', {}, '请通过 HTTPS（或 localhost）打开这个页面，浏览器才允许生成设备密钥。')));
    return;
  }
  navigator.serviceWorker?.register('/sw.js').catch(() => {});
  navigator.serviceWorker?.addEventListener('message', (ev) => { if (ev.data?.type === 'open') { location.hash = new URL(ev.data.url, location.origin).hash; openFromHash(); } });
  window.addEventListener('hashchange', openFromHash);
  S.device = await loadDevice();
  if (!S.device) return renderPair();
  try {
    await login();
    const me = await api('GET', '/api/me');
    S.device.scopes = me.scopes;
    S.device.name = me.name;
    render();
    await refreshState();
    openFromHash();
  } catch (e) {
    if (e instanceof Revoked) return showRevoked(e.message);
    setConn('off');
    toast(e.message);
  }
  streamLoop();
}
start();

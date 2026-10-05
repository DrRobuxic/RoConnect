'use strict';
/* Roblox Friend Analyzer
 * Static site, vanilla JS. Reads only public Roblox web APIs. No credentials, cookies or tokens.
 * Direct browser requests are tried first. If the browser blocks a host (CORS), the optional
 * Worker proxy from worker.js is used for that host only, if you have configured one.
 */

/* ================= CONFIG ================= */
const CONFIG = {
  DEFAULT_USER_ID: '2968372123',      // DrRobuxic. Change this to change the page default.
  WORKER_URL: '',                      // Optional proxy, e.g. 'https://rbx.yourname.workers.dev'
  MAX_CONCURRENT_REQUESTS: 4,
  MIN_REQUEST_GAP_MS: 120,            // spacing between request starts
  MAX_RETRIES: 5,
  BACKOFF_BASE_MS: 1000,
  BACKOFF_MAX_MS: 30000,
  PAGE_SIZE: 100,                      // table rows rendered per "Show more"
  RENDER_THROTTLE_MS: 250,
  TTL: {                               // cache lifetimes (ms)
    user: 24 * 3600e3,
    friends: 10 * 60e3,
    counts: 15 * 60e3,
    avatar: 30 * 60e3,
    asset: 6 * 3600e3,
    thumb: 30 * 60e3,
  },
};

/* ================= Hosts / endpoints ================= */
const HOSTS = {
  users:      { purpose: 'Profile, display name, creation date', paths: ['GET /v1/users/{id}'] },
  friends:    { purpose: 'Friend list, follower, following and friend counts', paths: ['GET /v1/users/{id}/friends', 'GET /v1/users/{id}/friends/count', 'GET /v1/users/{id}/followers/count', 'GET /v1/users/{id}/followings/count'] },
  thumbnails: { purpose: 'Headshot images', paths: ['GET /v1/users/avatar-headshot'] },
  avatar:     { purpose: 'Currently equipped items', paths: ['GET /v1/users/{id}/avatar'] },
  economy:    { purpose: 'Item prices', paths: ['GET /v2/assets/{id}/details'] },
};
const hostState = {};
function resetHostStates(keepOk) {
  for (const h of Object.keys(HOSTS)) {
    const prev = hostState[h];
    hostState[h] = {
      mode: keepOk && prev && prev.mode !== 'blocked' ? prev.mode : 'unknown',
      ok: prev ? prev.ok : 0, fail: prev ? prev.fail : 0,
      limited: prev ? prev.limited : 0, lastError: '',
    };
  }
}
resetHostStates(false);

/* ================= Small utils ================= */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n) => (n == null ? null : Number(n).toLocaleString());
const fmtRobux = (n) => 'R$ ' + Math.round(n).toLocaleString();
const fmtDate = (d) => (d ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null);
const NA = '<span class="na">Unavailable</span>';
const PENDING = '<span class="na">&hellip;</span>';

function fmtAge(days) {
  if (days == null) return null;
  if (days < 31) return days + 'd';
  const y = Math.floor(days / 365), m = Math.floor((days % 365) / 30);
  return y ? (m ? `${y}y ${m}mo` : `${y}y`) : `${m}mo`;
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new ApiError('aborted', 'Cancelled'));
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new ApiError('aborted', 'Cancelled')); }, { once: true });
  });
}
function safeStorage() { try { return window.localStorage; } catch (e) { return null; } }
const store = safeStorage();
function lsGet(k) { try { return store ? store.getItem(k) : null; } catch (e) { return null; } }
function lsSet(k, v) { try { if (store) store.setItem(k, v); } catch (e) { /* quota or blocked: ignore */ } }
function lsDel(k) { try { if (store) store.removeItem(k); } catch (e) { /* ignore */ } }

/* ================= Errors ================= */
class ApiError extends Error {
  constructor(kind, message, extra) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind; // aborted | cors | network | proxy | blocked | rate | server | http | parse
    this.retryable = false;
    if (extra) Object.assign(this, extra);
  }
}

/* ================= Cache ================= */
const cache = {
  mem: new Map(),
  get(key, ttl) {
    const m = this.mem.get(key);
    if (m && Date.now() - m.t < ttl) return m.v;
    const raw = lsGet('rfa1:' + key);
    if (raw) {
      try {
        const o = JSON.parse(raw);
        if (Date.now() - o.t < ttl) { this.mem.set(key, o); return o.v; }
      } catch (e) { /* ignore corrupt entry */ }
      lsDel('rfa1:' + key);
    }
    return undefined;
  },
  set(key, v) {
    const o = { t: Date.now(), v };
    this.mem.set(key, o);
    lsSet('rfa1:' + key, JSON.stringify(o));
  },
  clear() {
    this.mem.clear();
    if (!store) return;
    try {
      const del = [];
      for (let i = 0; i < store.length; i++) { const k = store.key(i); if (k && k.startsWith('rfa1:')) del.push(k); }
      del.forEach((k) => store.removeItem(k));
    } catch (e) { /* ignore */ }
  },
};

/* ================= Worker URL setting ================= */
function getWorkerUrl() {
  const raw = (lsGet('rfa:worker') || CONFIG.WORKER_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  if (/^https:\/\//i.test(raw) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(raw)) return raw;
  return '';
}

/* ================= Request queue ================= */
class RequestQueue {
  constructor() { this.lanes = [[], [], []]; this.active = 0; this.nextAllowed = 0; this.pausedUntil = 0; this.timer = null; }
  add(task, priority = 1) {
    return new Promise((resolve, reject) => { this.lanes[priority].push({ task, resolve, reject }); this.pump(); });
  }
  clearPending() {
    for (const lane of this.lanes) { for (const j of lane) j.reject(new ApiError('aborted', 'Cancelled')); lane.length = 0; }
  }
  pause(ms) { this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms); }
  get pending() { return this.lanes[0].length + this.lanes[1].length + this.lanes[2].length; }
  pump() {
    clearTimeout(this.timer);
    while (this.active < CONFIG.MAX_CONCURRENT_REQUESTS) {
      const now = Date.now();
      const wait = Math.max(this.pausedUntil - now, this.nextAllowed - now);
      if (wait > 0) { this.timer = setTimeout(() => this.pump(), wait); return; }
      const job = this.lanes[0].shift() || this.lanes[1].shift() || this.lanes[2].shift();
      if (!job) return;
      this.active++;
      this.nextAllowed = Date.now() + CONFIG.MIN_REQUEST_GAP_MS;
      Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => { this.active--; this.pump(); });
    }
  }
}
const queue = new RequestQueue();

/* ================= HTTP layer ================= */
function parseRetryAfter(res) {
  const v = res.headers.get('retry-after');
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.min(Math.max(s, 1), 60) * 1000;
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.min(Math.max(d - Date.now(), 1000), 60000) : null;
}

async function doFetch(host, path, signal, viaProxy) {
  const worker = getWorkerUrl();
  const url = viaProxy ? `${worker}/${host}${path}` : `https://${host}.roblox.com${path}`;
  let res;
  try {
    res = await fetch(url, { signal, credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' } });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new ApiError('aborted', 'Cancelled');
    if (navigator.onLine === false) { const er = new ApiError('network', 'You appear to be offline.', { host }); er.retryable = true; throw er; }
    throw new ApiError(viaProxy ? 'proxy' : 'cors', viaProxy ? 'The proxy Worker could not be reached.' : 'The browser blocked the request.', { host });
  }
  if (res.ok) {
    try { return await res.json(); } catch (e) { throw new ApiError('parse', 'Roblox returned a response that is not valid JSON.', { host, status: res.status }); }
  }
  if (res.status === 429) { const er = new ApiError('rate', 'Rate limited by Roblox (HTTP 429).', { host, status: 429, retryAfterMs: parseRetryAfter(res) }); er.retryable = true; throw er; }
  if (res.status >= 500) { const er = new ApiError('server', `Roblox server error (HTTP ${res.status}).`, { host, status: res.status }); er.retryable = true; throw er; }
  throw new ApiError('http', `Roblox answered HTTP ${res.status}.`, { host, status: res.status });
}

async function fetchOnce(host, path, signal) {
  const hs = hostState[host];
  if (hs.mode === 'blocked') throw new ApiError('blocked', `${host}.roblox.com is blocked by the browser.`, { host });
  const worker = getWorkerUrl();
  let viaProxy = hs.mode === 'proxy' && !!worker;
  if (hs.mode === 'proxy' && !worker) hs.mode = 'unknown';
  try {
    const data = await doFetch(host, path, signal, viaProxy);
    hs.ok++;
    if (hs.mode === 'unknown') hs.mode = viaProxy ? 'proxy' : 'direct';
    return data;
  } catch (e) {
    if (e.kind === 'aborted') throw e;
    if (e.kind === 'cors') {
      if (hs.mode === 'direct') { // it worked before, so treat this as a passing network problem
        const er = new ApiError('network', 'Network error talking to Roblox.', { host }); er.retryable = true; hs.fail++; throw er;
      }
      if (worker) { // fall back to the proxy for this host only
        hs.mode = 'proxy';
        toast(`${host}.roblox.com is blocked by the browser. Using your proxy Worker for it.`, 'warn', 'proxy-' + host);
        return fetchOnce(host, path, signal);
      }
      hs.mode = 'blocked';
    } else if (e.kind === 'proxy') {
      hs.mode = 'blocked';
    }
    hs.fail++;
    hs.lastError = e.message;
    if (e.kind === 'rate') hs.limited++;
    throw e;
  }
}

async function get(host, path, opts) {
  const { signal, priority = 1, ttl, cacheKey } = opts || {};
  if (cacheKey && ttl) { const c = cache.get(cacheKey, ttl); if (c !== undefined) return c; }
  for (let attempt = 0; ; attempt++) {
    try {
      const data = await queue.add(() => fetchOnce(host, path, signal), priority);
      if (cacheKey && ttl) cache.set(cacheKey, data);
      return data;
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (e.kind === 'aborted' || !e.retryable || attempt >= CONFIG.MAX_RETRIES) throw e;
      const backoff = Math.min(CONFIG.BACKOFF_MAX_MS, CONFIG.BACKOFF_BASE_MS * 2 ** attempt) + Math.random() * 400;
      const delay = e.retryAfterMs ? Math.max(e.retryAfterMs, 500) : backoff;
      if (e.kind === 'rate') { queue.pause(delay); toast('Roblox is rate limiting requests. Slowing down and retrying automatically.', 'warn', 'rate'); }
      await sleep(delay, signal);
    }
  }
}

function describeError(e) {
  if (!e) return 'Unknown error';
  const h = e.host ? `${e.host}.roblox.com` : 'Roblox';
  switch (e.kind) {
    case 'cors': return `The browser blocked the request to ${h}. This is almost always Roblox's CORS policy rejecting requests from other websites.`;
    case 'blocked': return `${h} is blocked by the browser (CORS). Requests to it were skipped.`;
    case 'proxy': return 'Your proxy Worker could not be reached. Check the address in Proxy settings.';
    case 'network': return 'Network error. Check your internet connection.';
    case 'rate': return `${h} is rate limiting requests (HTTP 429).`;
    case 'server': return `${h} returned a server error (HTTP ${e.status}).`;
    case 'http': return e.status === 404 ? 'Not found (HTTP 404). The user may not exist or be hidden.' : `${h} answered HTTP ${e.status}.`;
    case 'parse': return `${h} sent an unreadable response.`;
    default: return e.message || 'Unknown error';
  }
}

/* ================= State ================= */
const STAGES = [
  ['friends', 'Loading friends'],
  ['photos', 'Loading headshots'],
  ['profiles', 'Loading profiles'],
  ['followers', 'Counting followers'],
  ['avatars', 'Analyzing avatars'],
  ['prices', 'Pricing items'],
];
const state = {
  run: null,
  profile: null,
  friends: [],
  byId: new Map(),
  prices: new Map(),          // assetId -> { price, source, status }
  progress: {},
  failures: new Map(),        // key -> { stage, friendId?, assetId?, message }
  skippedDeleted: 0,
  sort: { key: 'followers', dir: 'desc' },
  query: '',
  visible: CONFIG.PAGE_SIZE,
  modalId: null,
  lastFocus: null,
  running: false,
  onlineKnown: false,
};
let runCounter = 0;

function resetProgress() {
  state.progress = {};
  for (const [k, label] of STAGES) state.progress[k] = { label, done: 0, total: 0, status: 'idle' };
}
resetProgress();

/* ================= Toasts ================= */
const toastKeys = new Map();
function toast(msg, kind, key) {
  const now = Date.now();
  if (key) { const last = toastKeys.get(key); if (last && now - last < 20000) return; toastKeys.set(key, now); }
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 9000 : 6000);
}

/* ================= Friend model ================= */
function makeFriend(raw) {
  const online = typeof raw.isOnline === 'boolean' ? raw.isOnline
    : typeof raw.presenceType === 'number' ? raw.presenceType > 0 : null;
  if (online !== null) state.onlineKnown = true;
  const created = raw.created ? new Date(raw.created) : null;
  return {
    id: Number(raw.id),
    username: raw.name || '',
    displayName: raw.displayName || '',
    description: '',
    online,
    created: created && !isNaN(created) ? created : null,
    headshot: '',
    followers: null, following: null, friendCount: null,
    items: null,            // equipped items, null until loaded
    av: null,               // summary { value, count, priced, top }
    st: { profiles: 'pending', followers: 'pending', avatars: 'pending', extra: 'idle', photos: 'pending' },
  };
}
const ageDays = (f) => (f.created ? Math.max(0, Math.floor((Date.now() - f.created.getTime()) / 86400000)) : null);

function summarizeAvatar(f) {
  if (!f.items) { f.av = null; return; }
  let value = 0, priced = 0, top = null;
  for (const it of f.items) {
    const p = state.prices.get(it.id);
    it.price = p && p.status === 'ok' && typeof p.price === 'number' ? p.price : null;
    it.source = p && p.status === 'ok' ? p.source : null;
    if (it.price != null) {
      value += it.price; priced++;
      if (!top || it.price > top.price) top = it;
    }
  }
  f.av = { value: priced ? value : null, count: f.items.length, priced, top };
}

/* ================= Pipeline ================= */
async function runStage(key, list, task) {
  const p = state.progress[key];
  p.total = list.length; p.done = 0; p.status = list.length ? 'active' : 'done';
  touch();
  await Promise.all(list.map(async (item) => {
    try { await task(item); }
    catch (e) {
      if (!(e instanceof ApiError) || e.kind !== 'aborted') recordFailure(key, item, e);
    } finally { p.done++; touch(); }
  }));
  if (state.run && !state.run.ctrl.signal.aborted) p.status = [...state.failures.values()].some((f) => f.stage === key) ? 'error' : 'done';
}

function recordFailure(stage, item, e) {
  const isAsset = stage === 'prices';
  const key = `${stage}:${isAsset ? item : item.id}`;
  state.failures.set(key, { stage, friendId: isAsset ? null : item.id, assetId: isAsset ? item : null, message: describeError(e) });
  if (!isAsset) { const f = item; if (f.st[stage] !== undefined) f.st[stage] = 'error'; }
  if (isAsset) { const cur = state.prices.get(item); if (!cur || cur.status !== 'ok') state.prices.set(item, { status: 'error' }); }
}

const tasks = {
  profiles: async (f) => {
    const u = await get('users', `/v1/users/${f.id}`, { signal: sig(), priority: 2, ttl: CONFIG.TTL.user, cacheKey: 'user:' + f.id });
    f.username = u.name || f.username;
    f.displayName = u.displayName || f.displayName;
    f.description = u.description || '';
    if (u.created) { const d = new Date(u.created); if (!isNaN(d)) f.created = d; }
    f.st.profiles = 'ok';
    state.failures.delete('profiles:' + f.id);
  },
  followers: async (f) => {
    const c = await get('friends', `/v1/users/${f.id}/followers/count`, { signal: sig(), priority: 2, ttl: CONFIG.TTL.counts, cacheKey: 'followers:' + f.id });
    f.followers = typeof c.count === 'number' ? c.count : null;
    f.st.followers = f.followers == null ? 'error' : 'ok';
    state.failures.delete('followers:' + f.id);
  },
  avatars: async (f) => {
    const a = await get('avatar', `/v1/users/${f.id}/avatar`, { signal: sig(), priority: 2, ttl: CONFIG.TTL.avatar, cacheKey: 'avatar:' + f.id });
    const assets = Array.isArray(a.assets) ? a.assets : [];
    f.items = assets.filter((x) => x && x.id != null).map((x) => ({ id: Number(x.id), name: x.name || 'Unnamed item', type: (x.assetType && x.assetType.name) || '' }));
    f.st.avatars = 'ok';
    state.failures.delete('avatars:' + f.id);
  },
  prices: async (id) => {
    const d = await get('economy', `/v2/assets/${id}/details`, { signal: sig(), priority: 2, ttl: CONFIG.TTL.asset, cacheKey: 'asset:' + id });
    state.prices.set(id, interpretPrice(d));
    state.failures.delete('prices:' + id);
  },
};
const sig = () => (state.run ? state.run.ctrl.signal : undefined);

/* Price rules: never invent a price. Collectibles use the lowest resale price if Roblox exposes it. */
function interpretPrice(d) {
  const out = { status: 'ok', price: null, source: 'Unavailable' };
  if (!d || typeof d !== 'object') return out;
  const c = d.CollectiblesItemDetails || d.collectiblesItemDetails;
  const resale = c && (c.CollectibleLowestResalePrice ?? c.collectibleLowestResalePrice);
  const isLimited = !!(d.IsLimited || d.IsLimitedUnique || c);
  if (isLimited && typeof resale === 'number') return { status: 'ok', price: resale, source: 'Lowest resale' };
  if (typeof d.PriceInRobux === 'number' && (d.IsForSale || d.PriceInRobux === 0)) {
    return { status: 'ok', price: d.PriceInRobux, source: d.PriceInRobux === 0 ? 'Free' : 'Sale price' };
  }
  return out;
}

async function loadHeadshots(list, signal) {
  const p = state.progress.photos;
  const ids = list.map((f) => f.id);
  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
  p.total = ids.length; p.done = 0; p.status = ids.length ? 'active' : 'done';
  await Promise.all(chunks.map(async (chunk) => {
    try {
      const r = await get('thumbnails', `/v1/users/avatar-headshot?userIds=${chunk.join(',')}&size=150x150&format=Png&isCircular=false`,
        { signal, priority: 1, ttl: CONFIG.TTL.thumb, cacheKey: 'thumb:' + chunk[0] + ':' + chunk.length });
      for (const t of r.data || []) {
        const f = state.byId.get(Number(t.targetId));
        if (f) { f.headshot = t.state === 'Completed' && t.imageUrl ? t.imageUrl : ''; f.st.photos = 'ok'; }
      }
    } catch (e) {
      if (e.kind !== 'aborted') for (const id of chunk) { const f = state.byId.get(id); if (f) f.st.photos = 'error'; }
      if (e.kind !== 'aborted') state.failures.set('photos:' + chunk[0], { stage: 'photos', message: describeError(e), chunk });
    } finally { p.done += chunk.length; touch(); }
  }));
  p.status = [...state.failures.values()].some((f) => f.stage === 'photos') ? 'error' : 'done';
}

function applyPrices(list) { for (const f of list) summarizeAvatar(f); }

async function priceStage() {
  const need = new Set();
  for (const f of state.friends) if (f.items) for (const it of f.items) { const p = state.prices.get(it.id); if (!p || p.status !== 'ok') need.add(it.id); }
  const ids = [...need];
  let n = 0;
  await runStage('prices', ids, async (id) => {
    await tasks.prices(id);
    if (++n % 20 === 0) applyPrices(state.friends);
  });
  applyPrices(state.friends);
}

async function startAnalysis(rawId) {
  const id = String(rawId || '').trim();
  if (!/^[0-9]{1,12}$/.test(id) || Number(id) <= 0) { showFatal('That is not a valid User ID', ['Roblox User IDs are numbers, for example 2968372123.']); return; }
  cancelRun(true);
  const run = { id: ++runCounter, ctrl: new AbortController() };
  state.run = run; state.running = true;
  resetProgress(); resetHostStates(true);
  state.profile = null; state.friends = []; state.byId = new Map(); state.failures = new Map();
  state.skippedDeleted = 0; state.onlineKnown = false; state.visible = CONFIG.PAGE_SIZE; state.modalId = null;
  closeModal(true);
  $('fatal').hidden = true; $('profileCard').hidden = true; $('stats').hidden = true; $('results').hidden = true;
  $('progress').hidden = false;
  $('analyzeBtn').disabled = true; $('cancelBtn').hidden = false;
  try { history.replaceState(null, '', '?id=' + id); } catch (e) { /* file:// etc */ }
  const signal = run.ctrl.signal;
  const alive = () => state.run === run && !signal.aborted;

  try {
    state.progress.friends.status = 'active'; touch();
    let profile;
    try { profile = await get('users', `/v1/users/${id}`, { signal, priority: 0, ttl: CONFIG.TTL.user, cacheKey: 'user:' + id }); }
    catch (e) { if (e.kind === 'aborted') return; return fatalFromError('Could not load that user', e, 'users'); }
    if (!alive()) return;
    state.profile = { id: Number(id), name: profile.name, displayName: profile.displayName, created: profile.created ? new Date(profile.created) : null, headshot: '' };
    touch();

    let total = null;
    try { total = (await get('friends', `/v1/users/${id}/friends/count`, { signal, priority: 0, ttl: CONFIG.TTL.counts, cacheKey: 'friendcount:' + id })).count; } catch (e) { if (e.kind === 'aborted') return; }

    const raw = []; const seenCursors = new Set(); let cursor = '';
    try {
      for (let page = 0; page < 200; page++) {
        const path = `/v1/users/${id}/friends` + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
        const r = await get('friends', path, { signal, priority: 0, ttl: CONFIG.TTL.friends, cacheKey: `friends:${id}:${cursor}` });
        const items = Array.isArray(r.data) ? r.data : Array.isArray(r.PageItems) ? r.PageItems : [];
        raw.push(...items);
        state.progress.friends.done = raw.length;
        state.progress.friends.total = Math.max(total || 0, raw.length);
        touch();
        cursor = r.nextPageCursor || r.NextCursor || '';
        if (!cursor || seenCursors.has(cursor)) break;
        seenCursors.add(cursor);
      }
    } catch (e) { if (e.kind === 'aborted') return; return fatalFromError('Could not load the friend list', e, 'friends'); }
    if (!alive()) return;

    for (const r of raw) {
      const fid = Number(r && r.id);
      if (!Number.isFinite(fid) || fid <= 0 || r.isDeleted) { state.skippedDeleted++; continue; }
      if (state.byId.has(fid)) continue;
      const f = makeFriend(r); state.byId.set(fid, f); state.friends.push(f);
    }
    state.progress.friends.done = state.friends.length;
    state.progress.friends.total = state.friends.length;
    state.progress.friends.status = 'done';
    $('results').hidden = false;
    touch();

    if (!state.friends.length) { for (const k of Object.keys(state.progress)) if (k !== 'friends') state.progress[k].status = 'done'; finish(run); return; }

    await loadHeadshots(state.friends, signal); if (!alive()) return;
    await runStage('profiles', state.friends, tasks.profiles); if (!alive()) return;
    await runStage('followers', state.friends, tasks.followers); if (!alive()) return;
    await runStage('avatars', state.friends, tasks.avatars); if (!alive()) return;
    await priceStage(); if (!alive()) return;
    finish(run);
  } finally {
    if (state.run === run) { state.running = false; $('analyzeBtn').disabled = false; $('cancelBtn').hidden = true; touch(true); }
  }
}

function finish(run) {
  if (state.run !== run) return;
  const failed = state.failures.size;
  toast(failed ? `Finished with ${failed} failed request${failed === 1 ? '' : 's'}. Use "Retry failed" to try them again.` : 'Analysis complete.', failed ? 'warn' : 'good');
}

function cancelRun(silent) {
  if (state.run) { state.run.ctrl.abort(); queue.clearPending(); }
  state.running = false;
  $('analyzeBtn').disabled = false; $('cancelBtn').hidden = true;
  for (const k of Object.keys(state.progress)) if (state.progress[k].status === 'active') state.progress[k].status = 'idle';
  if (!silent) { toast('Cancelled.', ''); touch(true); }
}

async function retryFailed() {
  if (state.running || !state.run) return;
  const run = { id: ++runCounter, ctrl: new AbortController() };
  state.run.ctrl.abort(); state.run = run; state.running = true;
  resetHostStates(false); // let blocked hosts try again (for example after adding a Worker)
  $('analyzeBtn').disabled = true; $('cancelBtn').hidden = false;
  const by = (stage) => [...state.failures.values()].filter((f) => f.stage === stage);
  try {
    const photoFails = by('photos');
    if (photoFails.length) { for (const f of photoFails) state.failures.delete('photos:' + f.chunk[0]); await loadHeadshots(photoFails.flatMap((f) => f.chunk.map((id) => state.byId.get(id)).filter(Boolean)), run.ctrl.signal); }
    for (const stage of ['profiles', 'followers', 'avatars']) {
      const list = by(stage).map((f) => state.byId.get(f.friendId)).filter(Boolean);
      if (!list.length) continue;
      for (const f of list) { state.failures.delete(`${stage}:${f.id}`); f.st[stage] = 'pending'; }
      await runStage(stage, list, tasks[stage]);
    }
    if (state.run === run) await priceStage();
  } finally {
    if (state.run === run) { state.running = false; $('analyzeBtn').disabled = false; $('cancelBtn').hidden = true; finish(run); touch(true); }
  }
}

/* ================= Fatal errors ================= */
function showFatal(title, lines) {
  const el = $('fatal');
  el.innerHTML = `<h2>${esc(title)}</h2>` + (lines || []).map((l) => `<p>${l}</p>`).join('');
  el.hidden = false; $('progress').hidden = true;
}
function fatalFromError(title, e, host) {
  state.progress.friends.status = 'error';
  const worker = getWorkerUrl();
  const lines = [esc(describeError(e))];
  if (e.kind === 'cors' || e.kind === 'blocked') {
    lines.push('<b>Nothing was loaded and no data is being made up.</b> To get past this, you need a tiny proxy that adds the missing CORS header:');
    lines.push('<ol><li>Deploy <code>worker.js</code> as a free Cloudflare Worker (steps are in the README).</li><li>Open <b>Proxy settings</b> at the bottom of this page, paste the Worker address and press Save.</li><li>Press Analyze again.</li></ol>');
    if (worker) lines.push('A Worker address is saved, but this host still failed. Re-check the address.');
    lines.push(`Blocked host: <code>${esc(host)}.roblox.com</code>`);
    $('settings').open = true;
  }
  showFatal(title, lines);
  state.running = false; $('analyzeBtn').disabled = false; $('cancelBtn').hidden = true;
  touch(true);
}

/* ================= Sorting / filtering ================= */
const BOARDS = [
  { label: 'Oldest account', key: 'created', dir: 'asc' },
  { label: 'Newest account', key: 'created', dir: 'desc' },
  { label: 'Most followers', key: 'followers', dir: 'desc' },
  { label: 'Least followers', key: 'followers', dir: 'asc' },
  { label: 'Avatar value', key: 'avatarValue', dir: 'desc' },
  { label: 'Username A-Z', key: 'username', dir: 'asc' },
  { label: 'Display name A-Z', key: 'displayName', dir: 'asc' },
];
function sortVal(f, key) {
  switch (key) {
    case 'created': return f.created ? f.created.getTime() : null;
    case 'followers': return f.followers;
    case 'avatarValue': return f.av ? f.av.value : null;
    case 'items': return f.av ? f.av.count : null;
    case 'username': return f.username ? f.username.toLowerCase() : null;
    case 'displayName': return f.displayName ? f.displayName.toLowerCase() : null;
    case 'id': return f.id;
    case 'online': return f.online == null ? null : f.online ? 1 : 0;
    default: return null;
  }
}
function compare(a, b) {
  const { key, dir } = state.sort;
  const va = sortVal(a, key), vb = sortVal(b, key);
  if (va == null && vb == null) return a.id - b.id;
  if (va == null) return 1;           // missing values always sink to the bottom
  if (vb == null) return -1;
  let r = typeof va === 'string' ? va.localeCompare(vb, undefined, { sensitivity: 'base' }) : va - vb;
  if (r === 0) return a.id - b.id;
  return dir === 'asc' ? r : -r;
}
function filtered() {
  const q = state.query.trim().toLowerCase();
  if (!q) return state.friends.slice();
  return state.friends.filter((f) => f.username.toLowerCase().includes(q) || f.displayName.toLowerCase().includes(q) || String(f.id).includes(q));
}
function setSort(key, dir) { state.sort = { key, dir }; state.visible = CONFIG.PAGE_SIZE; touch(true); }
const defaultDir = (key) => (['username', 'displayName', 'created', 'id'].includes(key) ? 'asc' : 'desc');

/* ================= Rendering ================= */
let renderTimer = null;
function touch(now) {
  if (now) { clearTimeout(renderTimer); renderTimer = null; renderAll(); return; }
  if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; renderAll(); }, CONFIG.RENDER_THROTTLE_MS);
}

function renderAll() {
  renderProgress(); renderProfile(); renderStats(); renderBoards(); renderTable(); renderHosts(); renderNotices();
  if (state.modalId != null) renderModal();
}

function renderProgress() {
  const el = $('progress');
  const rows = STAGES.filter(([k]) => state.progress[k].status !== 'idle');
  if (!rows.length || !state.run) { if (!$('fatal').hidden) el.hidden = true; return; }
  if ($('fatal').hidden) el.hidden = false;
  el.innerHTML = rows.map(([k]) => {
    const p = state.progress[k];
    const pct = p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : (p.status === 'done' ? 100 : 0);
    const text = p.total ? `${p.label}: ${p.done} / ${p.total}` : p.label;
    return `<div class="bar-row ${p.status}"><span class="lbl">${esc(text)}</span><div class="track" role="progressbar" aria-label="${esc(p.label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div class="fill" style="width:${pct}%"></div></div></div>`;
  }).join('');
}

function renderProfile() {
  const p = state.profile, el = $('profileCard');
  if (!p) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<div class="ph" aria-hidden="true"></div><div><h2>${esc(p.displayName || p.name)} <span class="muted">@${esc(p.name)}</span></h2><div class="sub">User ID ${p.id}${p.created ? ' &middot; Joined ' + esc(fmtDate(p.created)) : ''}</div></div>`;
}

function pickExtreme(list, valFn, wantMax) {
  let best = null, bv = null;
  for (const f of list) { const v = valFn(f); if (v == null) continue; if (bv == null || (wantMax ? v > bv : v < bv)) { best = f; bv = v; } }
  return best;
}
const nm = (f) => f.displayName || f.username || 'User ' + f.id;

function renderStats() {
  const el = $('stats'), fr = state.friends;
  if (!state.profile || !state.progress.friends.total && state.progress.friends.status !== 'done') { el.hidden = true; return; }
  el.hidden = false;
  const total = fr.length;
  const online = fr.filter((f) => f.online === true).length, offline = fr.filter((f) => f.online === false).length;
  const ages = fr.map(ageDays).filter((a) => a != null);
  const avgAge = ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : null;
  const oldest = pickExtreme(fr, (f) => (f.created ? f.created.getTime() : null), false);
  const newest = pickExtreme(fr, (f) => (f.created ? f.created.getTime() : null), true);
  const topFol = pickExtreme(fr, (f) => f.followers, true);
  const topVal = pickExtreme(fr, (f) => (f.av ? f.av.value : null), true);
  const profilesPending = state.progress.profiles.status === 'active' || state.progress.profiles.status === 'idle';
  const folPending = state.progress.followers.status !== 'done' && state.progress.followers.status !== 'error';
  const valPending = state.progress.prices.status !== 'done' && state.progress.prices.status !== 'error';
  const val = (v, pending) => (v != null ? v : pending && state.running ? '&hellip;' : 'Unavailable');
  const cards = [
    ['Total friends', total, state.skippedDeleted ? `${state.skippedDeleted} removed accounts skipped` : ' ', true],
    ['Online', state.onlineKnown ? online : 'Unavailable', state.onlineKnown ? '' : 'Roblox hides presence without a sign-in'],
    ['Offline', state.onlineKnown ? offline : 'Unavailable', ''],
    ['Avg. account age', val(fmtAge(avgAge), profilesPending), ages.length ? `${ages.length} accounts` : ''],
    ['Oldest friend', oldest ? esc(nm(oldest)) : val(null, profilesPending), oldest ? fmtAge(ageDays(oldest)) : ''],
    ['Newest friend', newest ? esc(nm(newest)) : val(null, profilesPending), newest ? fmtAge(ageDays(newest)) : ''],
    ['Most followers', topFol ? esc(nm(topFol)) : val(null, folPending), topFol ? fmtNum(topFol.followers) + ' followers' : ''],
    ['Highest avatar value', topVal ? esc(nm(topVal)) : val(null, valPending), topVal ? fmtRobux(topVal.av.value) + ' (estimated)' : ''],
  ];
  el.innerHTML = cards.map(([k, v, s, accent]) => `<div class="stat ${accent ? 'accent' : ''}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s || '&nbsp;'}</div></div>`).join('');
}

function renderBoards() {
  const chips = $('chips');
  if (!chips.dataset.built) {
    chips.innerHTML = BOARDS.map((b, i) => `<button type="button" class="chip" data-board="${i}" aria-pressed="false">${b.label}</button>`).join('');
    chips.dataset.built = '1';
  }
  const { key, dir } = state.sort;
  chips.querySelectorAll('.chip').forEach((c) => { const b = BOARDS[c.dataset.board]; c.setAttribute('aria-pressed', String(b.key === key && b.dir === dir)); });
  $('dirBtn').textContent = dir === 'asc' ? 'Ascending' : 'Descending';
  document.querySelectorAll('#table th[data-sort]').forEach((th) => {
    const active = th.dataset.sort === key;
    if (active) th.setAttribute('aria-sort', dir === 'asc' ? 'ascending' : 'descending'); else th.removeAttribute('aria-sort');
  });
}

function stateCell(st, value, fmt, failed) {
  if (value != null) return fmt ? fmt(value) : esc(value);
  if (st === 'pending' && state.running) return PENDING;
  return NA;
}

function avatarCell(f) {
  if (f.av && f.av.value != null) return `${fmtRobux(f.av.value)}${f.av.priced < f.av.count ? `<span class="cell-sub">${f.av.priced}/${f.av.count} priced</span>` : ''}`;
  if (f.av) return NA;
  return f.st.avatars === 'pending' && state.running ? PENDING : NA;
}

function headshotImg(f, cls) {
  return f.headshot ? `<img src="${esc(f.headshot)}" alt="" width="38" height="38" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '<span class="ph" aria-hidden="true"></span>';
}

function rowHtml(f, rank) {
  const age = ageDays(f);
  const status = f.online == null ? NA : f.online ? '<span class="badge on">Online</span>' : '<span class="badge off">Offline</span>';
  return `<tr data-id="${f.id}" tabindex="0" role="button" aria-label="Open details for ${esc(nm(f))}">
    <td class="rank">${rank}</td>
    <td><div class="person">${headshotImg(f)}<div class="pn"><b>${esc(nm(f))}</b><small>${f.username ? '@' + esc(f.username) : 'ID ' + f.id}</small></div></div></td>
    <td class="hide-sm mono">${f.id}</td>
    <td class="hide-sm">${status}</td>
    <td class="hide-sm">${stateCell(f.st.profiles, f.created, fmtDate)}</td>
    <td class="hide-sm nowrap">${stateCell(f.st.profiles, age, fmtAge)}</td>
    <td class="num">${stateCell(f.st.followers, f.followers, fmtNum)}</td>
    <td class="num">${avatarCell(f)}</td>
    <td class="num hide-sm">${f.av ? f.av.count : stateCell(f.st.avatars, null)}</td>
  </tr>`;
}

function renderTable() {
  if ($('results').hidden) return;
  const list = filtered().sort(compare);
  const shown = list.slice(0, state.visible);
  $('tbody').innerHTML = shown.map((f, i) => rowHtml(f, i + 1)).join('');
  const total = state.friends.length;
  $('countLine').textContent = total ? (list.length === total ? `${total} friends` : `${list.length} of ${total} friends match`) : '';
  const more = $('moreBtn');
  more.hidden = list.length <= state.visible;
  if (!more.hidden) more.textContent = `Show more (${list.length - state.visible} left)`;
  const empty = $('emptyState');
  if (!total) {
    empty.hidden = state.progress.friends.status !== 'done';
    empty.textContent = 'This user has no public friends to analyze (the list may be empty or hidden).';
  } else if (!list.length) { empty.hidden = false; empty.textContent = 'No friends match your search.'; }
  else empty.hidden = true;
  $('table').hidden = !total;
}

function renderHosts() {
  const labels = {
    unknown: ['', 'Not used yet'], direct: ['ok', 'Direct, working'], proxy: ['proxy', 'Working through your proxy'], blocked: ['bad', 'Blocked by browser (CORS)'],
  };
  $('hosts').innerHTML = Object.entries(HOSTS).map(([h, info]) => {
    const s = hostState[h]; const [cls, text] = labels[s.mode];
    const extra = [s.ok ? `${s.ok} ok` : '', s.fail ? `${s.fail} failed` : '', s.limited ? `${s.limited} rate limited` : ''].filter(Boolean).join(', ');
    return `<li><div class="hn">${h}.roblox.com</div><div class="hp">${esc(info.purpose)}</div><div class="hs"><span class="dot ${cls}"></span>${text}${extra ? ' &middot; ' + extra : ''}</div></li>`;
  }).join('');
  const failed = state.failures.size;
  $('retryBtn').hidden = !failed || state.running;
  $('retryBtn').textContent = `Retry failed (${failed})`;
}

function renderNotices() {
  const el = $('notices'); const out = [];
  const blocked = Object.entries(hostState).filter(([, s]) => s.mode === 'blocked').map(([h]) => h);
  if (blocked.length && $('fatal').hidden) {
    out.push(`<div class="notice bad"><b>Blocked by the browser:</b> ${blocked.map((h) => `<code>${h}.roblox.com</code>`).join(', ')}. Data that depends on ${blocked.length === 1 ? 'it' : 'them'} shows as Unavailable. Add a proxy Worker in Proxy settings below, then press Retry failed.</div>`);
  }
  const counts = {};
  for (const f of state.failures.values()) counts[f.stage] = (counts[f.stage] || 0) + 1;
  const parts = Object.entries(counts).map(([k, n]) => `${n} ${k}`);
  if (parts.length && !state.running) {
    const sample = [...state.failures.values()][0].message;
    out.push(`<div class="notice warn"><b>Some requests failed:</b> ${esc(parts.join(', '))}. Example: ${esc(sample)} Failed items show as Unavailable and nothing was guessed.</div>`);
  }
  el.innerHTML = out.join('');
}

/* ================= Modal ================= */
function openModal(id) {
  const f = state.byId.get(id); if (!f) return;
  state.modalId = id; state.lastFocus = document.activeElement;
  $('modal').hidden = false; renderModal();
  document.body.style.overflow = 'hidden';
  $('modal').querySelector('.modal-card').focus();
  loadExtras(f);
}
function closeModal(silent) {
  if (state.modalId == null && $('modal').hidden) return;
  state.modalId = null; $('modal').hidden = true; document.body.style.overflow = '';
  if (!silent && state.lastFocus && state.lastFocus.focus) { try { state.lastFocus.focus(); } catch (e) { /* ignore */ } }
}
async function loadExtras(f) {
  if (!state.run) return;
  const signal = sig();
  const jobs = [];
  if (f.following == null) jobs.push(get('friends', `/v1/users/${f.id}/followings/count`, { signal, priority: 0, ttl: CONFIG.TTL.counts, cacheKey: 'following:' + f.id }).then((r) => { f.following = typeof r.count === 'number' ? r.count : null; }));
  if (f.friendCount == null) jobs.push(get('friends', `/v1/users/${f.id}/friends/count`, { signal, priority: 0, ttl: CONFIG.TTL.counts, cacheKey: 'friendcount:' + f.id }).then((r) => { f.friendCount = typeof r.count === 'number' ? r.count : null; }));
  if (f.followers == null && f.st.followers !== 'pending') jobs.push(tasks.followers(f));
  if (f.st.profiles === 'error') jobs.push(tasks.profiles(f));
  if (!f.items && f.st.avatars !== 'pending') {
    jobs.push(tasks.avatars(f).then(async () => {
      const ids = (f.items || []).map((i) => i.id).filter((i) => { const p = state.prices.get(i); return !p || p.status !== 'ok'; });
      await Promise.all(ids.map((i) => tasks.prices(i).catch(() => state.prices.set(i, { status: 'error' }))));
      summarizeAvatar(f);
    }));
  }
  f.st.extra = 'loading'; renderModal();
  await Promise.allSettled(jobs);
  f.st.extra = 'done';
  if (state.modalId === f.id) renderModal();
  touch();
}
function renderModal() {
  const f = state.byId.get(state.modalId); if (!f) return;
  const age = ageDays(f);
  const loading = f.st.extra === 'loading';
  const val = (v, fmt) => (v != null ? (fmt ? fmt(v) : esc(v)) : loading ? PENDING : NA);
  const itemsHtml = !f.items
    ? `<p class="muted">${f.st.avatars === 'error' ? 'Equipped items could not be loaded.' : 'Loading equipped items&hellip;'}</p>`
    : f.items.length === 0 ? '<p class="muted">No equipped items were returned.</p>'
      : `<table class="items"><thead><tr><th>Item</th><th class="hide-xs">Item ID</th><th class="num">Price</th></tr></thead><tbody>${
        f.items.slice().sort((a, b) => (b.price ?? -1) - (a.price ?? -1)).map((it) => `<tr>
          <td><a href="https://www.roblox.com/catalog/${it.id}" target="_blank" rel="noopener noreferrer">${esc(it.name)}</a>${it.type ? `<span class="cell-sub">${esc(it.type)}</span>` : ''}</td>
          <td class="hide-xs mono">${it.id}</td>
          <td class="num">${it.price != null ? (it.price === 0 ? 'Free' : fmtRobux(it.price)) + (it.source && it.source !== 'Sale price' && it.source !== 'Free' ? `<span class="cell-sub">${esc(it.source)}</span>` : '') : NA}</td></tr>`).join('')}</tbody></table>`;
  const top = f.av && f.av.top;
  $('modalBody').innerHTML = `
    <div class="m-head">${f.headshot ? `<img src="${esc(f.headshot)}" alt="" width="84" height="84" referrerpolicy="no-referrer">` : '<span class="ph" aria-hidden="true"></span>'}
      <div><h2 id="modalTitle">${esc(nm(f))}</h2><div class="muted">${f.username ? '@' + esc(f.username) : ''} &middot; ID ${f.id}</div></div></div>
    ${f.description ? `<p class="m-desc">${esc(f.description.slice(0, 600))}</p>` : '<div style="height:8px"></div>'}
    <div class="m-grid">
      <div class="stat"><div class="k">Created</div><div class="v">${val(f.created, fmtDate)}</div></div>
      <div class="stat"><div class="k">Account age</div><div class="v">${val(age, fmtAge)}</div></div>
      <div class="stat"><div class="k">Status</div><div class="v">${f.online == null ? 'Unavailable' : f.online ? 'Online' : 'Offline'}</div></div>
      <div class="stat"><div class="k">Followers</div><div class="v">${val(f.followers, fmtNum)}</div></div>
      <div class="stat"><div class="k">Following</div><div class="v">${val(f.following, fmtNum)}</div></div>
      <div class="stat"><div class="k">Friends</div><div class="v">${val(f.friendCount, fmtNum)}</div></div>
    </div>
    <div class="m-sec"><h3>Equipped avatar</h3><span class="note">Estimated current value, not inventory wealth</span></div>
    <div class="m-grid">
      <div class="stat accent"><div class="k">Estimated value</div><div class="v">${f.av && f.av.value != null ? fmtRobux(f.av.value) : f.items ? 'Unavailable' : PENDING}</div><div class="s">${f.av ? `${f.av.priced} of ${f.av.count} items priced` : ' '}</div></div>
      <div class="stat"><div class="k">Equipped items</div><div class="v">${f.av ? f.av.count : PENDING}</div></div>
      <div class="stat"><div class="k">Highest item</div><div class="v">${top ? fmtRobux(top.price) : f.av ? 'Unavailable' : PENDING}</div><div class="s">${top ? esc(top.name) : ' '}</div></div>
    </div>
    ${itemsHtml}
    <div class="m-actions"><a class="btn primary link" href="https://www.roblox.com/users/${f.id}/profile" target="_blank" rel="noopener noreferrer">Open Roblox profile</a><button type="button" class="btn" data-close>Close</button></div>`;
}

/* ================= Connection check / settings ================= */
async function checkConnection() {
  const id = state.profile ? state.profile.id : ($('userId').value.trim() || CONFIG.DEFAULT_USER_ID);
  $('checkBtn').disabled = true;
  const ctrl = new AbortController();
  const probes = [
    ['users', `/v1/users/${id}`], ['friends', `/v1/users/${id}/friends/count`],
    ['thumbnails', `/v1/users/avatar-headshot?userIds=${id}&size=150x150&format=Png&isCircular=false`], ['avatar', `/v1/users/${id}/avatar`],
  ];
  const saved = state.run; state.run = { id: -1, ctrl };
  resetHostStates(false);
  await Promise.allSettled(probes.map(([h, p]) => get(h, p, { signal: ctrl.signal, priority: 0 })));
  state.run = saved; $('checkBtn').disabled = false;
  const bad = probes.filter(([h]) => hostState[h].mode === 'blocked').map(([h]) => h);
  toast(bad.length ? `Blocked by the browser: ${bad.join(', ')}. See Proxy settings.` : 'Connection check passed for users, friends, thumbnails and avatar. Prices are checked on first use.', bad.length ? 'bad' : 'good');
  touch(true);
}

/* ================= Wiring ================= */
function wire() {
  const params = new URLSearchParams(location.search);
  $('userId').value = /^[0-9]{1,12}$/.test(params.get('id') || '') ? params.get('id') : CONFIG.DEFAULT_USER_ID;
  $('workerUrl').value = getWorkerUrl();

  $('lookup').addEventListener('submit', (e) => { e.preventDefault(); startAnalysis($('userId').value); });
  $('cancelBtn').addEventListener('click', () => cancelRun(false));
  $('retryBtn').addEventListener('click', retryFailed);
  $('checkBtn').addEventListener('click', checkConnection);
  $('clearCacheBtn').addEventListener('click', () => { cache.clear(); toast('Cache cleared.', 'good'); });

  let st = null;
  $('search').addEventListener('input', (e) => { clearTimeout(st); st = setTimeout(() => { state.query = e.target.value; state.visible = CONFIG.PAGE_SIZE; touch(true); }, 80); });
  $('chips').addEventListener('click', (e) => { const b = e.target.closest('.chip'); if (b) { const d = BOARDS[b.dataset.board]; setSort(d.key, d.dir); } });
  $('dirBtn').addEventListener('click', () => setSort(state.sort.key, state.sort.dir === 'asc' ? 'desc' : 'asc'));
  $('table').querySelector('thead').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]'); if (!th) return;
    const key = th.dataset.sort;
    setSort(key, state.sort.key === key ? (state.sort.dir === 'asc' ? 'desc' : 'asc') : defaultDir(key));
  });
  $('moreBtn').addEventListener('click', () => { state.visible += CONFIG.PAGE_SIZE; touch(true); });

  $('tbody').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) openModal(Number(tr.dataset.id)); });
  $('tbody').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { const tr = e.target.closest('tr[data-id]'); if (tr) { e.preventDefault(); openModal(Number(tr.dataset.id)); } } });
  $('modal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.modalId != null) closeModal(); });

  $('workerForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('workerUrl').value.trim().replace(/\/+$/, '');
    if (v && !/^https:\/\//i.test(v) && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(v)) { toast('The Worker address must start with https://', 'bad'); return; }
    if (v) lsSet('rfa:worker', v); else lsDel('rfa:worker');
    resetHostStates(false); toast(v ? 'Proxy saved. Press Analyze or Retry failed.' : 'Proxy removed.', 'good'); touch(true);
  });
  $('workerClear').addEventListener('click', () => { lsDel('rfa:worker'); $('workerUrl').value = ''; resetHostStates(false); toast('Proxy removed.', 'good'); touch(true); });

  window.addEventListener('offline', () => toast('You are offline. Requests will retry when you reconnect.', 'warn', 'offline'));
  renderHosts(); renderBoards();
  startAnalysis($('userId').value);
}
document.addEventListener('DOMContentLoaded', wire);

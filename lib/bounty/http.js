// scopedFetch — điểm duy nhất bounty engine được phép gọi network.
// Pipeline: scope guard (§2) → port check (§4) → rate limit 2 rps/host → fetch → audit log.
// Request ra ngoài scope bị từ chối TRƯỚC khi gọi fetch (throw, không emit traffic).
const fs = require('fs');
const path = require('path');
const { isInScope } = require('../scope');
const ratelimit = require('./ratelimit');

const { dataPath, CONFIG_FILE } = require('../paths');
const REPORTS_DIR = dataPath('reports');
const AUDIT_LOG = path.join(REPORTS_DIR, 'audit.jsonl');
const MAX_BODY_LOG = 2048; // audit chỉ giữ đầu request/response, tránh nhồi secrets

function ensureDir() {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function auditEntry(entry) {
  ensureDir();
  fs.appendFileSync(AUDIT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

class OutOfScopeError extends Error {
  constructor(url) {
    super(`OUT-OF-SCOPE: ${url} không nằm trong doc §2 — request bị chặn`);
    this.code = 'OOS';
  }
}

// Truncate body để log; không log Authorization header value (chỉ ghi có/không).
function redactHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = /authorization|cookie|token/i.test(k) ? '[REDACTED]' : v;
  }
  return out;
}

// options: { rps?, timeoutMs?, auditTag? } + fetch options chuẩn.
async function scopedFetch(url, options = {}) {
  if (!isInScope(url)) {
    auditEntry({ url: String(url), blocked: true, reason: 'out-of-scope', tag: options.auditTag });
    throw new OutOfScopeError(url);
  }
  const { rps, timeoutMs = 15000, auditTag, ...fetchOpts } = options;
  const host = new URL(url).hostname;
  // §4: mặc định 2rps; farmMode (BTC-authorized) nới lên farmMaxRpsPerHost
  let effectiveRps = rps;
  if (!effectiveRps) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      effectiveRps = cfg.farmMode ? (cfg.farmMaxRpsPerHost || 20) : (cfg.rpsPerHost || 2);
    } catch (e) { effectiveRps = 2; }
  }
  const waitedMs = await ratelimit.acquire(host, effectiveRps);

  const res = await fetch(url, {
    redirect: 'follow',
    ...fetchOpts,
    signal: AbortSignal.timeout(timeoutMs)
  });

  const clone = res.clone();
  let bodyPreview = '';
  try { bodyPreview = (await clone.text()).slice(0, MAX_BODY_LOG); } catch (e) {}

  auditEntry({
    tag: auditTag,
    url: res.url,
    method: fetchOpts.method || 'GET',
    reqHeaders: redactHeaders(fetchOpts.headers),
    status: res.status,
    waitedMs,
    bodyPreview
  });
  return res;
}

// Burst helper cho race-condition probe (§4 cho phép PoC trên tài khoản mình):
// mỗi request vẫn qua acquire() — rate limit vẫn enforce; concurrency chỉ là
// số request được chuẩn bị sẵn, không bypass limiter.
async function scopedFetchAll(urls, options = {}) {
  return Promise.all(urls.map(u => scopedFetch(u, options).then(
    async r => ({ ok: true, url: u, status: r.status, body: (await r.text()).slice(0, MAX_BODY_LOG) }),
    err => ({ ok: false, url: u, error: err.message, code: err.code })
  )));
}
// Fetch qua HTTP CONNECT proxy (undici ProxyAgent) — farm dùng để đổi IP theo account.
// Vẫn enforce scope §2; không có proxy / socks5 → rớt về scopedFetch.
// Trả shape tối thiểu giống fetch Response: { status, ok, text(), json() }.
async function proxiedFetch(url, { method = 'GET', headers = {}, body, proxy = null, timeoutMs = 15000, auditTag } = {}) {
  if (!isInScope(url)) { auditEntry({ url: String(url), blocked: true, reason: 'out-of-scope', tag: auditTag }); throw new OutOfScopeError(url); }
  if (!proxy || /^socks/i.test(proxy.server || '')) return scopedFetch(url, { method, headers, body, timeoutMs, auditTag });
  const { request, ProxyAgent } = require('undici');
  const auth = proxy.username ? `${proxy.username}:${proxy.password}` : null;
  const dispatcher = new ProxyAgent({ uri: proxy.server, connectTimeout: 8000, ...(auth ? { token: `Basic ${Buffer.from(auth).toString('base64')}` } : {}) });
  const t0 = Date.now();
  const req = request(url, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body,
    dispatcher, headersTimeout: timeoutMs, bodyTimeout: timeoutMs
  }).then(async r => {
    const text = await r.body.text();
    return { status: r.statusCode, ok: r.statusCode >= 200 && r.statusCode < 300, text: () => Promise.resolve(text), json: () => Promise.resolve(JSON.parse(text)) };
  });
  // undici AbortSignal không abort CONNECT hang qua ProxyAgent → race hard-deadline
  const res = await Promise.race([req, new Promise((_, rej) => setTimeout(() => rej(new Error(`proxy timeout ${timeoutMs}ms`)), timeoutMs + 2000))]);
  auditEntry({ tag: auditTag || 'farm:proxy', url, method, status: res.status, waitedMs: Date.now() - t0, via: proxy.server, bodyPreview: (res.bodyPreview || '').slice(0, 512) });
  return res;
}

module.exports = { scopedFetch, scopedFetchAll, proxiedFetch, auditEntry, OutOfScopeError, REPORTS_DIR, AUDIT_LOG };

// Active probes — chỉ gọi khi bounty.config.json { authorized: true }.
// Mọi request qua scopedFetch: scope §2 + 2 rps/host + audit log. Không có code path nào bypass.
// Theo RoE: PoC tối thiểu trên tài khoản của chính mình (§4), cấm exfil/sửa/xóa dữ liệu (§5).
const fs = require('fs');
const path = require('path');
const { scopedFetch, scopedFetchAll } = require('./http');
const { getSite, SITES } = require('../sites');
const { getSession, listAccounts, ensureValidToken } = require('../auth');
const report = require('./report');

const { CONFIG_FILE } = require('../paths');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { return { authorized: false }; }
}
function requireAuthorized() {
  const cfg = loadConfig();
  if (!cfg.authorized) {
    const err = new Error('Active probe bị khóa: bounty.config.json chưa có authorized=true (doc chưa được bên vận hành chấp nhận)');
    err.code = 'NOT_AUTHORIZED';
    throw err;
  }
  return cfg;
}

// ---------- 1) Security headers + CORS ----------
async function probeHeaders(siteId) {
  requireAuthorized();
  const site = getSite(siteId);
  const tag = `probe:headers:${siteId}`;
  const targets = [
    { url: site.origin + '/', kind: 'frontend' },
    { url: site.apiBase + '/livestreams', kind: 'api' }
  ];
  const results = [];
  for (const t of targets) {
    const findings = [];
    try {
      const res = await scopedFetch(t.url, { auditTag: tag });
      const h = res.headers;
      if (t.kind === 'frontend') {
        if (!h.get('content-security-policy')) findings.push('Thiếu Content-Security-Policy');
        if (!h.get('x-frame-options') && !/frame-ancestors/i.test(h.get('content-security-policy') || '')) findings.push('Thiếu X-Frame-Options/frame-ancestors → clickjacking');
        if (!h.get('x-content-type-options')) findings.push('Thiếu X-Content-Type-Options: nosniff');
        if (!h.get('referrer-policy')) findings.push('Thiếu Referrer-Policy');
      }
      if (!h.get('strict-transport-security')) findings.push('Thiếu Strict-Transport-Security');
      const server = h.get('server'), poweredBy = h.get('x-powered-by');
      if (poweredBy) findings.push(`X-Powered-By lộ: ${poweredBy}`);
      results.push({ url: t.url, status: res.status, headers: Object.fromEntries(h.entries()), missing: findings });
    } catch (e) {
      results.push({ url: t.url, error: e.message });
    }

    // CORS: Origin độc hại phải bị từ chối / không reflect
    try {
      const evilOrigin = 'https://evil.example.com';
      const res = await scopedFetch(t.url, {
        auditTag: tag,
        headers: { Origin: evilOrigin }
      });
      const acao = res.headers.get('access-control-allow-origin');
      const acac = res.headers.get('access-control-allow-credentials');
      if (acao === '*' && acac === 'true') {
        findings.push(`CORS: ACAO=* với credentials=true`);
        report.createFinding({ title: `CORS wildcard + credentials trên ${t.url}`, severity: 'medium', siteId, asset: t.url, description: `ACAO: * kèm Access-Control-Allow-Credentials: true`, evidence: `Origin: ${evilOrigin}\nACAO: ${acao}\nACAC: ${acac}`, impact: 'Trang độc hại có thể đọc response có credential của victim.', probe: 'headers' });
      } else if (acao === evilOrigin) {
        const sev = acac === 'true' ? 'high' : 'low';
        report.createFinding({ title: `CORS reflect origin tùy ý trên ${t.url}`, severity: sev, siteId, asset: t.url, description: `Server reflect Origin bất kỳ vào ACAO (credentials=${acac})`, evidence: `Origin: ${evilOrigin} → ACAO: ${acao}`, impact: 'Cross-origin read response của victim nếu kèm credentials.', probe: 'headers' });
      }
      results[results.length - 1].cors = { testedOrigin: evilOrigin, acao, acac };
    } catch (e) {
      results[results.length - 1].corsError = e.message;
    }
  }
  return results;
}

// ---------- 2) Exposed paths (wordlist nhỏ, 2 rps — không phải fuzzing ồ ạt) ----------
const EXPOSED_PATHS = [
  '/.git/HEAD', '/.env', '/.env.production', '/config.json', '/swagger.json',
  '/swagger/index.html', '/api-docs', '/openapi.json', '/debug', '/health',
  '/metrics', '/server-status', '/robots.txt', '/sitemap.xml', '/.well-known/security.txt'
];
async function probeExposed(siteId) {
  requireAuthorized();
  const site = getSite(siteId);
  const tag = `probe:exposed:${siteId}`;
  const hits = [];
  for (const base of [site.origin, site.apiBase.replace(/\/api$/, '')]) {
    // Baseline: SPA host trả index.html cho mọi route → so sánh body với "/" để loại fallback
    let baselineBody = null;
    try {
      const bres = await scopedFetch(base + '/', { auditTag: tag });
      baselineBody = await bres.text();
    } catch (e) {}
    for (const p of EXPOSED_PATHS) {
      const url = base + p;
      try {
        const res = await scopedFetch(url, { auditTag: tag });
        const body = (await res.text()).slice(0, 20000);
        const sensitive = /\.git|\.env|swagger|openapi|debug|metrics/.test(p);
        const isFallback = baselineBody !== null && body === baselineBody;
        if (res.status === 200 && !isFallback) {
          hits.push({ url, status: res.status, bodyPreview: body.slice(0, 200), sensitive });
          if (sensitive) {
            report.createFinding({
              title: `Lộ ${p} trên ${new URL(base).hostname}`, severity: /\.git|\.env/.test(p) ? 'high' : 'low',
              siteId, asset: url, description: `GET ${url} → 200, không phải SPA fallback`,
              evidence: body.slice(0, 300), impact: 'Lộ cấu hình/bí mật/metadata API cho attacker.',
              probe: 'exposed'
            });
          }
        } else if ([401, 403].includes(res.status) && sensitive) {
          hits.push({ url, status: res.status, bodyPreview: body.slice(0, 200), sensitive: true, protected: true });
        }
      } catch (e) { /* network error → bỏ qua, audit log đã ghi */ }
    }
  }
  return hits;
}

// ---------- 3) JWT/session audit (offline — không gửi request) ----------
function auditJwt(username, siteId) {
  requireAuthorized();
  const sess = getSession(username, siteId);
  if (!sess || !sess.token) return { username, siteId, error: 'không có session/token' };
  const issues = [];
  const parts = sess.token.split('.');
  if (parts.length !== 3) issues.push('Token không phải JWT 3 phần');
  let header = {}, payload = {};
  try { header = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); } catch (e) {}
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); } catch (e) {}
  const now = Math.floor(Date.now() / 1000);
  if (header.alg === 'none') issues.push({ sev: 'critical', msg: 'JWT alg=none' });
  if (/^HS/.test(header.alg || '')) issues.push({ sev: 'low', msg: `JWT dùng ${header.alg} (symmetric — kiểm tra secret yếu phía server)` });
  if (!payload.exp) issues.push({ sev: 'medium', msg: 'JWT không có exp' });
  else {
    const ttlMin = Math.round((payload.exp - (payload.iat || now)) / 60);
    if (payload.exp < now) issues.push({ sev: 'info', msg: `Token đã hết hạn (${new Date(payload.exp * 1000).toISOString()}) — kiểm tra server có từ chối không` });
    if (ttlMin > 24 * 60) issues.push({ sev: 'medium', msg: `JWT TTL ${ttlMin} phút (>24h)` });
  }
  const sensitiveClaims = Object.keys(payload).filter(k => /pass|pwd|secret|phone|email|bank/i.test(k));
  if (sensitiveClaims.length) issues.push({ sev: 'high', msg: `JWT chứa claim nhạy cảm: ${sensitiveClaims.join(', ')}` });
  const result = {
    username, siteId,
    header: { alg: header.alg, typ: header.typ },
    claims: Object.keys(payload),
    exp: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
    expired: payload.exp ? payload.exp < now : null,
    userId: sess.userId || payload.sub || null,
    hasRefreshToken: !!sess.refreshToken,
    refreshTokenLength: sess.refreshToken ? sess.refreshToken.length : 0,
    issues
  };
  for (const i of issues.filter(i => typeof i === 'object' && ['critical', 'high', 'medium'].includes(i.sev))) {
    report.createFinding({ title: `JWT: ${i.msg} (${siteId}/${username})`, severity: i.sev, siteId, asset: getSite(siteId).apiBase, description: i.msg, evidence: `header=${JSON.stringify(result.header)} claims=${result.claims.join(',')}`, impact: 'Token/session weakness.', probe: 'jwt' });
  }
  return result;
}

// ---------- 4) Cross-site token: token site A dùng cho API site B ----------
// Cùng nền tảng (sites.js ghi "API giống nhau") → nếu token A hợp lệ trên B là
// broken tenant isolation = phải kiểm tra dữ liệu có thật sự bị lộ không.
async function probeCrossSiteToken(username, fromSiteId, toSiteId) {
  requireAuthorized();
  const sess = getSession(username, fromSiteId);
  if (!sess || !sess.token) return { error: `không có session ${username}@${fromSiteId}` };
  const toSite = getSite(toSiteId);
  const res = await scopedFetch(`${toSite.apiBase}/account/me`, {
    auditTag: `probe:crosstoken:${fromSiteId}->${toSiteId}`,
    headers: { Authorization: `Bearer ${sess.token}` }
  });
  const body = (await res.text()).slice(0, 800);
  const accepted = res.status === 200 && !/unauthorized|invalid/i.test(body);
  const r = { fromSiteId, toSiteId, url: `${toSite.apiBase}/account/me`, status: res.status, accepted, body };
  if (accepted) {
    report.createFinding({
      title: `Token ${fromSiteId} được chấp nhận bởi API ${toSiteId}`, severity: 'high',
      siteId: toSiteId, asset: `${toSite.apiBase}/account/me`,
      description: 'Cùng nền tảng nhưng tenant khác nhau chấp nhận token của nhau → thiếu tenant isolation.',
      steps: [`Lấy token của ${username}@${fromSiteId}`, `GET ${toSite.apiBase}/account/me với Bearer token đó`],
      evidence: `status=${res.status}\nbody=${body.slice(0, 400)}`,
      impact: 'Tài khoản một brand có thể đọc/thao tác API brand khác nếu identity map giống nhau.',
      probe: 'crosstoken'
    });
  }
  return r;
}

// ---------- 5) IDOR: replay /account/me (và endpoint có userId) bằng token account B ----------
// Cần 2 tài khoản test (doc §4: ưu tiên account test tự tạo, prefix bb_).
async function probeIdor(siteId, usernameA, usernameB) {
  requireAuthorized();
  const site = getSite(siteId);
  const [sessA, sessB] = [getSession(usernameA, siteId), getSession(usernameB, siteId)];
  if (!sessA || !sessB) return { error: 'cần 2 session hợp lệ cùng site', have: { [usernameA]: !!sessA, [usernameB]: !!sessB } };
  const tag = `probe:idor:${siteId}`;
  const results = [];

  // /account/me với token B: phải trả dữ liệu của B — sanity check endpoint
  const meB = await scopedFetch(`${site.apiBase}/account/me`, {
    auditTag: tag, headers: { Authorization: `Bearer ${sessB.token}` }
  });
  const meBBody = (await meB.text()).slice(0, 800);
  results.push({ step: 'account/me với token B', status: meB.status, body: meBBody.slice(0, 300) });

  // Nếu API có endpoint theo userId (GET /account/{userId}...) thử đọc profile A bằng token B
  if (sessA.userId) {
    const candidates = [`/account/${sessA.userId}`, `/account/profile/${sessA.userId}`, `/users/${sessA.userId}`];
    for (const p of candidates) {
      try {
        const res = await scopedFetch(`${site.apiBase}${p}`, {
          auditTag: tag, headers: { Authorization: `Bearer ${sessB.token}` }
        });
        const body = (await res.text()).slice(0, 800);
        const leakedA = res.status === 200 && (body.includes(usernameA) || body.includes(sessA.userId));
        results.push({ step: `GET ${p} (token B)`, status: res.status, leakedA, body: body.slice(0, 300) });
        if (leakedA) {
          report.createFinding({
            title: `IDOR: token ${usernameB} đọc được dữ liệu ${usernameA} qua ${p}`, severity: 'high',
            siteId, asset: `${site.apiBase}${p}`,
            description: `Endpoint trả dữ liệu account A cho token B mà không kiểm tra ownership.`,
            steps: [`Login account A (${usernameA}) → lấy userId`, `Login account B (${usernameB})`, `GET ${p} bằng token B`],
            evidence: `status=${res.status}\nbody=${body.slice(0, 400)}`,
            impact: 'Lộ PII/dữ liệu tài khoản người dùng khác.', probe: 'idor'
          });
        }
      } catch (e) {
        results.push({ step: `GET ${p} (token B)`, error: e.message });
      }
    }
  }
  return { siteId, a: usernameA, b: usernameB, results };
}

// ---------- 6) Race condition: N request đồng thời tới 1 endpoint idempotent ----------
// Dùng cho attendance/claim/điểm danh — chỉ trên account của mình (§4).
// Rate limiter vẫn chạy → N request trải theo 2rps; song song hóa ở tầng chuẩn bị.
async function probeRace(siteId, username, racePath, { method = 'POST', body = {}, n = 6 } = {}) {
  requireAuthorized();
  const site = getSite(siteId);
  const sess = await ensureValidToken(username, siteId);
  if (!sess || !sess.token) return { error: `không lấy được token ${username}@${siteId}` };
  const token = sess.token;
  const url = `${site.apiBase}${racePath}`;
  const urls = Array.from({ length: n }, () => url);
  const opts = {
    auditTag: `probe:race:${siteId}`,
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  };
  const t0 = Date.now();
  const results = await scopedFetchAll(urls, opts);
  const okCount = results.filter(r => r.ok && r.status >= 200 && r.status < 300).length;
  const r = { url, n, elapsedMs: Date.now() - t0, okCount, results: results.map(x => ({ status: x.status, ok: x.ok, body: (x.body || x.error || '').slice(0, 200) })) };
  if (okCount > 1) {
    report.createFinding({
      title: `Race: ${okCount}/${n} request song song thành công tới ${racePath}`, severity: 'medium',
      siteId, asset: url,
      description: `Endpoint có vẻ không idempotent: ${okCount}/${n} parallel request đều 2xx. Xác minh thủ công xem có double-credit không.`,
      evidence: JSON.stringify(r.results).slice(0, 800),
      impact: 'Nếu endpoint ghi có credit/reward → double-spend.', probe: 'race'
    });
  }
  return r;
}

// ---------- 7) Auth check: endpoint biết là cần auth, gọi không token phải 401 ----------
async function probeUnauth(siteId, paths = ['/account/me']) {
  requireAuthorized();
  const site = getSite(siteId);
  const out = [];
  for (const p of paths) {
    const url = `${site.apiBase}${p}`;
    try {
      const res = await scopedFetch(url, { auditTag: `probe:unauth:${siteId}` });
      const body = (await res.text()).slice(0, 400);
      const leaked = res.status === 200 && body.length > 10;
      out.push({ url, status: res.status, leaked, body: body.slice(0, 200) });
      if (leaked) {
        report.createFinding({ title: `Endpoint trả dữ liệu không cần auth: ${p}`, severity: 'medium', siteId, asset: url, description: `GET ${url} → 200 không Authorization header`, evidence: body.slice(0, 300), impact: 'Tùy nội dung — có thể lộ dữ liệu user.', probe: 'unauth' });
      }
    } catch (e) { out.push({ url, error: e.message }); }
  }
  return out;
}

module.exports = { probeHeaders, probeExposed, auditJwt, probeCrossSiteToken, probeIdor, probeRace, probeUnauth, requireAuthorized, loadConfig };

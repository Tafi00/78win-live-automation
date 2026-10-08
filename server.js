const express = require('express');
const cors = require('cors');
const path = require('path');
const { loginAccount, listAccounts, deleteAccount, setAccountProxy, parseProxy } = require('./lib/auth');
const { getSite, listSites } = require('./lib/sites');
const tracker = require('./lib/tracker-ws');
const bountyScope = require('./lib/scope');
const bountyRecon = require('./lib/bounty/recon');
const bountyProbe = require('./lib/bounty/probe');
const bountyRegister = require('./lib/bounty/register');
const bountyRatelimit = require('./lib/bounty/ratelimit');
const bountyFarm = require('./lib/bounty/farm');
const bountyLive = require('./lib/bounty/live');
const bountyReport = require('./lib/bounty/report');

const app = express();
const PORT = process.env.PORT || 3300;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Hàng đợi đăng nhập: đăng nhập mở Chrome + OCR captcha nên chạy lần lượt từng tài khoản
let loginStatus = {
  inProgress: false,
  username: null,
  step: null,
  message: null,
  error: null,
  success: false,
  total: 0,
  done: 0,
  results: [] // { username, success, error }
};
const loginQueue = [];

function enqueueLogins(items, site) {
  if (!loginStatus.inProgress) {
    loginStatus = { inProgress: true, username: null, step: 'start', message: 'Khởi động Playwright...', error: null, success: false, total: 0, done: 0, results: [] };
  }
  for (const it of items) loginQueue.push({ ...it, site });
  loginStatus.total += items.length;
  if (loginStatus.total === items.length) runLoginQueue();
}

async function runLoginQueue() {
  while (loginQueue.length) {
    const job = loginQueue.shift();
    loginStatus.username = job.username;
    const prefix = loginStatus.total > 1 ? `(${loginStatus.done + 1}/${loginStatus.total}) ` : '';
    try {
      await loginAccount(job.username, job.password, (prog) => {
        loginStatus.step = prog.step;
        loginStatus.message = prefix + prog.message;
      }, { site: job.site, proxy: job.proxy });
      loginStatus.results.push({ username: job.username, success: true });
    } catch (err) {
      loginStatus.results.push({ username: job.username, success: false, error: err.message });
    }
    loginStatus.done++;
  }
  const failed = loginStatus.results.filter(r => !r.success);
  loginStatus.inProgress = false;
  loginStatus.success = failed.length === 0;
  loginStatus.error = failed.length ? failed.map(f => `${f.username}: ${f.error}`).join(' | ') : null;
  loginStatus.message = loginStatus.total > 1
    ? `Hoàn tất: ${loginStatus.total - failed.length}/${loginStatus.total} tài khoản đăng nhập thành công.`
    : (failed.length ? `Lỗi: ${failed[0].error}` : 'Đăng nhập thành công!');
}

// Mỗi dòng: user|pass|proxy (proxy không bắt buộc). Chấp nhận cả dấu tab/khoảng trắng hoặc ; làm phân cách.
function parseLoginLines(text) {
  const items = [];
  const errors = [];
  String(text || '').split(/\r?\n/).forEach((line, idx) => {
    const raw = line.trim();
    if (!raw || raw.startsWith('#')) return;
    const parts = raw.split(/\s*[|;\t]\s*|\s+/).filter(Boolean);
    const [username, password, ...rest] = parts;
    const proxy = rest.join('').trim();
    if (!username || !password) return errors.push(`Dòng ${idx + 1}: thiếu user hoặc pass`);
    if (proxy && !parseProxy(proxy)) return errors.push(`Dòng ${idx + 1}: proxy sai định dạng`);
    items.push({ username, password, proxy });
  });
  return { items, errors };
}

// Lightweight health check for the Electron launcher (no I/O, no network)
app.get('/api/ping', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/sites', (req, res) => {
  res.json({ success: true, sites: listSites() });
});

// 1. ACCOUNTS APIS
app.get('/api/accounts', async (req, res) => {
  try {
    const site = getSite(req.query.site);
    const accounts = await listAccounts(site.id);
    res.json({ success: true, site: site.id, accounts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/accounts/login', async (req, res) => {
  const { username, password, proxy } = req.body;
  const site = getSite(req.body.site);
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Thiếu tên đăng nhập hoặc mật khẩu.' });
  }
  if (proxy && !parseProxy(proxy)) {
    return res.status(400).json({ success: false, error: 'Proxy sai định dạng. Dùng ip:port:user:pass hoặc ip:port.' });
  }
  enqueueLogins([{ username: String(username).trim(), password: String(password), proxy: proxy ? String(proxy).trim() : '' }], site.id);
  res.json({ success: true, message: 'Đã bắt đầu tiến trình đăng nhập.' });
});

// Đăng nhập hàng loạt: body.lines = "user|pass|proxy" mỗi dòng
app.post('/api/accounts/login-batch', async (req, res) => {
  const site = getSite(req.body.site);
  const { items, errors } = parseLoginLines(req.body.lines);
  if (errors.length) return res.status(400).json({ success: false, error: errors.join('; ') });
  if (!items.length) return res.status(400).json({ success: false, error: 'Không có tài khoản nào để đăng nhập.' });
  enqueueLogins(items, site.id);
  res.json({ success: true, count: items.length, message: `Đã xếp hàng đăng nhập ${items.length} tài khoản.` });
});

app.get('/api/accounts/login-status', (req, res) => {
  res.json(loginStatus);
});

app.put('/api/accounts/:username/proxy', (req, res) => {
  try {
    const site = getSite(req.query.site || (req.body && req.body.site));
    const label = setAccountProxy(req.params.username, (req.body && req.body.proxy) || '', site.id);
    res.json({ success: true, proxy: label });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/accounts/:username', (req, res) => {
  const { username } = req.params;
  const deleted = deleteAccount(username, getSite(req.query.site).id);
  res.json({ success: deleted });
});

// 2. TRACKER APIS
app.get('/api/tracker/status', (req, res) => {
  res.json(tracker.getStatus());
});

app.post('/api/tracker/start', async (req, res) => {
  const { url, username, autoAttendance, autoLixi } = req.body;
  if (!url || !username) {
    return res.status(400).json({ success: false, error: 'Thiếu livestream URL hoặc tên tài khoản.' });
  }

  try {
    // Start tracking in background so response returns immediately
    tracker.startTracking(url, username, {
      autoAttendance: autoAttendance !== false,
      autoLixi: autoLixi !== false
    }).catch(err => {
      console.error('[TRACKER START ERROR]', err);
      // Lỗi trước khi tracker chạy (vd. chưa có tài khoản của site) -> hiện lên khung log cho người dùng thấy
      try { tracker.log('ERROR', err.message); } catch (e) {}
    });

    res.json({ success: true, message: 'Đã bắt đầu theo dõi livestream!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/tracker/stop', async (req, res) => {
  try {
    await tracker.stopTracking();
    res.json({ success: true, message: 'Đã dừng theo dõi.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. BUG BOUNTY APIS (BBP-2026-001 — mọi request qua scopedFetch: scope §2 + 2rps + audit)
app.get('/api/bounty/scope', (req, res) => {
  res.json({ success: true, scope: bountyScope.listScope(), authorized: bountyProbe.loadConfig().authorized, ratelimit: bountyRatelimit.stats() });
});

// Passive recon — map endpoint từ bundle JS public
app.post('/api/bounty/recon', async (req, res) => {
  const site = req.body && req.body.site;
  try {
    const data = site ? await bountyRecon.reconSite(site) : await bountyRecon.reconAll();
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Active probes — yêu cầu authorized=true trong bounty.config.json
app.post('/api/bounty/probe/headers', async (req, res) => {
  try { res.json({ success: true, data: await bountyProbe.probeHeaders(req.body.site) }); }
  catch (e) { res.status(e.code === 'NOT_AUTHORIZED' ? 403 : 500).json({ success: false, error: e.message }); }
});
app.post('/api/bounty/probe/exposed', async (req, res) => {
  try { res.json({ success: true, data: await bountyProbe.probeExposed(req.body.site) }); }
  catch (e) { res.status(e.code === 'NOT_AUTHORIZED' ? 403 : 500).json({ success: false, error: e.message }); }
});
app.post('/api/bounty/probe/jwt', async (req, res) => {
  const { username, site } = req.body || {};
  try { res.json({ success: true, data: bountyProbe.auditJwt(username, site) }); }
  catch (e) { res.status(e.code === 'NOT_AUTHORIZED' ? 403 : 500).json({ success: false, error: e.message }); }
});
app.post('/api/bounty/probe/crosstoken', async (req, res) => {
  const { username, from, to } = req.body || {};
  try { res.json({ success: true, data: await bountyProbe.probeCrossSiteToken(username, from, to) }); }
  catch (e) { res.status(e.code === 'NOT_AUTHORIZED' ? 403 : 500).json({ success: false, error: e.message }); }
});
app.post('/api/bounty/probe/idor', async (req, res) => {
  const { site, a, b } = req.body || {};
  try { res.json({ success: true, data: await bountyProbe.probeIdor(site, a, b) }); }
  catch (e) { res.status(e.code === 'NOT_AUTHORIZED' ? 403 : 500).json({ success: false, error: e.message }); }
});
app.post('/api/bounty/probe/race', async (req, res) => {
  const { site, username, path: racePath, method, body, n } = req.body || {};
  try { res.json({ success: true, data: await bountyProbe.probeRace(site, username, racePath, { method, body, n }) }); }
  catch (e) { res.status(e.code === 'NOT_AUTHORIZED' ? 403 : 500).json({ success: false, error: e.message }); }
});
app.post('/api/bounty/probe/unauth', async (req, res) => {
  const { site, paths } = req.body || {};
  try { res.json({ success: true, data: await bountyProbe.probeUnauth(site, paths) }); }
  catch (e) { res.status(e.code === 'NOT_AUTHORIZED' ? 403 : 500).json({ success: false, error: e.message }); }
});

app.get('/api/bounty/findings', (req, res) => {
  res.json({ success: true, findings: bountyReport.listFindings() });
});
app.post('/api/bounty/findings', (req, res) => {
  try {
    const f = bountyReport.createFinding(req.body || {});
    res.json({ success: true, finding: f, file: bountyReport.writeFindingMarkdown(f) });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});
app.post('/api/bounty/findings/:id/report', (req, res) => {
  const f = bountyReport.listFindings().find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ success: false, error: 'finding không tồn tại' });
  res.json({ success: true, file: bountyReport.writeFindingMarkdown(f) });
});
app.get('/api/bounty/audit', (req, res) => {
  const fs = require('fs');
  try {
    const lines = fs.readFileSync(bountyReport.FINDINGS_FILE.replace('findings.jsonl', 'audit.jsonl'), 'utf8').trim().split('\n');
    res.json({ success: true, entries: lines.slice(-200).map(l => JSON.parse(l)) });
  } catch (e) { res.json({ success: true, entries: [] }); }
});

// Đăng ký tài khoản test bb_* (doc §4) rồi login lấy session
app.post('/api/bounty/register', async (req, res) => {
  const { site, username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ success: false, error: 'cần username + password' });
  try { res.json({ success: true, data: await bountyRegister.registerAndLogin(username, password, { site }) }); }
  catch (e) { res.status(e.code === 'NOT_AUTHORIZED' ? 403 : 500).json({ success: false, error: e.message }); }
});

// FARM (BTC-authorized abuse sim): kho link + clone + share-hit + proxy
app.post('/api/bounty/farm/links', (req, res) => {
  try { res.json({ success: true, links: bountyFarm.setLinks(req.body.links || req.body.urls || '') }); }
  catch (e) { res.status(400).json({ success: false, error: e.message }); }
});
app.get('/api/bounty/farm/links', (req, res) => res.json({ success: true, links: bountyFarm.getLinks() }));
app.post('/api/bounty/farm/clones', async (req, res) => {
  const { site = 'mb66', count = 5, prefix = 'bb', password, casinoAccount, casinoBank, concurrency = 6, proxies = [] } = req.body || {};
  if (!password) return res.status(400).json({ success: false, error: 'cần password cho clone' });
  try { res.json({ success: true, data: await bountyFarm.createClones(site, { count, prefix, password, casinoAccount, casinoBank, concurrency, proxies }) }); }
  catch (e) { res.status(e.code === 'NOT_AUTHORIZED' ? 403 : 500).json({ success: false, error: e.message }); }
});
app.post('/api/bounty/live/start', async (req, res) => {
  const { site = 'mb66', username, video, title, loop } = req.body || {};
  try { res.json({ success: true, data: await bountyLive.start(site, username, { video, title, loop }) }); }
  catch (e) { res.status(e.code === 'NOT_AUTHORIZED' ? 403 : 500).json({ success: false, error: e.message }); }
});
app.post('/api/bounty/live/stop', async (req, res) => {
  const { site = 'mb66', username } = req.body || {};
  try { res.json({ success: true, data: await bountyLive.stop(site, username) }); }
  catch (e) { res.status(e.code === 'NOT_AUTHORIZED' ? 403 : 500).json({ success: false, error: e.message }); }
});
app.get('/api/bounty/live/status', async (req, res) => {
  const { site = 'mb66', username } = req.query;
  try { res.json({ success: true, data: username ? await bountyLive.status(site, username) : bountyLive.list() }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
app.post('/api/bounty/farm/share', async (req, res) => {
  const { site = 'mb66', accounts = 'pool' } = req.body || {};   // mặc định: pool share (acc reg thành công)
  try { res.json({ success: true, data: await bountyFarm.shareHit(site, accounts) }); }
  catch (e) { res.status(e.code === 'NOT_AUTHORIZED' ? 403 : 500).json({ success: false, error: e.message }); }
});
// Rotator: set url /rotating của muaproxy + host proxy. Tool tự rotate trước mỗi lô share/reg.
app.post('/api/bounty/farm/rotator', (req, res) => {
  const { url, proxy } = req.body || {};
  if (!url) return res.status(400).json({ success: false, error: 'cần url /rotating' });
  res.json({ success: true, rotator: bountyFarm.setRotator(url, proxy || '160.250.166.16:10042::') });
});
app.get('/api/bounty/farm/rotator', (req, res) => res.json({ success: true, rotator: bountyFarm.getRotator() }));
app.get('/api/bounty/farm/pool', (req, res) => {
  const site = req.query.site || 'mb66';
  res.json({ success: true, site, pool: bountyFarm.getPool(site) });
});
app.post('/api/bounty/farm/pool', (req, res) => {
  const { site = 'mb66', add = [], remove = [] } = req.body || {};
  if (remove.length) bountyFarm.removeFromPool(site, remove);
  if (add.length) bountyFarm.addToPool(site, add);
  res.json({ success: true, pool: bountyFarm.getPool(site) });
});
app.post('/api/bounty/farm/proxies', async (req, res) => {
  const { site = 'mb66', accounts = 'pool', proxies = [] } = req.body || {};
  const accs = accounts === 'pool' ? bountyFarm.getPool(site) : accounts === 'all' ? 'all' : accounts;
  try { res.json({ success: true, data: await bountyFarm.assignProxies(site, accs === 'all' ? 'all' : accs, proxies) }); }
  catch (e) { res.status(400).json({ success: false, error: e.message }); }
});
app.get('/api/bounty/farm/assign', async (req, res) => {
  const site = req.query.site || 'mb66';
  const scope = req.query.scope || 'pool'; // 'pool' = chỉ pool share, 'all' = toàn bộ session
  res.json({ success: true, data: await bountyFarm.assignAccounts(site, scope === 'all' ? 'all' : 'pool') });
});
// Kiểm tra scope guard: URL ngoài scope phải bị chặn
app.post('/api/bounty/check-url', async (req, res) => {
  const url = (req.body || {}).url || '';
  res.json({ success: true, url, inScope: bountyScope.isInScope(url), site: bountyScope.siteOf(url) });
});
// Serve UI for all other routes
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log('====================================================');
  console.log(`🚀 78WIN LIVE AUTOMATION TOOL IS RUNNING`);
  console.log(`🌐 Dashboard URL: http://localhost:${PORT}`);
  console.log('====================================================');
});
server.on('error', (err) => {
  console.error(`[SERVER] Không listen được trên port ${PORT}:`, err.message);
  module.exports.listenError = err;
});

const express = require('express');
const cors = require('cors');
const path = require('path');
const { loginAccount, listAccounts, deleteAccount, setAccountProxy, parseProxy } = require('./lib/auth');
const { getSite, listSites } = require('./lib/sites');
const tracker = require('./lib/tracker');

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

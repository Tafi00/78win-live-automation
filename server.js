const express = require('express');
const cors = require('cors');
const path = require('path');
const { loginAccount, listAccounts, deleteAccount, getSession } = require('./lib/auth');
const tracker = require('./lib/tracker');

const app = express();
const PORT = process.env.PORT || 3300;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory login progress store
let loginStatus = {
  inProgress: false,
  username: null,
  step: null,
  message: null,
  error: null,
  success: false
};

// Lightweight health check for the Electron launcher (no I/O, no network)
app.get('/api/ping', (req, res) => {
  res.json({ ok: true });
});

// 1. ACCOUNTS APIS
app.get('/api/accounts', async (req, res) => {
  try {
    const accounts = await listAccounts();
    res.json({ success: true, accounts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/accounts/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Thiếu tên đăng nhập hoặc mật khẩu.' });
  }

  if (loginStatus.inProgress) {
    return res.status(409).json({ success: false, error: 'Đang có một tiến trình đăng nhập khác diễn ra.' });
  }

  loginStatus = {
    inProgress: true,
    username,
    step: 'start',
    message: 'Khởi động Playwright...',
    error: null,
    success: false
  };

  // Run in background and respond or await
  loginAccount(username, password, (prog) => {
    loginStatus.step = prog.step;
    loginStatus.message = prog.message;
  }).then(result => {
    loginStatus.inProgress = false;
    loginStatus.success = true;
    loginStatus.message = 'Đăng nhập thành công!';
  }).catch(err => {
    loginStatus.inProgress = false;
    loginStatus.error = err.message;
    loginStatus.message = `Lỗi: ${err.message}`;
  });

  res.json({ success: true, message: 'Đã bắt đầu tiến trình đăng nhập.' });
});

app.get('/api/accounts/login-status', (req, res) => {
  res.json(loginStatus);
});

app.delete('/api/accounts/:username', (req, res) => {
  const { username } = req.params;
  const deleted = deleteAccount(username);
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

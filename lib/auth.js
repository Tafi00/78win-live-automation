const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const { createWorker } = require('tesseract.js');
const fs = require('fs');
const path = require('path');
const { findChrome } = require('./turnstile');
// Sessions must live OUTSIDE the read-only app.asar archive when packaged.
// In packaged Electron apps use the OS userData dir; in dev use the project folder.
let SESSIONS_DIR;
if (__dirname.includes('app.asar')) {
  const { app } = require('electron');
  SESSIONS_DIR = path.join(app.getPath('userData'), 'sessions');
} else {
  SESSIONS_DIR = path.join(__dirname, '..', 'sessions');
}
try {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
} catch (e) {
  console.error('[AUTH] Không tạo được thư mục sessions:', e.message);
}
async function solveCaptcha(base64Image) {
  const cleanBase64 = base64Image.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(cleanBase64, 'base64');
  
  const worker = await createWorker('eng');
  await worker.setParameters({
    tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  });
  
  const ret = await worker.recognize(buffer);
  const text = ret.data.text.replace(/[^a-zA-Z0-9]/g, '').trim();
  await worker.terminate();
  return text;
}

async function loginAccount(username, password, onProgress = () => {}) {
  onProgress({ step: 'start', message: `Bắt đầu đăng nhập tài khoản ${username}...` });

  const chromePath = findChrome();
  const launchOptions = {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ],
    ignoreDefaultArgs: ['--enable-automation']
  };
  if (chromePath) {
    launchOptions.channel = 'chrome';
  }
  const browser = await chromium.launch(launchOptions);

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  try {
    onProgress({ step: 'navigating', message: 'Đang mở trang 78win-live.pages.dev...' });
    await page.goto('https://78win-live.pages.dev', { waitUntil: 'domcontentloaded', timeout: 30000 });

    onProgress({ step: 'opening_modal', message: 'Mở cửa sổ đăng nhập...' });
    const loginBtn = await page.waitForSelector('button:has-text("ĐĂNG NHẬP"), #login-button', { timeout: 10000 });
    await loginBtn.click();
    await page.waitForTimeout(800);

    onProgress({ step: 'filling_form', message: 'Điền tên tài khoản và mật khẩu...' });
    const userInput = await page.waitForSelector('input[placeholder*="tên đăng nhập"], #login_username input', { timeout: 10000 });
    await userInput.fill('');
    await userInput.type(username, { delay: 40 });

    const passInput = await page.waitForSelector('input[placeholder*="mật khẩu"], #login_password input', { timeout: 10000 });
    await passInput.fill('');
    await passInput.type(password, { delay: 40 });

    onProgress({ step: 'solving_captcha', message: 'Đang đọc và giải mã Captcha bằng OCR...' });
    const captchaImg = await page.waitForSelector('img[alt="captcha"]', { timeout: 10000 });
    const captchaSrc = await captchaImg.getAttribute('src');
    
    let captchaCode = await solveCaptcha(captchaSrc);
    onProgress({ step: 'captcha_solved', message: `Captcha nhận diện được: [${captchaCode}]` });

    const captchaInput = await page.waitForSelector('#login_captcha', { timeout: 10000 });
    await captchaInput.fill('');
    await captchaInput.type(captchaCode, { delay: 40 });

    onProgress({ step: 'submitting', message: 'Đang gửi thông tin đăng nhập...' });
    const submitBtn = await page.waitForSelector('.login-modal button[type="submit"]', { timeout: 10000 });
    await submitBtn.click();

    // Check for success or error
    let token = null;
    for (let i = 0; i < 15; i++) {
      token = await page.evaluate(() => localStorage.getItem('token'));
      if (token) break;

      const errorMsg = await page.evaluate(() => {
        const err = document.querySelector('.ant-message-error, .ant-form-item-explain-error');
        return err ? err.innerText : null;
      });

      if (errorMsg) {
        onProgress({ step: 'retry_captcha', message: `Thông báo: ${errorMsg}. Đang thử lại captcha...` });
        if (errorMsg.includes('captcha') || errorMsg.includes('xác minh')) {
          await captchaImg.click();
          await page.waitForTimeout(1000);
          const newSrc = await captchaImg.getAttribute('src');
          captchaCode = await solveCaptcha(newSrc);
          onProgress({ step: 'captcha_solved', message: `Mã Captcha mới: [${captchaCode}]` });
          await captchaInput.fill('');
          await captchaInput.type(captchaCode, { delay: 40 });
          await submitBtn.click();
        }
      }

      await page.waitForTimeout(1000);
    }

    if (!token) {
      throw new Error('Đăng nhập thất bại: Không nhận được token xác thực.');
    }

    onProgress({ step: 'saving_session', message: 'Đăng nhập thành công! Đang lưu session...' });

    const storageState = await context.storageState();
    const localData = await page.evaluate(() => ({
      token: localStorage.getItem('token'),
      refreshToken: localStorage.getItem('refreshToken'),
      userId: localStorage.getItem('userId'),
      displayName: localStorage.getItem('displayName'),
      userType: localStorage.getItem('userType')
    }));

    const sessionPayload = {
      username,
      savedAt: new Date().toISOString(),
      token: localData.token,
      refreshToken: localData.refreshToken,
      userId: localData.userId,
      displayName: localData.displayName,
      storageState
    };

    const sessionPath = path.join(SESSIONS_DIR, `${username}.json`);
    // Đăng nhập lại không được làm mất proxy đã gắn cho tài khoản
    const prev = getSession(username);
    if (prev && prev.proxy) sessionPayload.proxy = prev.proxy;
    fs.writeFileSync(sessionPath, JSON.stringify(sessionPayload, null, 2));

    await browser.close();
    onProgress({ step: 'success', message: `Hoàn tất lưu session cho ${username}!` });

    return {
      success: true,
      username,
      displayName: localData.displayName,
      token: localData.token,
      sessionPath
    };
  } catch (err) {
    await browser.close();
    onProgress({ step: 'error', message: `Lỗi đăng nhập: ${err.message}` });
    throw err;
  }
}

async function listAccounts() {
  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  const accounts = [];

  for (const f of files) {
    try {
      const filePath = path.join(SESSIONS_DIR, f);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      
      // Verify account info from API
      let accountInfo = null;
      let isValid = false;
      try {
        const res = await fetch('https://live-78win-apiclient.attcloud.org/api/account/me', {
          headers: { Authorization: `Bearer ${data.token}` },
          signal: AbortSignal.timeout(8000)
        });
        if (res.ok) {
          const json = await res.json();
          accountInfo = json.data;
          isValid = true;
        }
      } catch (e) {}

      accounts.push({
        username: data.username,
        displayName: accountInfo?.displayName || data.displayName || data.username,
        vipLevel: accountInfo?.vipLevel || null,
        diamond: accountInfo?.diamond || 0,
        savedAt: data.savedAt,
        isValid,
        proxy: parseProxy(data.proxy) ? proxyLabel(data.proxy) : null,
        sessionFile: f
      });
    } catch (e) {}
  }

  return accounts;
}

function deleteAccount(username) {
  const filePath = path.join(SESSIONS_DIR, `${username}.json`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

// Nhận các dạng: "PROXY=ip:port:user:pass", "ip:port:user:pass", "ip:port", "http://user:pass@ip:port"
function parseProxy(input) {
  let str = String(input || '').trim().replace(/^proxy\s*=\s*/i, '');
  if (!str) return null;
  let scheme = 'http';
  const m = str.match(/^(https?|socks5):\/\//i);
  if (m) { scheme = m[1].toLowerCase(); str = str.slice(m[0].length); }
  let host, port, username, password;
  if (str.includes('@')) {
    const [auth, hp] = str.split('@');
    [host, port] = hp.split(':');
    const i = auth.indexOf(':');
    username = i === -1 ? auth : auth.slice(0, i);
    password = i === -1 ? '' : auth.slice(i + 1);
  } else {
    const parts = str.split(':');
    if (parts.length !== 2 && parts.length < 4) return null;
    [host, port] = parts;
    if (parts.length >= 4) {
      username = parts[2];
      password = parts.slice(3).join(':');
    }
  }
  if (!host || !/^\d{1,5}$/.test(String(port || ''))) return null;
  const proxy = { server: `${scheme}://${host}:${port}` };
  if (username) {
    proxy.username = username;
    proxy.password = password || '';
  }
  return proxy;
}

function proxyLabel(input) {
  const p = parseProxy(input);
  return p ? p.server.replace(/^\w+:\/\//, '') : null;
}

// Gắn / gỡ proxy cho 1 tài khoản (chuỗi rỗng = gỡ). Trả về lỗi nếu định dạng sai.
function setAccountProxy(username, input) {
  const sess = getSession(username);
  if (!sess) throw new Error(`Không tìm thấy tài khoản ${username}.`);
  const raw = String(input || '').trim();
  if (raw && !parseProxy(raw)) {
    throw new Error('Proxy sai định dạng. Dùng ip:port:user:pass hoặc ip:port.');
  }
  if (raw) sess.proxy = raw.replace(/^proxy\s*=\s*/i, '');
  else delete sess.proxy;
  fs.writeFileSync(path.join(SESSIONS_DIR, `${username}.json`), JSON.stringify(sess, null, 2));
  return raw ? proxyLabel(raw) : null;
}

function getSession(username) {
  const filePath = path.join(SESSIONS_DIR, `${username}.json`);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  return null;
}
// Mỗi tài khoản chỉ refresh 1 luồng tại 1 thời điểm: keepalive, điểm danh và claim lì xì có thể gọi cùng lúc,
// gửi trùng refreshToken sẽ khiến server xoay vòng/thu hồi token.
const refreshInflight = new Map();

function refreshSessionToken(username) {
  if (refreshInflight.has(username)) return refreshInflight.get(username);
  const p = doRefreshSessionToken(username).finally(() => refreshInflight.delete(username));
  refreshInflight.set(username, p);
  return p;
}

async function doRefreshSessionToken(username) {
  const sess = getSession(username);
  if (!sess || !sess.token || !sess.refreshToken) return null;
  try {
    const res = await fetch('https://live-78win-apiclient.attcloud.org/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accessToken: sess.token,
        refreshToken: sess.refreshToken
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json && json.data && json.data.accessToken) {
      sess.token = json.data.accessToken;
      if (json.data.refreshToken) sess.refreshToken = json.data.refreshToken;
      sess.savedAt = new Date().toISOString();
      const filePath = path.join(SESSIONS_DIR, `${username}.json`);
      fs.writeFileSync(filePath, JSON.stringify(sess, null, 2));
      return sess;
    }
  } catch (e) {}
  return null;
}

async function ensureValidToken(username) {
  const sess = getSession(username);
  if (!sess || !sess.token) return null;
  try {
    const parts = sess.token.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
      // Nếu token hết hạn hoặc còn dưới 5 phút, tự động refresh
      if (payload && payload.exp && (Date.now() / 1000 + 300 > payload.exp)) {
        const refreshed = await refreshSessionToken(username);
        if (refreshed) return refreshed;
      }
    }
  } catch (e) {}
  return sess;
}

module.exports = {
  loginAccount,
  listAccounts,
  deleteAccount,
  getSession,
  refreshSessionToken,
  ensureValidToken,
  parseProxy,
  setAccountProxy
};

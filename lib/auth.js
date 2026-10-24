const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const { createWorker } = require('tesseract.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { findChrome } = require('./turnstile');
const { getSite, DEFAULT_SITE } = require('./sites');
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
// Tesseract worker tốn ~1-2s để khởi tạo (load WASM + dữ liệu ngôn ngữ) → cache 1 worker dùng chung
// cho mọi captcha (login + signup) để lần OCR thứ 2 trở đi chỉ còn ~150-300ms.
let _ocrWorker = null;
let _ocrWorkerP = null;
async function getOCRWorker() {
  if (_ocrWorker) return _ocrWorker;
  if (_ocrWorkerP) return _ocrWorkerP;
  _ocrWorkerP = (async () => {
    const w = await createWorker('eng');
    await w.setParameters({
      tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
    });
    _ocrWorker = w;
    _ocrWorkerP = null;
    return w;
  })();
  return _ocrWorkerP;
}

async function solveCaptcha(base64Image) {
  const cleanBase64 = String(base64Image).replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(cleanBase64, 'base64');
  const worker = await getOCRWorker();
  const ret = await worker.recognize(buffer);
  return ret.data.text.replace(/[^a-zA-Z0-9]/g, '').trim();
}

// Session của 78win nằm ngay trong sessions/ (giữ tương thích bản cũ), site khác nằm trong sessions/<site>/
function siteDir(siteId = DEFAULT_SITE) {
  if (siteId === DEFAULT_SITE) return SESSIONS_DIR;
  const dir = path.join(SESSIONS_DIR, siteId);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  return dir;
}

function sessionPath(username, siteId = DEFAULT_SITE) {
  return path.join(siteDir(siteId), `${username}.json`);
}

function writeSession(username, siteId, data) {
  fs.writeFileSync(sessionPath(username, siteId), JSON.stringify(data, null, 2));
}

// Mật khẩu lưu để tự đăng nhập lại: mã hoá AES-256-GCM với khoá gắn theo máy + user hệ điều hành
// (file session copy sang máy khác sẽ không giải mã được).
function machineKey() {
  let user = '';
  try { user = os.userInfo().username; } catch (e) {}
  return crypto.createHash('sha256').update(`78win-live:${os.hostname()}:${user}`).digest();
}

function encryptPassword(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', machineKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}

function decryptPassword(blob) {
  try {
    const [iv, tag, enc] = String(blob).split('.').map(x => Buffer.from(x, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', machineKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

// ============ FAST HTTP LOGIN ============
// Reversed từ bundle `index-*.js`:
//   POST {apiBase}/auth/captcha  →  { data: "data:image/..." }
//   POST {apiBase}/auth/login    body {username, password, captcha}
//                                →  { data: { accessToken|token, refreshToken, userId, displayName } }
// Không có signature (chỉ /auth/signup mới ký). Nhanh gấp 5–10× so với mở Chrome.
// Chỉ fallback Playwright khi: HTTP báo lỗi lạ (không phải captcha/sai mật khẩu/khoá),
// server đòi Turnstile, hoặc proxy socks5 (undici ProxyAgent chưa hỗ trợ socks).

async function httpFetch(url, { method = 'GET', headers = {}, body, proxy = null, timeoutMs = 15000 } = {}) {
  if (proxy && !/^socks/i.test(proxy.server || '')) {
    const { request, ProxyAgent } = require('undici');
    const auth = proxy.username ? `${proxy.username}:${proxy.password || ''}` : null;
    const dispatcher = new ProxyAgent({
      uri: proxy.server, connectTimeout: 8000,
      ...(auth ? { token: `Basic ${Buffer.from(auth).toString('base64')}` } : {})
    });
    const req = request(url, { method, headers, body, dispatcher, headersTimeout: timeoutMs, bodyTimeout: timeoutMs })
      .then(async r => {
        const text = await r.body.text();
        return { status: r.statusCode, ok: r.statusCode >= 200 && r.statusCode < 300, text: () => Promise.resolve(text), json: async () => { try { return JSON.parse(text); } catch { return {}; } } };
      });
    return Promise.race([req, new Promise((_, rej) => setTimeout(() => rej(new Error(`proxy timeout ${timeoutMs}ms`)), timeoutMs + 2000))]);
  }
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  return res;
}

// Dựng storageState tối thiểu để tracker.js có thể mở trang live đã login mà không cần
// mở Chrome lúc đăng nhập. Tracker chỉ đọc localStorage.token để gọi API; cookie _ga không bắt buộc.
function synthStorageState(site, { token, refreshToken, userId, displayName }) {
  return {
    cookies: [],
    origins: [{
      origin: site.origin,
      localStorage: [
        { name: 'token', value: token || '' },
        { name: 'refreshToken', value: refreshToken || '' },
        { name: 'userId', value: userId || '' },
        { name: 'displayName', value: displayName || '' }
      ].filter(x => x.value)
    }]
  };
}

async function httpLoginAccount(username, password, onProgress = () => {}, options = {}) {
  const site = getSite(options.site);
  const prev = getSession(username, site.id);
  const proxyRaw = options.proxy != null && String(options.proxy).trim() !== ''
    ? String(options.proxy).trim().replace(/^proxy\s*=\s*/i, '')
    : (prev && prev.proxy) || '';
  const proxy = proxyRaw ? parseProxy(proxyRaw) : null;
  if (proxyRaw && !proxy) throw new Error('Proxy sai định dạng. Dùng ip:port:user:pass hoặc ip:port.');
  if (proxy && /^socks/i.test(proxy.server)) {
    const err = new Error('SOCKS proxy không hỗ trợ HTTP login');
    err.code = 'HTTP_LOGIN_SKIP';
    throw err;
  }

  const headers = { 'Content-Type': 'application/json', Origin: site.origin, Referer: site.origin + '/' };
  const maxAttempts = Math.max(1, options.maxAttempts || 6);
  onProgress({ step: 'start', message: `[${site.name}] HTTP login ${username}${proxy ? ` qua ${proxyLabel(proxyRaw)}` : ''}...` });

  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    onProgress({ step: 'captcha', message: `[${attempt}/${maxAttempts}] Lấy captcha...` });
    const capRes = await httpFetch(`${site.apiBase}/auth/captcha`, { method: 'POST', headers, body: '{}', proxy });
    const capJson = await capRes.json().catch(() => ({}));
    const img = capJson.data || capJson.captcha || '';
    if (!String(img).startsWith('data:image')) {
      const e = new Error(`captcha response lạ: ${JSON.stringify(capJson).slice(0, 200)}`);
      e.code = 'HTTP_LOGIN_FALLBACK'; throw e;
    }

    const code = await solveCaptcha(img);
    onProgress({ step: 'captcha_solved', message: `[${attempt}/${maxAttempts}] OCR: [${code}]` });
    if (!code || code.length < 3) { lastErr = 'OCR trả chuỗi quá ngắn'; continue; }

    onProgress({ step: 'submitting', message: `[${attempt}/${maxAttempts}] POST /auth/login...` });
    const res = await httpFetch(`${site.apiBase}/auth/login`, {
      method: 'POST', headers, proxy,
      body: JSON.stringify({ username: String(username).trim().toLowerCase(), password, captcha: code })
    });
    const body = await res.json().catch(() => ({}));
    const data = body && (body.data || body); // chịu cả 2 shape
    const token = data && (data.token || data.accessToken);
    const refreshToken = data && data.refreshToken;

    if (res.ok && token) {
      onProgress({ step: 'saving_session', message: 'Login thành công, đang lưu session...' });
      const sessionPayload = {
        username,
        site: site.id,
        savedAt: new Date().toISOString(),
        token,
        refreshToken: refreshToken || null,
        userId: data.userId || null,
        displayName: data.displayName || username,
        storageState: synthStorageState(site, { token, refreshToken, userId: data.userId, displayName: data.displayName })
      };
      if (proxyRaw) sessionPayload.proxy = proxyRaw;
      if (options.savePassword !== false) sessionPayload.passwordEnc = encryptPassword(password);
      else if (prev && prev.passwordEnc) sessionPayload.passwordEnc = prev.passwordEnc;
      writeSession(username, site.id, sessionPayload);
      onProgress({ step: 'success', message: `Hoàn tất lưu session cho ${username}!` });
      return { success: true, username, displayName: data.displayName, token, sessionPath: sessionPath(username, site.id) };
    }

    const msg = (body && (body.message || body.errorMessage)) || `HTTP ${res.status}`;
    lastErr = msg;
    onProgress({ step: 'retry', message: `[${attempt}/${maxAttempts}] ${msg}` });
    // Lỗi không phải captcha → không retry vô ích, báo lên để caller quyết fallback hay thôi
    if (!/captcha|xác minh|verify|mã/i.test(msg)) {
      // Sai mật khẩu / tài khoản bị khoá → trả lỗi gốc, không fallback Playwright (chỉ tốn thêm thời gian)
      if (/mật khẩu|password|sai|khoá|khóa|lock|incorrect|invalid/i.test(msg)) {
        throw new Error(msg);
      }
      // Turnstile / lỗi khác → fallback Playwright
      const e = new Error(msg); e.code = 'HTTP_LOGIN_FALLBACK'; throw e;
    }
  }
  const e = new Error(`HTTP login thất bại sau ${maxAttempts} lần: ${lastErr || 'captcha sai'}`);
  e.code = 'HTTP_LOGIN_FALLBACK';
  throw e;
}

async function loginAccount(username, password, onProgress = () => {}, options = {}) {
  // Thử HTTP trước — nhanh gấp 5–10× (không mở Chrome). Fallback Playwright chỉ khi HTTP có vấn đề lạ.
  if (options.forceBrowser !== true) {
    try {
      return await httpLoginAccount(username, password, onProgress, options);
    } catch (e) {
      if (e && e.code !== 'HTTP_LOGIN_FALLBACK' && e.code !== 'HTTP_LOGIN_SKIP') throw e;
      onProgress({ step: 'fallback', message: `HTTP login không được (${e.message}), fallback trình duyệt...` });
    }
  }

  const site = getSite(options.site);
  const prev = getSession(username, site.id);
  // Proxy: ưu tiên proxy truyền vào, không có thì dùng proxy đã gắn trước đó cho tài khoản
  const proxyRaw = options.proxy != null && String(options.proxy).trim() !== ''
    ? String(options.proxy).trim().replace(/^proxy\s*=\s*/i, '')
    : (prev && prev.proxy) || '';
  const proxy = proxyRaw ? parseProxy(proxyRaw) : null;
  if (proxyRaw && !proxy) {
    throw new Error('Proxy sai định dạng. Dùng ip:port:user:pass hoặc ip:port.');
  }
  onProgress({ step: 'start', message: `[${site.name}] Bắt đầu đăng nhập tài khoản ${username}${proxy ? ` qua proxy ${proxyLabel(proxyRaw)}` : ''}...` });

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
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    ...(proxy ? { proxy } : {})
  });

  const page = await context.newPage();

  try {
    onProgress({ step: 'navigating', message: `Đang mở trang ${new URL(site.origin).host}...` });
    await page.goto(site.origin, { waitUntil: 'domcontentloaded', timeout: 45000 });

    onProgress({ step: 'opening_modal', message: 'Mở cửa sổ đăng nhập...' });
    const loginBtn = await page.waitForSelector('#login-button, button:has-text("ĐĂNG NHẬP")', { timeout: 20000 });
    await loginBtn.click();

    // Chờ ô username xuất hiện là biết modal đã mở — nhanh hơn waitForTimeout(800) cố định.
    onProgress({ step: 'filling_form', message: 'Điền tên tài khoản và mật khẩu...' });
    const userInput = await page.waitForSelector('input#login_username, #login_username input, input[placeholder*="tên đăng nhập"], input[placeholder="Nhập tài khoản"]', { timeout: 10000 });
    // fill() set value trong 1 call, không gõ từng ký tự có delay — tiết kiệm ~0.5–1s mỗi field.
    await userInput.fill(username);

    const passInput = await page.waitForSelector('input#login_password, #login_password input, .login-modal input[type="password"]', { timeout: 10000 });
    await passInput.fill(password);

    onProgress({ step: 'solving_captcha', message: 'Đang đọc và giải mã Captcha bằng OCR...' });
    // 78win: img[alt=captcha]; QQ88: ảnh base64 không alt nằm trong form đăng nhập
    const captchaImg = await page.waitForSelector('.login-modal img[alt="captcha"], .login-modal .ant-form-item img[src^="data:image"], img[alt="captcha"]', { timeout: 15000 });
    const captchaSrc = await captchaImg.getAttribute('src');

    let captchaCode = await solveCaptcha(captchaSrc);
    onProgress({ step: 'captcha_solved', message: `Captcha nhận diện được: [${captchaCode}]` });

    const captchaInput = await page.waitForSelector('input#login_captcha, #login_captcha input', { timeout: 10000 });
    await captchaInput.fill(captchaCode);

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
        if (/captcha|xác minh|mã/i.test(errorMsg)) {
          await captchaImg.click();
          // Chờ src ảnh captcha đổi (= captcha mới đã load) thay vì sleep cứng 1s.
          try {
            await page.waitForFunction(
              (prev) => {
                const img = document.querySelector('.login-modal img[alt="captcha"], .login-modal .ant-form-item img[src^="data:image"], img[alt="captcha"]');
                return img && img.getAttribute('src') && img.getAttribute('src') !== prev;
              },
              captchaSrc,
              { timeout: 5000 }
            );
          } catch (e) { /* nếu không đổi vẫn thử OCR cái cũ */ }
          const newSrc = await captchaImg.getAttribute('src');
          captchaCode = await solveCaptcha(newSrc);
          onProgress({ step: 'captcha_solved', message: `Mã Captcha mới: [${captchaCode}]` });
          await captchaInput.fill(captchaCode);
          await submitBtn.click();
        }
      }

      await page.waitForTimeout(400);
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
      site: site.id,
      savedAt: new Date().toISOString(),
      token: localData.token,
      refreshToken: localData.refreshToken,
      userId: localData.userId,
      displayName: localData.displayName,
      storageState
    };

    if (proxyRaw) sessionPayload.proxy = proxyRaw;
    // Lưu mật khẩu (đã mã hoá) để tự đăng nhập lại khi phiên hết hạn
    if (options.savePassword !== false) sessionPayload.passwordEnc = encryptPassword(password);
    else if (prev && prev.passwordEnc) sessionPayload.passwordEnc = prev.passwordEnc;
    writeSession(username, site.id, sessionPayload);
    const savedPath = sessionPath(username, site.id);

    await browser.close();
    onProgress({ step: 'success', message: `Hoàn tất lưu session cho ${username}!` });

    return {
      success: true,
      username,
      displayName: localData.displayName,
      token: localData.token,
      sessionPath: savedPath
    };
  } catch (err) {
    await browser.close();
    onProgress({ step: 'error', message: `Lỗi đăng nhập: ${err.message}` });
    throw err;
  }
}

async function listAccounts(siteId = DEFAULT_SITE) {
  const site = getSite(siteId);
  const dir = siteDir(site.id);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const accounts = [];

  for (const f of files) {
    try {
      const filePath = path.join(dir, f);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      
      // Verify account info from API
      let accountInfo = null;
      let isValid = false;
      try {
        const res = await fetch(`${site.apiBase}/account/me`, {
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
        autoRelogin: !!data.passwordEnc,
        site: site.id,
        sessionFile: f
      });
    } catch (e) {}
  }

  return accounts;
}

function deleteAccount(username, siteId = DEFAULT_SITE) {
  const filePath = sessionPath(username, siteId);
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
function setAccountProxy(username, input, siteId = DEFAULT_SITE) {
  const sess = getSession(username, siteId);
  if (!sess) throw new Error(`Không tìm thấy tài khoản ${username}.`);
  const raw = String(input || '').trim();
  if (raw && !parseProxy(raw)) {
    throw new Error('Proxy sai định dạng. Dùng ip:port:user:pass hoặc ip:port.');
  }
  if (raw) sess.proxy = raw.replace(/^proxy\s*=\s*/i, '');
  else delete sess.proxy;
  writeSession(username, siteId, sess);
  return raw ? proxyLabel(raw) : null;
}

function getSession(username, siteId = DEFAULT_SITE) {
  const filePath = sessionPath(username, siteId);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  return null;
}

// Mỗi tài khoản chỉ refresh 1 luồng tại 1 thời điểm: keepalive, điểm danh và claim lì xì có thể gọi cùng lúc,
// gửi trùng refreshToken sẽ khiến server xoay vòng/thu hồi token.
const refreshInflight = new Map();

function refreshSessionToken(username, siteId = DEFAULT_SITE) {
  const key = `${siteId}:${username}`;
  if (refreshInflight.has(key)) return refreshInflight.get(key);
  const p = doRefreshSessionToken(username, siteId).finally(() => refreshInflight.delete(key));
  refreshInflight.set(key, p);
  return p;
}

async function doRefreshSessionToken(username, siteId) {
  const site = getSite(siteId);
  const sess = getSession(username, site.id);
  if (!sess || !sess.token || !sess.refreshToken) return null;
  try {
    const res = await fetch(`${site.apiBase}/auth/refresh`, {
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
      // Đọc lại file: trong lúc chờ có thể vừa gắn proxy / đăng nhập lại
      const latest = getSession(username, site.id) || sess;
      latest.token = json.data.accessToken;
      if (json.data.refreshToken) latest.refreshToken = json.data.refreshToken;
      latest.savedAt = new Date().toISOString();
      writeSession(username, site.id, latest);
      return latest;
    }
  } catch (e) {}
  return null;
}

function tokenExp(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    return payload && payload.exp ? payload.exp * 1000 : null;
  } catch (e) {
    return null;
  }
}

// ============ TỰ ĐĂNG NHẬP LẠI ============
// Khi refresh token hỏng (server thu hồi / hết hạn) mà tài khoản đã lưu mật khẩu -> tự đăng nhập lại
// (cùng proxy của tài khoản). Mỗi tài khoản chỉ 1 lượt đăng nhập tại 1 thời điểm, và không thử lại liên tục.
const reloginInflight = new Map();
const reloginLastFail = new Map();
const RELOGIN_COOLDOWN_MS = 5 * 60 * 1000;
// Đăng nhập mở trình duyệt + OCR captcha -> chạy lần lượt để không mở nhiều Chrome cùng lúc
let reloginChain = Promise.resolve();

function canAutoRelogin(username, siteId = DEFAULT_SITE) {
  const sess = getSession(username, siteId);
  return !!(sess && sess.passwordEnc);
}

function autoRelogin(username, siteId = DEFAULT_SITE, onProgress = () => {}) {
  const key = `${siteId}:${username}`;
  if (reloginInflight.has(key)) return reloginInflight.get(key);
  const lastFail = reloginLastFail.get(key) || 0;
  if (Date.now() - lastFail < RELOGIN_COOLDOWN_MS) return Promise.resolve(null);
  const sess = getSession(username, siteId);
  const password = sess && sess.passwordEnc ? decryptPassword(sess.passwordEnc) : null;
  if (!password) return Promise.resolve(null);

  const run = reloginChain.then(async () => {
    try {
      onProgress({ step: 'relogin', message: `[${username}] Phiên hết hạn, đang tự đăng nhập lại...` });
      await loginAccount(username, password, onProgress, { site: siteId, savePassword: true });
      reloginLastFail.delete(key);
      onProgress({ step: 'relogin_ok', message: `[${username}] Tự đăng nhập lại thành công.` });
      return getSession(username, siteId);
    } catch (e) {
      reloginLastFail.set(key, Date.now());
      onProgress({ step: 'relogin_fail', message: `[${username}] Tự đăng nhập lại thất bại: ${e.message}` });
      return null;
    }
  });
  reloginChain = run.catch(() => null);
  const p = run.finally(() => reloginInflight.delete(key));
  reloginInflight.set(key, p);
  return p;
}

async function ensureValidToken(username, siteId = DEFAULT_SITE, options = {}) {
  const sess = getSession(username, siteId);
  if (!sess || !sess.token) return null;
  const exp = tokenExp(sess.token);
  // Nếu token hết hạn hoặc còn dưới 5 phút, tự động refresh
  if (exp && Date.now() + 300000 > exp) {
    const refreshed = await refreshSessionToken(username, siteId);
    if (refreshed) return refreshed;
    // Refresh hỏng mà token đã hết hạn thật -> tự đăng nhập lại (nếu đã lưu mật khẩu)
    if (Date.now() > exp && options.relogin !== false && canAutoRelogin(username, siteId)) {
      const again = await autoRelogin(username, siteId, options.onProgress);
      if (again) return again;
    }
  }
  return sess;
}

module.exports = {
  loginAccount,
  httpLoginAccount,
  listAccounts,
  deleteAccount,
  getSession,
  refreshSessionToken,
  ensureValidToken,
  autoRelogin,
  canAutoRelogin,
  parseProxy,
  setAccountProxy,
  solveCaptcha
};

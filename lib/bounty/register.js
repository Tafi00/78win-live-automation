// Đăng ký tài khoản test (doc §4 cho phép: account do mình tự tạo, prefix bb_).
// Reversed từ bundle: POST /api/auth/captcha → base64 webp → OCR → POST /api/auth/signup
// với signature = MD5(`data_${MD5(payload)}&key_${secret}`) — secret hard-code trong bundle site.
const crypto = require('crypto');
const { scopedFetch } = require('./http');
const { getSite } = require('../sites');
const { requireAuthorized } = require('./probe');
const { solveCaptcha, loginAccount } = require('../auth');

// MD5(utf8) chuẩn — đúng nghĩa Vv.MD5(Vv.enc.Utf8.parse(s)) của CryptoJS
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const SIGN_SECRETS = {
  '78win': 'e90c20f7530bdcb122f3ce4ca0d0b97900a8505d43b771ffab34775eb6153dc0',
  'mb66':  'e90c20f7530bdcb122f3ce4ca0d0b97900a8505d43b771ffab34775eb6153dc0',
  'qq88':  '682b4ce68c16af1d81dea894c39ea733e62302775cd07f786e2f895207c4343a8cd1'
};

function signature(siteId, { username, displayName, phone, email, password }) {
  const secret = SIGN_SECRETS[siteId] || SIGN_SECRETS['78win'];
  const inner = `username_${username}&displayName_${displayName}&phone_${phone ?? ''}&email_${email ?? ''}&password_${password}`;
  return md5(`data_${md5(inner)}&key_${secret}`);
}

// Thử signup tối đa maxAttempts lần (OCR captcha có thể sai → captcha mới mỗi lần)
async function registerAccount(username, password, { site: siteId = '78win', displayName, extra = {}, proxy = null, onProgress = () => {}, maxAttempts = 6 } = {}) {
  requireAuthorized();
  const site = getSite(siteId);
  const headers = { 'Content-Type': 'application/json', Origin: site.origin };
  const tag = `register:${siteId}`;
  // có proxy (xoay) → đi qua proxiedFetch (vẫn enforce scope + timeout); không có → scopedFetch
  const doFetch = proxy ? (u, o) => require('./http').proxiedFetch(u, { ...o, proxy, auditTag: tag }) : scopedFetch;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    onProgress({ step: 'captcha', message: `[${attempt}/${maxAttempts}] Lấy captcha...` });
    const capRes = await doFetch(`${site.apiBase}/auth/captcha`, { method: 'POST', headers, body: '{}' });
    const capJson = await capRes.json().catch(() => ({}));
    const img = capJson.data || capJson.captcha || '';
    if (!img.startsWith('data:image')) return { success: false, error: `captcha response lạ: ${JSON.stringify(capJson).slice(0, 200)}` };

    const code = await solveCaptcha(img);
    onProgress({ step: 'captcha', message: `[${attempt}/${maxAttempts}] OCR captcha: [${code}]` });
    if (!code || code.length < 3) continue;

    const payload = { username, displayName: displayName || username, phone: '', email: '', password, captcha: code, ...extra };
    payload.signature = signature(siteId, payload);
    const res = await doFetch(`${site.apiBase}/auth/signup`, {
      method: 'POST', headers, body: JSON.stringify(payload)
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && (body.error === 0 || body.data || body.success)) {
      onProgress({ step: 'done', message: `Đăng ký ${username} thành công` });
      return { success: true, username, response: body };
    }
    const msg = body.message || body.errorMessage || `HTTP ${res.status}`;
    onProgress({ step: 'retry', message: `[${attempt}/${maxAttempts}] ${msg}` });
    // Lỗi không phải captcha (trùng tên, policy…) → không retry vô ích
    if (!/captcha|xác minh|verify/i.test(msg) && res.status !== 400) {
      return { success: false, error: msg, response: body };
    }
  }
  return { success: false, error: `hết ${maxAttempts} lần thử (OCR captcha)` };
}

// Đăng ký + login ngay để có session
async function registerAndLogin(username, password, opts = {}) {
  const reg = await registerAccount(username, password, opts);
  if (!reg.success) return reg;
  opts.onProgress?.({ step: 'login', message: `Đăng nhập ${username}...` });
  const login = await loginAccount(username, password, () => {}, { site: opts.site || '78win' });
  return { success: true, username, register: reg.response, sessionPath: login.sessionPath };
}

module.exports = { registerAccount, registerAndLogin, signature };

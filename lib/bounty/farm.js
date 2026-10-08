// Farm orchestration — BTC-authorized abuse sim (doc §4): tài khoản clone đăng nhập
// theo kho link chia sẻ, share-hit theo link của mình, proxy theo account.
const { scopedFetch, proxiedFetch } = require('./http');
const fs = require('fs');
const path = require('path');
const { getSite, siteFromUrl } = require('../sites');
const { getSession, listAccounts, parseProxy } = require('../auth');
const { dataPath, ensureDir, CONFIG_FILE } = require('../paths');
const { requireAuthorized } = require('./probe');
const { registerAccount } = require('./register');

const LINKS_FILE = dataPath('reports', 'farm-links.json');
const FARM_LOG = dataPath('reports', 'farm-audit.jsonl');

function farmLog(type, data) {
  fs.mkdirSync(path.dirname(FARM_LOG), { recursive: true });
  fs.appendFileSync(FARM_LOG, JSON.stringify({ ts: new Date().toISOString(), type, ...data }) + '\n');
}

const POOL_FILE = dataPath('reports', 'farm-pool.json');

// Pool share riêng (account reg thành công → vào đây): { siteId: [username] }
function loadPool() {
  try { return JSON.parse(fs.readFileSync(POOL_FILE, 'utf8')); } catch (e) { return {}; }
}
function savePool(pool) {
  fs.mkdirSync(path.dirname(POOL_FILE), { recursive: true });
  fs.writeFileSync(POOL_FILE, JSON.stringify(pool, null, 2));
}
function getPool(siteId) { return (loadPool()[siteId] || []); }
function addToPool(siteId, usernames) {
  const pool = loadPool();
  pool[siteId] = [...new Set([...(pool[siteId] || []), ...usernames])];
  savePool(pool);
  return pool[siteId];
}
function removeFromPool(siteId, usernames) {
  const pool = loadPool();
  pool[siteId] = (pool[siteId] || []).filter(u => !usernames.includes(u));
  savePool(pool);
}
function randomUsername(prefix = 'bb') {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return prefix + Array.from({ length: 9 }, () => abc[Math.floor(Math.random() * abc.length)]).join('');
}

const ROTATE_FILE = dataPath('reports', 'farm-rotate.json');
// { url: '…/rotating?whitelist_ip=…', host: '160.250.166.16:10042::', lastEgress, lastAt }
function loadRotate() { try { return JSON.parse(fs.readFileSync(ROTATE_FILE, 'utf8')); } catch (e) { return {}; } }
function saveRotate(cfg) { fs.mkdirSync(path.dirname(ROTATE_FILE), { recursive: true }); fs.writeFileSync(ROTATE_FILE, JSON.stringify(cfg, null, 2)); }

// Đăng ký host xoay + URL /rotating — tool tự gọi nó trước mỗi lô share/reg khi cần IP mới.
function setRotator(rotateUrl, proxyEntry = '160.250.166.16:10042::') {
  const cfg = { url: rotateUrl, host: proxyEntry, lastEgress: null, lastAt: 0 };
  saveRotate(cfg); return cfg;
}
function getRotator() { return loadRotate(); }

// Gọi /rotating (đủ cooldown ~30s thì rotate thật, chưa đủ thì dùng egress cũ). Trả {host, egress, rotated}
async function rotateNow(force = false) {
  const cfg = loadRotate();
  if (!cfg.url) throw new Error('Chưa cấu hình rotator — gọi /api/bounty/farm/rotator trước');
  const cooldownMs = 30_000;
  if (!force && cfg.lastEgress && Date.now() - cfg.lastAt < cooldownMs) {
    return { host: cfg.host, egress: cfg.lastEgress, rotated: false, waitMs: cooldownMs - (Date.now() - cfg.lastAt) };
  }
  const r = await fetch(cfg.url, { signal: AbortSignal.timeout(10000) });
  const j = await r.json();
  const ip = j?.data?.ip;
  if (!ip) throw new Error('rotator trả lạ: ' + JSON.stringify(j).slice(0, 150));
  cfg.lastEgress = ip; cfg.lastAt = Date.now(); saveRotate(cfg);
  farmLog('rotate', { egress: ip, host: cfg.host });
  return { host: cfg.host, egress: ip, rotated: true };
}

// ---- Kho link chia sẻ ----
function loadLinks() {
  try { return JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8')); } catch (e) { return []; }
}
function saveLinks(links) {
  fs.mkdirSync(path.dirname(LINKS_FILE), { recursive: true });
  fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2));
}
// links: [{url, label?}] — url dạng .../live/<streamId>?usercode=<u>
function setLinks(urls) {
  const links = (Array.isArray(urls) ? urls : String(urls).split(/\n+/))
    .map(u => String(u).trim()).filter(u => /^https?:\/\//.test(u))
    .map((url, i) => ({ id: i + 1, url, siteId: siteFromUrl(url).id }));
  saveLinks(links);
  return links;
}
function getLinks() { return loadLinks(); }

// Gán account theo thứ tự link (account1→link1, account2→link2…)
async function assignAccounts(siteId, usernames) {
  const links = loadLinks().filter(l => l.siteId === siteId);
  const accs = usernames === 'all'
    ? (await listAccounts(siteId)).map(a => a.username)
    : usernames === 'pool'
      ? getPool(siteId)
      : usernames;
  return accs.map((u, i) => ({
    username: u,
    link: links[i] ? links[i].url : null,
    linkId: links[i] ? links[i].id : null
  }));
}

// ---- Đăng ký hàng loạt account clone (prefix bb… hệ thống không cho '_' → dùng 'bb') ----
async function createClones(siteId, { count = 5, prefix = 'bb', password, casinoAccount, casinoBank, concurrency = 6, proxies = [], onProgress = () => {} } = {}) {
  requireAuthorized();
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const cap = cfg.farmMaxAccounts || 50;
  const existing = (await listAccounts(siteId)).length;
  if (existing + count > cap) count = Math.max(0, cap - existing);
  const results = [];
  const base = `${prefix}${Math.floor(Math.random() * 90000 + 10000)}`; // giữ tham số cũ nhưng username giờ random
  const randName = () => randomUsername('bb'); // vd bb7f3ka9x2 — không theo pattern seq
  const CONCURRENCY = Math.max(1, Math.min(concurrency, 10)); // mỗi luồng = 1 OCR + signup; quá cao dễ rate-limit captcha
  // proxies: list 'ip:port:user:pass' — gán tuần hoàn per-acc (cùng host rotator → cùng egress IP hiện tại)
  const proxyList = (Array.isArray(proxies) ? proxies : String(proxies || '').split(/\n+/)).map(x => x.trim()).filter(Boolean);
  for (let off = 0; off < count; off += CONCURRENCY) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, count - off) }, (_, k) => {
        const idx = off + k;
        const username = randName();
        onProgress({ step: 'register', message: `[${idx + 1}/${count}] ${username}` });
        return registerAccount(username, password, {
          site: siteId,
          proxy: proxyList.length ? parseProxy(proxyList[idx % proxyList.length]) : null,
          extra: {
            ...(siteId === 'qq88' ? { phone: '09' + String(10000000 + Math.floor(Math.random() * 89999999)), email: `${username}@test.local` } : {}),
            // 78win/qq88 bắt account casino thật + 4 số cuối bank khớp → truyền qua farm UI
            ...(casinoAccount ? { account: casinoAccount, bank: casinoBank || '' } : (siteId === 'qq88' ? { account: username, bank: '0000' } : {}))
          },
          onProgress
        }).then(r => ({ username, r: { ...r, _proxyIdx: idx } }));
      })
    );
    for (const { username, r } of batch) {
      results.push({ username, success: !!r.success, userId: r.response?.data?.userId, token: r.response?.data?.token, refreshToken: r.response?.data?.refreshToken, error: r.error, _proxyIdx: r._proxyIdx });
      farmLog('register', { siteId, username, success: !!r.success, error: r.error });
      if (!r.success && !/tồn tại|trùng/i.test(r.error || '') && off === 0) return results; // lỗi nặng ngay batch đầu → dừng
    }
  }
  // Lưu session luôn từ token signup trả về (khỏi login lại — nhanh hơn, đúng yêu cầu "auto login nhanh")
  const auth = require('../auth');
  for (const r of results.filter(x => x.success && x.token)) {
    const dir = ensureDir(siteId === '78win' ? dataPath('sessions') : dataPath('sessions', siteId));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${r.username}.json`), JSON.stringify({
      username: r.username, site: siteId, savedAt: new Date().toISOString(),
      token: r.token, refreshToken: r.refreshToken, userId: r.userId, displayName: r.username,
      proxy: proxyList.length ? proxyList[r._proxyIdx % proxyList.length] : undefined
    }, null, 2));
  }
  // Reg thành công → đưa vào pool share riêng của site
  addToPool(siteId, results.filter(x => x.success).map(x => x.username));
  return results;
}

async function shareHit(siteId, usernames = 'all') {
  requireAuthorized();
  // Auto-rotate: lô share mới → egress IP mới (cooldown 30s, rotateNow tự reuse nếu vừa rotate)
  try { const rot = await rotateNow(); if (rot.rotated) farmLog('share', { siteId, note: `egress → ${rot.egress}` }); } catch (e) { /* rotator optional */ }
  const pairs = (await assignAccounts(siteId, usernames)).filter(p => p.link);
  // Song song: mỗi acc đi proxy riêng → dedupe (IP × userCode) vẫn đúng vì IP khác nhau
  const out = await Promise.all(pairs.map(async (p) => {
    const sess = getSession(p.username, siteId);
    if (!sess?.token) return { username: p.username, link: p.link, error: 'no session' };
    const t0 = Date.now();
    try {
      // Share tracking của platform: GET /livestreams/{streamId}/share?userCode=<owner>
      const link = new URL(p.link);
      const streamId = link.pathname.split('/').filter(Boolean).pop();
      const userCode = link.searchParams.get('usercode') || link.searchParams.get('userCode') || '';
      const api = getSite(siteId).apiBase;
      const proxy = sess.proxy ? parseProxy(sess.proxy) : null;
      const res = await proxiedFetch(`${api}/livestreams/${streamId}/share?userCode=${encodeURIComponent(userCode)}`, {
        headers: { Authorization: `Bearer ${sess.token}` }, proxy
      });
      const body = (res.body || '').slice(0, 200);
      return { username: p.username, link: p.link, status: res.status, ms: Date.now() - t0, via: proxy ? proxy.server : 'direct', body };
    } catch (e) {
      return { username: p.username, link: p.link, error: e.message };
    }
  }));
  for (const o of out) farmLog('share', { siteId, ...o });
  return out;
}


// ---- Gắn proxy xoay cho account: proxy = list tuần hoàn gán theo index ----
async function assignProxies(siteId, usernames, proxies) {
  const list = (Array.isArray(proxies) ? proxies : String(proxies || '').split(/\n+/)).map(x => x.trim()).filter(Boolean);
  const accs = usernames === 'all' ? (await listAccounts(siteId)).map(a => a.username) : usernames;
  const out = [];
  for (let i = 0; i < accs.length; i++) {
    const proxy = list.length ? list[i % list.length] : '';
    try {
      require('../auth').setAccountProxy(accs[i], proxy, siteId);
      out.push({ username: accs[i], proxy: proxy || null });
    } catch (e) {
      out.push({ username: accs[i], proxy: null, error: e.message });
    }
  }
  return out;
}

module.exports = { setLinks, getLinks, assignAccounts, createClones, shareHit, assignProxies, farmLog, getPool, addToPool, removeFromPool, setRotator, getRotator, rotateNow };

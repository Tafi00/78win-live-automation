// ===== state + utils =====
const $ = id => document.getElementById(id);
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let isTracking = false;
let pollInterval = null;
let lastAccounts = [], lastPoolSet = new Set(), lastLogs = [];

// field-level validation: paint .invalid + shake, clear on next input
function markInvalid(el) {
  if (typeof el === 'string') el = $(el);
  if (!el) return;
  el.classList.add('invalid', 'flash-invalid');
  const clear = () => { el.classList.remove('invalid'); el.removeEventListener('input', clear); el.removeEventListener('change', clear); };
  el.addEventListener('input', clear); el.addEventListener('change', clear);
  setTimeout(() => el.classList.remove('flash-invalid'), 300);
}
function setBusy(btn, on, busyLabel) {
  btn.classList.toggle('btn-busy', on);
  btn.disabled = on;
  if (busyLabel !== undefined && !on) btn.textContent = busyLabel;
}

const SITE_DEFAULT_URLS = {
  '78win': 'https://78win-live.pages.dev/live/78winlive-idollive',
  qq88: 'https://www.qq88live.live/live/QQ88live-idol-live-qq88',
  mb66: 'https://mb66-live.pages.dev/live/mb66live-idollivemb'
};
const SITE_HOSTS = { '78win-live.pages.dev': '78win', 'www.qq88live.live': 'qq88', 'qq88live.live': 'qq88', 'mb66-live.pages.dev': 'mb66' };

function currentSite() { return $('site-select').value || '78win'; }

function toast(msg, level = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.textContent = msg;
  $('toast-box').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// ===== router =====
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  $('view-' + name).classList.remove('hidden');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  try { localStorage.setItem('view', name); } catch (e) {}
  if (name === 'farm') { farmRefreshAssign(); farmLoadLinks(); farmLoadRotator(); }
  if (name === 'accounts') fetchAccounts();
}

function updateCasinoFields() {
  $('casino-fields').classList.toggle('hidden', currentSite() !== '78win');
  $('casino-acc-req') && ($('casino-acc-req').textContent = currentSite() === '78win' ? '*' : '');
}

// ===== site =====
function onSiteChange(resetUrl) {
  const site = currentSite();
  try { localStorage.setItem('site', site); } catch (e) {}
  if (resetUrl && SITE_DEFAULT_URLS[site]) $('live-url').value = SITE_DEFAULT_URLS[site];
  fetchAccounts();
  updateCasinoFields();
  farmRefreshAssign();
}
function syncSiteFromUrl() {
  try {
    const host = new URL($('live-url').value.trim()).hostname.toLowerCase();
    const site = SITE_HOSTS[host];
    if (site && site !== currentSite()) { $('site-select').value = site; onSiteChange(false); }
  } catch (e) {}
}

// ===== accounts =====
async function fetchAccounts() {
  try {
    // lấy account + pool share song song — acc trong pool không vào dropdown theo dõi
    const [j, pj] = await Promise.all([
      api(`/api/accounts?site=${encodeURIComponent(currentSite())}`),
      api(`/api/bounty/farm/assign?site=${encodeURIComponent(currentSite())}&scope=pool`).catch(() => ({ data: [] }))
    ]);
    renderAccounts(j.accounts || [], new Set((pj.data || []).map(x => x.username)));
  } catch (e) { console.error(e); }
}

let accFilter = 'lixi'; // all | lixi (non-pool) | pool

function setAccFilter(f) {
  accFilter = f;
  document.querySelectorAll('.acc-filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === f));
  renderAccounts(lastAccounts, lastPoolSet);
}

function renderAccounts(accounts, poolSet = new Set()) {
  lastAccounts = accounts; lastPoolSet = poolSet;
  const sel = $('account-select'), list = $('accounts-list'), cnt = $('accounts-count');
  const tracked = accounts.filter(a => !poolSet.has(a.username));
  const opts = tracked.length
    ? `<option value="all" selected>⚡ Tất cả (${tracked.length} acc)</option>` + tracked.map(a => `<option value="${esc(a.username)}">👤 ${esc(a.username)}</option>`).join('')
    : '<option value="">Không có tài khoản</option>';
  sel.innerHTML = opts;
  const shown = accFilter === 'all' ? accounts : accFilter === 'pool' ? accounts.filter(a => poolSet.has(a.username)) : tracked;
  cnt.textContent = `(${shown.length}/${accounts.length})`;
  list.innerHTML = shown.length ? '' : `<p class="text-xs text-[var(--faint)]">Không có acc trong nhóm này.</p>`;
  for (const a of shown) {
    const card = document.createElement('div');
    card.className = 'card !p-3 text-xs space-y-2';
    const inPool = poolSet.has(a.username);
    card.innerHTML = `
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2.5">
          <div class="w-7 h-7 rounded-full ${inPool ? 'bg-amber-500/15 text-amber-400' : 'bg-blue-500/15 text-blue-400'} font-bold flex items-center justify-center text-[10px]">${esc(a.username.slice(0, 2).toUpperCase())}</div>
          <div>
            <div class="font-semibold text-slate-200">${esc(a.username)}${inPool ? ' <span class="text-[9px] font-bold text-amber-400/90 bg-amber-500/10 rounded px-1 py-px align-middle">POOL</span>' : ''}</div>
            <div class="text-[10px] ${a.isValid ? 'text-emerald-400' : 'text-slate-500'}">${a.isValid ? '✓ session ok' : 'chưa xác thực'}${a.autoRelogin ? ' · auto-relogin' : ''}${a.proxy ? ' · 🌐 ' + esc(a.proxy) : ''}</div>
          </div>
        </div>
        <button onclick="removeAccount('${esc(a.username)}')" class="text-slate-500 hover:text-rose-400 px-2">✕</button>
      </div>
      <div class="flex gap-2">
        <input data-proxy-input="${esc(a.username)}" type="text" placeholder="${a.proxy ? 'thay proxy (để trống + Lưu = gỡ)' : 'proxy ip:port:user:pass'}" class="flex-1">
        <button onclick="saveProxy('${esc(a.username)}')" class="btn-secondary !py-1 !px-2.5 text-[11px]">Lưu</button>
      </div>`;
    list.appendChild(card);
  }
}

async function submitLogin() {
  const u = $('login-user').value.trim(), p = $('login-pass').value.trim(), pr = $('login-proxy').value.trim();
  let bad = false;
  if (!u) { markInvalid('login-user'); bad = true; }
  if (!p) { markInvalid('login-pass'); bad = true; }
  if (bad) return;
  const btn = $('btn-login-submit'), box = $('login-progress-box'), msg = $('login-progress-msg');
  setBusy(btn, true); box.classList.remove('hidden'); msg.textContent = 'Đang login (OCR captcha)…';
  try {
    const r = await api('/api/accounts/login', { method: 'POST', body: JSON.stringify({ username: u, password: p, proxy: pr, site: currentSite() }) });
    if (!r.success) throw new Error(r.error || 'Không bắt đầu được');
    const t = setInterval(async () => {
      const st = await api('/api/accounts/login-status');
      if (st.message) msg.textContent = st.message;
      if (!st.inProgress) {
        clearInterval(t); setBusy(btn, false); fetchAccounts();
        msg.textContent = st.success ? '🎉 Đăng nhập xong' : `Lỗi: ${st.error || ''}`;
        if (st.success) { $('login-pass').value = ''; setTimeout(() => box.classList.add('hidden'), 2500); }
      }
    }, 1000);
  } catch (e) { msg.textContent = 'Lỗi: ' + e.message; setBusy(btn, false); }
}

async function submitBatchLogin() {
  const lines = $('batch-lines').value; if (!lines.trim()) { markInvalid('batch-lines'); return; }
  const box = $('login-progress-box'), msg = $('login-progress-msg');
  box.classList.remove('hidden'); msg.textContent = 'Đang xếp hàng đăng nhập…';
  try {
    await api('/api/accounts/login-batch', { method: 'POST', body: JSON.stringify({ lines, site: currentSite() }) });
    const t = setInterval(async () => {
      const st = await api('/api/accounts/login-status');
      if (st.message) msg.textContent = st.message;
      if (!st.inProgress) { clearInterval(t); fetchAccounts(); msg.textContent = st.error ? `Lỗi: ${st.error}` : `🎉 ${st.message}`; }
    }, 1000);
  } catch (e) { msg.textContent = 'Lỗi: ' + e.message; }
}

async function saveProxy(u) {
  const proxy = (document.querySelector(`[data-proxy-input="${u}"]`)?.value || '').trim();
  if (!proxy && !confirm(`Gỡ proxy của ${u}?`)) return;
  try { await api(`/api/accounts/${encodeURIComponent(u)}/proxy?site=${encodeURIComponent(currentSite())}`, { method: 'PUT', body: JSON.stringify({ proxy }) }); fetchAccounts(); toast(`Proxy ${u} cập nhật`, 'ok'); }
  catch (e) { toast(e.message, 'err'); }
}
async function removeAccount(u) {
  if (!confirm(`Xóa session ${u}?`)) return;
  await api(`/api/accounts/${encodeURIComponent(u)}?site=${encodeURIComponent(currentSite())}`, { method: 'DELETE' });
  fetchAccounts();
}

// ===== tracker =====
async function toggleTracker() {
  const btn = $('btn-toggle-tracker');
  const url = $('live-url').value.trim(), username = $('account-select').value;
  setBusy(btn, true);
  if (!isTracking) {
    let bad = false;
    if (!url) { markInvalid('live-url'); bad = true; }
    if (!username) { markInvalid('account-select'); bad = true; }
    if (bad) { setBusy(btn, false); return; }
    try {
      const j = await api('/api/tracker/start', { method: 'POST', body: JSON.stringify({ url, username, autoAttendance: $('auto-attendance').checked, autoLixi: $('auto-lixi').checked }) });
      if (j.success) { isTracking = true; updateTrackerUI(true); } else toast(j.error, 'err');
    } catch (e) { toast(e.message, 'err'); }
  } else {
    try { await api('/api/tracker/stop', { method: 'POST' }); isTracking = false; updateTrackerUI(false); } catch (e) { toast(e.message, 'err'); }
  }
  setBusy(btn, false);
}

function updateTrackerUI(running) {
  const btn = $('btn-toggle-tracker'), nav = $('nav-tracker-state');
  btn.className = running ? 'btn-danger w-full py-3' : 'btn-primary w-full py-3';
  btn.textContent = running ? '⏹ Dừng theo dõi' : '🚀 Bắt đầu theo dõi';
  nav.innerHTML = running
    ? '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>Tracker: đang chạy'
    : '<span class="w-1.5 h-1.5 rounded-full bg-slate-600"></span>Tracker: chưa chạy';
}

// ===== polling =====
function startPolling() {
  clearInterval(pollInterval);
  pollInterval = setInterval(async () => {
    try {
      const d = await api('/api/tracker/status');
      if (!d) return;
      isTracking = d.isRunning; updateTrackerUI(d.isRunning);
      if (d.stats) {
        const s = d.stats;
        $('stat-attendance-cd').textContent = s.nextOffsetCountdown || '--:--';
        $('stat-attendance-next').textContent = s.nextOffset ? (s.nextOffset === 'Đã hết mốc' ? 'Đã hết mốc' : `Mốc: ${s.nextOffset}m`) : 'Đang tải';
        $('stat-attendance-detail').textContent = s.attendanceStatus || (d.isRunning ? 'Đang kết nối…' : 'Đang chờ khởi chạy…');
        $('stat-lixi-points').textContent = `+${s.totalRewardPoints || 0} pts`;
        $('stat-lixi-count').textContent = `(${s.lixiClaimed?.length || 0} lần)`;
        const codes = (s.lixiClaimed || []).filter(c => c.code);
        $('stat-lixi-codes').classList.toggle('hidden', !codes.length);
        $('stat-lixi-codes').innerHTML = codes.slice().reverse().map(c =>
          `<div class="flex items-center justify-between gap-2 text-[11px] bg-slate-950 border border-slate-800 rounded px-2 py-1"><span class="text-slate-400">${esc(c.username)}</span><code class="text-amber-300 font-bold select-all">${esc(c.code)}</code><button onclick="navigator.clipboard.writeText('${esc(c.code)}')" class="text-blue-300">Copy</button></div>`).join('');
        if (d.farmerPoolSize !== undefined) $('stat-lixi-status').textContent = `Bể Turnstile: ${d.farmerPoolSize} sẵn sàng`;
        renderLixiResults(s.lixiResults || []);
      }
      if (d.latestLogs?.length) { lastLogs = d.latestLogs; renderLogs(lastLogs); }
    } catch (e) {}
  }, 1000);
}

let logFilter = 'all';
function setLogFilter(site) {
  logFilter = site;
  document.querySelectorAll('#view-logs .acc-filter-btn').forEach(b => b.classList.toggle('active', b.dataset.site === site));
  renderLogs(lastLogs);
}

function renderLogs(logs) {
  const filtered = logFilter === 'all' ? logs : logs.filter(l => l.site === logFilter || !l.site);
  $('console-logs').innerHTML = filtered.map(l => {
    let c = 'text-slate-400';
    if (l.type.includes('SUCCESS')) c = 'text-emerald-400 font-bold';
    else if (l.type.includes('ERROR')) c = 'text-rose-400 font-bold';
    else if (l.type.includes('WARN')) c = 'text-amber-300 font-bold';
    else if (l.type.includes('WS') || l.type.includes('LIXI')) c = 'text-sky-400 font-bold';
    else if (l.type.includes('FARMER') || l.type.includes('TURNSTILE')) c = 'text-purple-400 font-bold';
    else if (l.type.includes('DOM')) c = 'text-amber-400';
    else if (l.type.includes('ACTION')) c = 'text-yellow-400 font-bold';
    const siteTag = l.site ? `<span class="text-[var(--faint)]">[${esc(l.site.toUpperCase())}]</span> ` : '';
    return `<div><span class="text-slate-600">[${l.time}]</span> ${siteTag}<span class="${c}">[${l.type}]</span> <span class="text-slate-300">${esc(l.message)}</span></div>`;
  }).join('') || '<div class="text-slate-600">— trống —</div>';
}

function renderLixiResults(results) {
  const box = $('lixi-results');
  if (!results.length) { box.innerHTML = '<p class="text-xs text-slate-500">Chưa có phiên lì xì nào.</p>'; return; }
  const sessions = []; const seen = new Map();
  for (const r of results) { const k = String(r.sessionId || '?'); if (!seen.has(k)) { seen.set(k, []); sessions.push([k, seen.get(k)]); } seen.get(k).push(r); }
  box.innerHTML = sessions.map(([sid, rows]) => {
    const when = rows[0]?.at ? new Date(rows[0].at).toLocaleTimeString() : '';
    const chips = rows.map(r => {
      const chip = r.status === 'success'
        ? `<span class="text-emerald-300">✅ +${esc(r.rewardPoint || 0)}đ${r.code ? ` <code class="text-amber-300 select-all">${esc(r.code)}</code>` : ''}</span>`
        : r.status === 'pending' ? `<span class="text-sky-300">⏳ ${esc(r.message || 'đang chờ')}</span>` : `<span class="text-rose-300">❌ ${esc(r.message || 'thất bại')}</span>`;
      return `<div class="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-800"><span class="font-semibold text-slate-200">${esc(r.username)}</span>${chip}</div>`;
    }).join('');
    return `<div class="mb-3"><div class="text-[10px] text-slate-500 font-mono mb-1">🧧 Phiên ${esc(String(sid).slice(0, 13))}… ${esc(when)}</div><div class="flex flex-wrap gap-1.5">${chips}</div></div>`;
  }).join('');
}

function clearLogs() { $('console-logs').innerHTML = '<div class="text-slate-500">[SYSTEM] Đã xóa.</div>'; }

// ===== farm =====
const FARM_COLORS = { ok: 'text-emerald-400', err: 'text-red-400', warn: 'text-amber-400', info: 'text-slate-400' };
function farmLog(msg, level = 'info') {
  $('farm-log').insertAdjacentHTML('afterbegin', `<div class="${FARM_COLORS[level]}">[${new Date().toLocaleTimeString()}] ${esc(msg)}</div>`);
}

async function farmLoadLinks() {
  try { const j = await api('/api/bounty/farm/links'); if (j.links?.length) $('farm-links').value = j.links.map(l => l.url).join('\n'); } catch (e) {}
}
async function farmSaveLinks() {
  try {
    const j = await api('/api/bounty/farm/links', { method: 'POST', body: JSON.stringify({ links: $('farm-links').value }) });
    farmLog(j.success ? `✅ Lưu ${j.links.length} link` : `❌ ${j.error}`, j.success ? 'ok' : 'err'); farmRefreshAssign();
  } catch (e) { farmLog('❌ ' + e.message, 'err'); }
}

async function farmCreateClones() {
  const btn = $('btn-farm-clone');
  const count = +$('farm-count').value || 5, threads = +$('farm-concurrency').value || 6;
  const password = $('farm-password').value.trim(), casinoAcc = $('farm-casino-acc').value.trim();
  const site = currentSite();
  let bad = [];
  if (!password) bad.push('farm-password');
  if (site === '78win' && !casinoAcc) bad.push('farm-casino-acc');
  if (site === '78win' && !$('farm-casino-bank').value.trim()) bad.push('farm-casino-bank');
  if (bad.length) {
    bad.forEach(markInvalid);
    farmLog(`❌ site=${site} — thiếu: ${bad.map(id => $(id)?.previousElementSibling?.textContent?.trim() || id).join(', ')}`, 'err');
    return;
  }
  setBusy(btn, true);
  farmLog(`▶ Reg ${count} acc ${currentSite()} · ${threads} luồng`, 'info');
  const t0 = Date.now();
  try {
    const j = await api('/api/bounty/farm/clones', { method: 'POST', body: JSON.stringify({ site: currentSite(), count, password, casinoAccount: casinoAcc, casinoBank: $('farm-casino-bank').value.trim(), concurrency: threads, proxies: $('farm-proxies').value }) });
    const rows = j.data || [], ok = rows.filter(r => r.success), fail = rows.filter(r => !r.success);
    ok.forEach(r => farmLog(`✅ ${r.username} → pool`, 'ok'));
    fail.forEach(r => farmLog(`❌ ${r.username}: ${(r.error || '').slice(0, 80)}`, 'err'));
    farmLog(`— ${ok.length}/${rows.length} trong ${((Date.now() - t0) / 1000).toFixed(1)}s`, ok.length ? 'ok' : 'err');
    fetchAccounts(); farmRefreshAssign();
  } catch (e) { farmLog('❌ ' + e.message, 'err'); }
  setBusy(btn, false);
}

async function farmAssignProxies() {
  const proxies = $('farm-proxies').value, sel = farmSelectedAccs();
  if (!proxies.trim()) { markInvalid('farm-proxies'); farmLog('❌ Chưa nhập proxy', 'err'); return; }
  if (!sel.length) return farmLog('❌ Tick acc trước', 'err');
  try {
    const j = await api('/api/bounty/farm/proxies', { method: 'POST', body: JSON.stringify({ site: currentSite(), accounts: sel, proxies }) });
    if (j.success) j.data.forEach(p => farmLog(p.proxy ? `🔗 ${p.username} → ${p.proxy}` : `⚠ ${p.username}: lỗi`, p.proxy ? 'ok' : 'warn'));
    else farmLog('❌ ' + j.error, 'err');
  } catch (e) { farmLog('❌ ' + e.message, 'err'); }
}

async function farmRunShare() {
  const btn = $('btn-farm-share'), sel = farmSelectedAccs();
  if (!sel.length) { farmLog('Chưa tick acc', 'warn'); return; }
  setBusy(btn, true);
  farmLog(`▶ Share ${sel.length} acc trên ${currentSite()}`, 'info');
  try {
    const j = await api('/api/bounty/farm/share', { method: 'POST', body: JSON.stringify({ site: currentSite(), accounts: sel }) });
    let ok = 0, dup = 0;
    (j.data || []).forEach(r => {
      if (r.status === 200) { ok++; farmLog(`✅ ${r.username} → 200 qua ${r.via || 'direct'}`, 'ok'); }
      else if (r.status === 400) { dup++; farmLog(`⤳ ${r.username} đã share`, 'warn'); }
      else farmLog(`❌ ${r.username}: ${r.error || r.status}`, 'err');
    });
    farmLog(`— ${ok} credit, ${dup} dedupe, ${(j.data || []).length - ok - dup} lỗi`, ok ? 'ok' : 'warn');
  } catch (e) { farmLog('❌ ' + e.message, 'err'); }
  setBusy(btn, false);
}

async function farmRefreshAssign() {
  try {
    const j = await api(`/api/bounty/farm/assign?site=${encodeURIComponent(currentSite())}&scope=pool`);
    const pairs = j.data || [], box = $('farm-assign');
    if (!pairs.length) { box.innerHTML = '<span class="text-slate-600">Pool rỗng — reg clone để thêm.</span>'; return; }
    box.innerHTML = pairs.map(a => `<label class="flex items-center gap-2 cursor-pointer hover:text-slate-200 py-0.5">
      <input type="checkbox" class="farm-acc-cb accent-emerald-500 shrink-0" value="${esc(a.username)}" checked>
      <span class="text-slate-300 flex-1">${esc(a.username)}</span>
      <span class="text-slate-500 truncate max-w-40">${a.link ? esc(new URL(a.link).searchParams.get('usercode') || a.link.split('/').pop()) : '—'}</span></label>`).join('');
  } catch (e) {}
}
function farmSelectedAccs() { return [...document.querySelectorAll('.farm-acc-cb:checked')].map(c => c.value); }

async function farmSaveRotator() {
  const url = $('farm-rotator-url').value.trim(), proxy = ($('farm-proxies').value.split('\n')[0] || '').trim();
  if (!url) { markInvalid('farm-rotator-url'); farmLog('❌ Cần URL /rotating', 'err'); return; }
  try {
    const j = await api('/api/bounty/farm/rotator', { method: 'POST', body: JSON.stringify({ url, proxy }) });
    farmLog(j.success ? `✅ Rotator: ${j.rotator.host}` : `❌ ${j.error}`, j.success ? 'ok' : 'err'); farmLoadRotator();
  } catch (e) { farmLog('❌ ' + e.message, 'err'); }
}
async function farmLoadRotator() {
  try {
    const j = await api('/api/bounty/farm/rotator');
    $('farm-rotator-status').textContent = j.rotator?.url ? `rotator: ${j.rotator.host} → ${j.rotator.lastEgress || 'chưa rotate'}` : '';
  } catch (e) {}
}

// ===== proxy dialog =====
function openProxyDialog() {
  farmLoadRotator();
  $('proxy-dialog').showModal();
}

// ===== init =====
window.addEventListener('DOMContentLoaded', () => {
  const site = localStorage.getItem('site'); if (site && SITE_DEFAULT_URLS[site]) { $('site-select').value = site; $('live-url').value = SITE_DEFAULT_URLS[site]; }
  updateCasinoFields();
  showView(localStorage.getItem('view') || 'tracker');
  fetchAccounts(); farmRefreshAssign(); farmLoadLinks(); farmLoadRotator(); startPolling();
});

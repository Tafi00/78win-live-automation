// Đẩy video lên livestream của chính account (BTC-authorized: doc §4 cho phép tài sản mình sở hữu).
// Flow platform: GET/POST /livestream-configs → POST /session → rtmpEndpoint+sessionStreamKey → ffmpeg push.
// ffmpeg chạy supervisor: loop video vô hạn, tự restart nếu rớt, tự lấy key mới nếu key hết hạn.
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { scopedFetch } = require('./http');
const { getSite } = require('../sites');
const { getSession, ensureValidToken } = require('../auth');
const { requireAuthorized } = require('./probe');
const { farmLog } = require('./farm');

const RUNS = {}; // username -> { child, status, startedAt, liveUrl, stopRequested }

function ffmpegPath() {
  try { return execSync('which ffmpeg').toString().trim() || 'ffmpeg'; }
  catch (e) { return 'ffmpeg'; }
}

// Lấy (hoặc tạo) livestream-config + session stream key. Trả { endpoint, url } hoặc throw.
async function ensureRtmp(siteId, username, { title } = {}) {
  const site = getSite(siteId);
  const sess = (await ensureValidToken(username, siteId).catch(() => null)) || getSession(username, siteId);
  if (!sess?.token) throw new Error(`${username}: chưa có session — login hoặc tạo clone trước`);
  const H = { Authorization: `Bearer ${sess.token}` };
  const tag = `live:${siteId}`;

  let cfg = (await (await scopedFetch(`${site.apiBase}/livestream-configs`, { headers: H, auditTag: tag })).json()).data;
  if (!cfg) {
    const srv = (await (await scopedFetch(`${site.apiBase}/livestream-configs/rtmp-servers`, { headers: H, auditTag: tag })).json()).data || [];
    const fd = new FormData();
    fd.append('title', title || 'Live Stream');
    fd.append('rtmpServerId', String(srv[0]?.id || 1));
    fd.append('attendanceOffsetsMinutes', '0');
    await scopedFetch(`${site.apiBase}/livestream-configs`, { method: 'POST', headers: H, body: fd, auditTag: tag });
    cfg = (await (await scopedFetch(`${site.apiBase}/livestream-configs`, { headers: H, auditTag: tag })).json()).data;
  } else if (title && cfg.title !== title) {
    const fd = new FormData();
    fd.append('title', title);
    fd.append('rtmpServerId', String(cfg.rtmpServerId || 1));
    fd.append('attendanceOffsetsMinutes', String(cfg.attendanceOffsetsMinutes?.[0] ?? 0));
    await scopedFetch(`${site.apiBase}/livestream-configs`, { method: 'PUT', headers: H, body: fd, auditTag: tag });
  }

  let s = cfg?.session;
  if (!s || s.isStreamExpired || !s.sessionStreamKey) {
    await scopedFetch(`${site.apiBase}/livestream-configs/session`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}', auditTag: tag });
    s = (await (await scopedFetch(`${site.apiBase}/livestream-configs`, { headers: H, auditTag: tag })).json()).data?.session;
  }
  if (!s?.sessionStreamKey) throw new Error('Không lấy được sessionStreamKey');
  return { endpoint: s.rtmpEndpoint, key: s.sessionStreamKey, site };
}

// slug = <sitePrefix>live-<username>: mb66→mb66live-<u>; suy từ origin host phần đầu (mb66-live→mb66)
function liveSlug(site, username) {
  const prefix = site.origin.match(/^https?:\/\/([a-z0-9]+)/i)?.[1] || site.id;
  return `${prefix}live-${username}`;
}

async function status(siteId, username) {
  const site = getSite(siteId);
  const slug = liveSlug(site, username);
  const sess = getSession(username, siteId);
  try {
    const r = await scopedFetch(`${site.apiBase}/livestreams/detail/${slug}`, {
      headers: sess?.token ? { Authorization: `Bearer ${sess.token}` } : {}, auditTag: `live:${siteId}`
    });
    const j = await r.json();
    if (!j.data) return { slug, live: false };
    return {
      slug, live: !!j.data.isStreaming, title: j.data.title,
      viewers: j.data.viewer, liveUrl: `${site.origin}/live/${slug}`,
      sessionId: j.data.livestreamSessionId
    };
  } catch (e) {
    return { slug, live: false, error: e.message };
  }
}

// start: spawn ffmpeg supervisor loop video lên rtmp; stop: kill. Đồng bộ hoá qua RUNS.
async function start(siteId, username, { video, title, loop = true } = {}) {
  requireAuthorized();
  if (RUNS[username]?.child && !RUNS[username].child.killed) {
    return { alreadyRunning: true, ...await status(siteId, username) };
  }
  if (!fs.existsSync(video)) throw new Error(`Video không tồn tại: ${video}`);

  const { endpoint, key, site } = await ensureRtmp(siteId, username, { title });
  const url = endpoint + key;
  const slug = liveSlug(site, username);
  const liveUrl = `${site.origin}/live/${slug}`;

  const state = { child: null, status: 'starting', startedAt: new Date().toISOString(), liveUrl, slug, stopRequested: false };
  RUNS[username] = state;

  const spawnPush = async () => {
    if (state.stopRequested) return;
    // Nếu key hết hạn giữa chừng (isStreamExpired) → lấy key mới trước khi respawn
    let push = url;
    try {
      const fresh = await ensureRtmp(siteId, username, { title });
      push = fresh.endpoint + fresh.key;
    } catch (e) { farmLog('live', { username, warn: 'refresh key fail: ' + e.message }); }

    const args = ['-re', '-stream_loop', loop ? '-1' : '0', '-i', video, '-c', 'copy', '-f', 'flv', push];
    const child = spawn(ffmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    state.child = child; state.status = 'pushing';
    let errTail = '';
    child.stderr.on('data', d => { errTail = (errTail + d).slice(-2000); });
    child.on('exit', (code) => {
      farmLog('live', { username, event: 'ffmpeg-exit', code, tail: errTail.slice(-300) });
      if (!state.stopRequested) { state.status = 'restarting'; setTimeout(spawnPush, 3000); }
      else state.status = 'stopped';
    });
  };
  await spawnPush();
  farmLog('live', { username, siteId, event: 'start', slug, video });

  // chờ isStreaming lên (server xác nhận sau vài giây)
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const st = await status(siteId, username);
    if (st.live) return { liveUrl, slug, ...st };
  }
  return { liveUrl, slug, live: false, warn: 'push đang chạy nhưng server chưa báo isStreaming' };
}

async function stop(siteId, username) {
  const st = RUNS[username];
  if (st) { st.stopRequested = true; try { st.child?.kill('SIGKILL'); } catch (e) {} st.status = 'stopped'; }
  // best-effort: đóng session phía server
  try {
    const site = getSite(siteId);
    const sess = getSession(username, siteId);
    if (sess?.token) {
      await scopedFetch(`${site.apiBase}/livestream-configs/session`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${sess.token}` }, auditTag: `live:${siteId}`
      });
    }
  } catch (e) {}
  farmLog('live', { username, siteId, event: 'stop' });
  return status(siteId, username);
}

function list() {
  return Object.entries(RUNS).map(([u, s]) => ({ username: u, status: s.status, liveUrl: s.liveUrl, slug: s.slug, startedAt: s.startedAt }));
}

module.exports = { start, stop, status, list };

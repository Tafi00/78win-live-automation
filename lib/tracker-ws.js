// Engine theo dõi livestream bản native-WS + REST (thay thế dần lib/tracker.js dùng Playwright).
// - Sự kiện lì xì (RecvRewardAnnounce): WebSocket SignalR trực tiếp tới {wsHost}/livestream
//   bằng MessagePackHubProtocol, không negotiate (site dùng skipNegotiation:true).
// - Điểm danh / claim lì xì / check-status: REST thuần bằng fetch (proxy qua undici ProxyAgent).
// - Trình duyệt chỉ còn 2 vai trò: TurnstileFarmer (mint token CDP) và đọc fpHash 1 lần
//   bằng 1 context headless tối giản — không mở trang livestream trong suốt phiên theo dõi.
const WebSocket = require('ws');
const { encode, decode } = require('@msgpack/msgpack');
const crypto = require('crypto');
const { getSession, listAccounts, ensureValidToken, refreshSessionToken, autoRelogin, canAutoRelogin, parseProxy } = require('./auth');
const { getSite, siteFromUrl } = require('./sites');
const { findChrome, TurnstileFarmer } = require('./turnstile');

const APP_VERSION = require('../package.json').version;
const TURNSTILE_TOKEN_TTL_MS = 240000; // token Turnstile sống 300s, chừa biên an toàn 60s
const SESSION_KEEPALIVE_MS = 120000; // refresh token đăng nhập ở nền để lúc claim không phải chờ refresh
const DETAIL_POLL_MS = 15000; // poll /livestreams/detail để bắt kịp stream restart (lag)
const RETRY_DELAY_MS = 800;
// Mã -5 "Hệ thống đang bận xử lý" xảy ra khi nhiều người claim cùng lúc -> thử lại nhanh, liên tục
const BUSY_RETRY_DELAY_MS = 350;
const BUSY_MAX_ATTEMPTS = 12;
const HTTP_TIMEOUT_MS = 15000;
// QQ88: các lỗi frontend cho phép bấm nhận lại (khớp bảng lỗi trong bundle của site, đã bỏ dấu)
const QQ88_RETRYABLE = /turnstile|xac minh thiet bi|dia chi ip|dang ban/;
const QQ88_MAX_RECLAIMS = 2;
const normalizeVi = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Host WebSocket SignalR của từng site (đã xác minh từ bundle: skipNegotiation:true, hub '/livestream')
const WS_HOSTS = {
  '78win': 'live-78win-apiws.attcloud.org',
  'mb66': 'live-mb66-apiws.attcloud.org',
  'qq88': 'live-qq88-webservice-v2.royalcloud.work'
};

// Mã phòng live = đoạn cuối của pathname. Link chia sẻ có dạng .../live/<mã>?usercode=...
function streamIdFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
  } catch (e) {
    return String(url || '').split(/[?#]/)[0].split('/').filter(Boolean).pop() || '';
  }
}

const withTimeout = (promise, ms, fallback) => {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise(r => { timer = setTimeout(() => r(fallback), ms); })
  ]).finally(() => clearTimeout(timer));
};

// ============ SignalR BinaryMessageFormat (varint length-prefix) ============
// Mỗi message msgpack được đóng khung: <varint len><payload msgpack>. Handshake là JSON text + \x1e.
function writeVarint(n) {
  const bytes = [];
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    bytes.push(b);
  } while (n > 0 && bytes.length < 5);
  return Buffer.from(bytes);
}

function readVarint(buf, pos) {
  let result = 0, shift = 0;
  for (let i = 0; i < 5; i++) {
    if (pos >= buf.length) return null;
    const b = buf[pos++];
    result += (b & 0x7f) * Math.pow(2, shift);
    if (!(b & 0x80)) return { value: result, offset: pos };
    shift += 7;
  }
  return null;
}

function encodeSignalRFrame(obj) {
  const payload = Buffer.from(encode(obj));
  return Buffer.concat([writeVarint(payload.length), payload]);
}

// JS client serialize invocation dạng map {type, target, arguments, invocationId};
// .NET server serialize dạng array [type, headers, invocationId, target, [args]] -> đọc cả hai.
function msgType(msg) { return Array.isArray(msg) ? msg[0] : msg && msg.type; }
function msgTarget(msg) { return Array.isArray(msg) ? msg[3] : msg && msg.target; }
function msgArgs(msg) {
  if (Array.isArray(msg)) return msg[4];
  if (!msg) return undefined;
  return msg.arguments !== undefined ? msg.arguments : msg.args;
}
function msgInvocationError(msg) {
  // Completion [type=3, headers, invocationId, result, error] — error nằm ở index 4
  if (Array.isArray(msg)) return msg.length > 4 ? msg[4] : null;
  return msg && msg.error;
}

// POST/GET qua HTTP CONNECT proxy (undici ProxyAgent) — mỗi tài khoản có proxy thì claim
// đi từ IP của proxy đó (server trả "đang bận" khi nhiều claim cùng IP).
async function proxiedRequest(url, { method = 'GET', headers = {}, body, proxy, timeoutMs = HTTP_TIMEOUT_MS }) {
  const { request, ProxyAgent } = require('undici');
  const auth = proxy.username ? `${proxy.username}:${proxy.password || ''}` : null;
  const dispatcher = new ProxyAgent({
    uri: proxy.server,
    connectTimeout: 8000,
    ...(auth ? { token: `Basic ${Buffer.from(auth).toString('base64')}` } : {})
  });
  const req = request(url, {
    method,
    headers,
    body,
    dispatcher,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs
  }).then(async r => ({
    status: r.statusCode,
    ok: r.statusCode >= 200 && r.statusCode < 300,
    rawText: await r.body.text()
  }));
  // undici AbortSignal không abort CONNECT hang qua ProxyAgent -> race hard-deadline
  return Promise.race([
    req,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`proxy timeout ${timeoutMs}ms`)), timeoutMs + 2000))
  ]);
}

class LiveTrackerWS {
  constructor() {
    this.isRunning = false;
    this.currentUrl = null;
    this.currentUsername = null;
    this.config = { autoAttendance: true, autoLixi: true };
    this.stats = {
      attendanceLogs: [],
      lixiClaimed: [],
      lixiResults: [],
      totalRewardPoints: 0,
      streamInfo: null,
      nextOffset: null,
      nextOffsetCountdown: null,
      attendanceStatus: null,
      startedAt: null
    };
    this.logs = [];
    this.listeners = [];
    this.targetAccounts = [];
    this.primaryAccount = null;
    this.attendanceTimer = null;
    this.attendanceDone = new Set(); // `${username}:${offset}` đã xử lý trong window hiện tại
    this.attendanceAttempts = new Map();
    this.detailPollTimer = null;
    this.farmer = null;
    this.farmerStarting = null;
    this.activeRewardSession = null;
    this.claimedLixiSessions = new Set();
    this.visitorId = null;
    this.visitorIdPromise = null;
    this.sessionKeepaliveTimer = null;
    this.site = getSite();
    this.streamId = null;
    this.accountIds = new Map(); // username -> id tài khoản (QQ88 check-status)
    this.reclaimCounts = new Map(); // username:sessionId -> số lần nhận lại sau khi check-status báo lỗi
    this.ipLocks = new Map(); // ip key -> hàng đợi POST claim tuần tự theo IP
    this.proxyHealth = new Map(); // username -> { proxy, dead, deadUntil, deadLogged }
    // WebSocket SignalR
    this.ws = null;
    this.wsRxBuf = Buffer.alloc(0);
    this.wsHandshakeDone = false;
    this.wsGeneration = 0;
    this.wsReconnects = 0;
    this.wsReconnectTimer = null;
    this.wsPingTimer = null;
    this.invocationSeq = 0;
    // Context headless tối giản chỉ để đọc fpHash của site 1 lần
    this.fpBrowser = null;
    this.fpContext = null;
    this.fpPage = null;
  }

  log(type, message, data = null) {
    const entry = {
      id: Date.now() + Math.random().toString(16).slice(2),
      time: new Date().toLocaleTimeString(),
      type,
      message,
      site: this.site?.id || null,
      data
    };
    this.logs.unshift(entry);
    if (this.logs.length > 200) this.logs.pop();
    this.emit('log', entry);
    console.log(`[TRACKER:${type}] ${message}`);
  }

  on(event, callback) {
    this.listeners.push({ event, callback });
  }

  emit(event, data) {
    for (const l of this.listeners) {
      if (l.event === event) {
        try { l.callback(data); } catch (e) {}
      }
    }
  }

  async startTracking(liveUrl, username, config = {}) {
    if (this.isRunning) {
      throw new Error('Tracker đang chạy rồi. Vui lòng dừng trước khi khởi động phiên mới.');
    }

    let primarySession = null;
    // Site (78win / QQ88...) xác định theo domain của link live
    this.site = siteFromUrl(liveUrl);
    const siteId = this.site.id;

    if (username === 'all' || username === 'FULL') {
      const allAccounts = await listAccounts(siteId);
      if (!allAccounts || !allAccounts.length) {
        throw new Error(`Chưa có tài khoản ${this.site.name} nào được lưu. Vui lòng đăng nhập ít nhất 1 tài khoản.`);
      }
      // Ưu tiên tài khoản còn hợp lệ làm tài khoản chính (JoinGroup hub), tránh join ở trạng thái chưa đăng nhập
      const primaryAcc = allAccounts.find(a => a.isValid) || allAccounts[0];
      primarySession = (await ensureValidToken(primaryAcc.username, siteId, { onProgress: p => this.log('AUTH', p.message) })) || getSession(primaryAcc.username, siteId);
      if (!primarySession || !primarySession.token) {
        throw new Error(`Chưa có phiên đăng nhập hợp lệ cho tài khoản "${primaryAcc.username}". Vui lòng đăng nhập lại.`);
      }
      this.targetAccounts = allAccounts;
      this.primaryAccount = primaryAcc.username;
    } else {
      primarySession = (await ensureValidToken(username, siteId, { onProgress: p => this.log('AUTH', p.message) })) || getSession(username, siteId);
      if (!primarySession || !primarySession.token) {
        throw new Error(`Chưa có phiên đăng nhập hợp lệ cho tài khoản "${username}". Vui lòng đăng nhập trước.`);
      }
      this.targetAccounts = [{ username }];
      this.primaryAccount = username;
    }

    this.isRunning = true;
    this.currentUrl = liveUrl;
    this.currentUsername = username;
    this.config = { ...this.config, ...config };
    this.stats = {
      attendanceLogs: [],
      lixiClaimed: [],
      lixiResults: [],
      totalRewardPoints: 0,
      streamInfo: null,
      nextOffset: null,
      nextOffsetCountdown: null,
      attendanceStatus: null,
      startedAt: null
    };
    this.attendanceDone = new Set();
    this.attendanceAttempts = new Map();
    this.activeRewardSession = null;
    this.claimedLixiSessions = new Set();
    this.visitorId = null;
    this.visitorIdPromise = null;
    this.ipLocks = new Map();
    this.proxyHealth = new Map();
    this.accountIds = new Map();
    this.reclaimCounts = new Map();
    this.wsReconnects = 0;
    this.invocationSeq = 0;
    const accountDesc = (username === 'all' || username === 'FULL')
      ? `TẤT CẢ TÀI KHOẢN (${this.targetAccounts.map(a => a.username).join(', ')})`
      : username;
    this.log('INIT', `[v${APP_VERSION}] [${this.site.name}] Khởi động theo dõi livestream (engine WS): ${liveUrl} cho: ${accountDesc}...`);

    const streamId = streamIdFromUrl(liveUrl);
    this.streamId = streamId;

    // Lấy thông tin livestream từ REST ngay lập tức để đồng bộ mốc điểm danh
    this.refreshStreamDetail(true);

    if (this.config.autoAttendance) {
      this.startAttendanceScheduler();
      this.startDetailPoll();
    }

    // fpHash của site là tham số JoinGroup -> đọc 1 lần bằng context headless rồi đóng.
    // Chạy song song với WS connect; JoinGroup chờ visitorId sẵn sàng (fallback md5 nếu đọc hỏng).
    this.warmVisitorId(primarySession.token);

    // Kết nối SignalR trực tiếp để nhận RecvRewardAnnounce
    this.connectHub();

    if (this.config.autoLixi) {
      // Trình nạp token Turnstile (Chrome thật qua CDP) — token vẫn bắt buộc phải mint bằng browser
      const accountCount = this.targetAccounts.length;
      this.farmer = new TurnstileFarmer({
        url: liveUrl,
        siteKey: this.site.siteKey,
        tokenTtl: TURNSTILE_TOKEN_TTL_MS,
        maxTabs: Math.min(6, Math.max(4, accountCount)),
        onStatus: (msg) => this.log('FARMER', String(msg).replace(/^\s*\[FARMER\]\s*/i, ''))
      });
      this.farmerStarting = this.farmer.start().then((started) => {
        this.farmerStarting = null;
        if (!this.isRunning) return;
        if (!started) {
          this.log('WARN:LIXI', 'Không khởi động được trình nạp token -> khi lì xì rơi sẽ thử nạp lại (chậm).');
          return;
        }
        // Giữ sẵn mỗi tài khoản 2 token: đủ cho lượt đầu + thử lại / 2 phiên lì xì liên tiếp
        this.farmer.setDemand(true, accountCount * 2 + 1);
      }).catch((e) => {
        this.farmerStarting = null;
        this.log('FARMER', `Chế độ nạp token ngầm: ${e.message}`);
      });
      this.startSessionKeepalive();
      this.initProxyHealth();
    }

    this.log('READY', `Đang theo dõi trực tiếp. Chờ sự kiện Điểm danh & Lì xì...`);
    this.emit('status', this.getStatus());
  }

  // ============ SIGNALR HUB (native WS + MessagePack) ============

  connectHub() {
    if (!this.isRunning) return;
    const host = WS_HOSTS[this.site.id];
    if (!host) {
      this.log('ERROR:WS', `Site ${this.site.id} chưa có wsHost — không kết nối được hub lì xì.`);
      return;
    }
    const gen = ++this.wsGeneration;
    this.wsHandshakeDone = false;
    this.wsRxBuf = Buffer.alloc(0);
    const url = `wss://${host}/livestream?timestamp=${Date.now()}`;
    this.log('WS', `Đang kết nối SignalR tới ${host} (MessagePack, không negotiate)...`);

    let ws;
    try {
      ws = new WebSocket(url, {
        headers: {
          'Origin': this.site.origin,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        },
        handshakeTimeout: 15000
      });
    } catch (e) {
      this.scheduleHubReconnect(`mở socket thất bại: ${e.message}`);
      return;
    }
    this.ws = ws;
    ws.binaryType = 'nodebuffer';

    ws.on('open', () => {
      if (gen !== this.wsGeneration) { try { ws.close(); } catch (e) {} return; }
      this.wsReconnects = 0;
      // Handshake SignalR: JSON text + ký tự record separator \x1e
      try { ws.send('{"protocol":"messagepack","version":1}\x1e'); } catch (e) {}
      this.log('WS', 'Đã mở socket, gửi handshake MessagePackHubProtocol...');
      // JoinGroup cần fpHash -> chờ warmVisitorId (đã chạy song song, tự fallback md5 nếu hỏng)
      this.ensureVisitorId().then(() => {
        if (gen === this.wsGeneration) this.joinGroup();
      });
      // Ping giữ kết nối (server timeout mặc định ~30s)
      clearInterval(this.wsPingTimer);
      this.wsPingTimer = setInterval(() => {
        if (this.ws === ws && ws.readyState === WebSocket.OPEN && this.wsHandshakeDone) {
          try { ws.send(encodeSignalRFrame([6])); } catch (e) {}
        }
      }, 15000);
    });

    ws.on('message', (data, isBinary) => {
      if (gen !== this.wsGeneration) return;
      this.onHubData(Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'));
    });

    ws.on('close', (code, reason) => {
      if (gen !== this.wsGeneration) return;
      clearInterval(this.wsPingTimer);
      if (this.ws === ws) this.ws = null;
      if (this.isRunning) {
        this.log('WARN:WS', `Kết nối SignalR đóng (mã ${code}${reason && reason.length ? `, ${reason}` : ''}). Đang kết nối lại...`);
        this.scheduleHubReconnect(`close ${code}`);
      }
    });

    ws.on('error', (err) => {
      if (gen !== this.wsGeneration) return;
      this.log('ERROR:WS', `Lỗi socket SignalR: ${err.message}`);
      try { ws.close(); } catch (e) {}
    });
  }

  scheduleHubReconnect(reason) {
    if (!this.isRunning || this.wsReconnectTimer) return;
    const delay = Math.min(15000, 1000 * Math.pow(2, this.wsReconnects++)) + Math.floor(Math.random() * 500);
    this.wsReconnectTimer = setTimeout(async () => {
      this.wsReconnectTimer = null;
      if (!this.isRunning) return;
      // Refresh token trước khi join lại: phiên có thể vừa hết hạn gây ngắt kết nối
      try { await withTimeout(ensureValidToken(this.primaryAccount, this.site.id, { relogin: false }), 5000, null); } catch (e) {}
      this.connectHub();
    }, delay);
  }

  // Tách handshake JSON (\x1e) và các khung msgpack varint-length
  onHubData(chunk) {
    this.wsRxBuf = Buffer.concat([this.wsRxBuf, chunk]);
    try {
      // Giai đoạn handshake: đọc các khúc JSON kết thúc bằng \x1e
      while (!this.wsHandshakeDone) {
        const idx = this.wsRxBuf.indexOf(0x1e);
        if (idx === -1) return;
        const head = this.wsRxBuf.slice(0, idx).toString('utf8');
        this.wsRxBuf = this.wsRxBuf.slice(idx + 1);
        let hs = null;
        try { hs = JSON.parse(head || '{}'); } catch (e) { hs = {}; }
        if (hs && hs.error) {
          this.wsHandshakeDone = true; // tránh lặp xử lý
          this.log('ERROR:WS', `Server từ chối handshake SignalR: ${hs.error}`);
          try { this.ws && this.ws.close(); } catch (e) {}
          return;
        }
        this.wsHandshakeDone = true;
        this.log('WS', 'Handshake SignalR thành công, đang vào nhóm phòng live...');
        // Nếu fpHash đã sẵn thì join ngay (trường hợp warm xong trước handshake)
        if (this.visitorId) this.joinGroup();
      }
      // Giai đoạn message: <varint len><payload msgpack>
      while (this.wsRxBuf.length > 0) {
        const v = readVarint(this.wsRxBuf, 0);
        if (!v) return; // chưa đủ byte độ dài
        if (this.wsRxBuf.length < v.offset + v.value) return; // chưa đủ payload
        const payload = this.wsRxBuf.slice(v.offset, v.offset + v.value);
        this.wsRxBuf = this.wsRxBuf.slice(v.offset + v.value);
        try {
          const msg = decode(payload);
          this.handleHubMessage(msg);
        } catch (e) {}
      }
    } catch (e) {
      // Buffer hỏng không thể cứu -> cắt kết nối cho reconnect dựng lại sạch
      this.log('ERROR:WS', `Không đọc được khung SignalR: ${e.message}`);
      this.wsRxBuf = Buffer.alloc(0);
      try { this.ws && this.ws.close(); } catch (e2) {}
    }
  }

  joinGroup() {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.wsHandshakeDone) return;
    const sess = getSession(this.primaryAccount, this.site.id);
    const token = sess && sess.token;
    if (!token) return;
    const id = String(++this.invocationSeq);
    try {
      ws.send(encodeSignalRFrame([1, {}, id, 'JoinGroup', [this.streamId, token, this.visitorId]]));
    } catch (e) {
      this.log('ERROR:WS', `Gửi JoinGroup thất bại: ${e.message}`);
    }
  }

  handleHubMessage(msg) {
    const type = msgType(msg);
    if (type === 6) return; // Ping
    if (type === 3) {
      // Completion của invocation (vd. JoinGroup)
      const err = msgInvocationError(msg);
      if (err) this.log('WARN:WS', `Hub báo lỗi invocation: ${String(err).slice(0, 200)}`);
      return;
    }
    if (type !== 1) return;
    const target = msgTarget(msg);
    const args = msgArgs(msg) || [];

    switch (target) {
      case 'RecvRewardAnnounce': {
        const data = args[0] || {};
        const sessionId = data.sessionId;
        const group = data.group || this.streamId;
        if (!sessionId) return;
        this.activeRewardSession = { sessionId, group };
        this.log('WS:LIXI', `🧧 PHONG BAO LÌ XÌ XUẤT HIỆN! Phiên ID: ${sessionId}`);
        if (this.config.autoLixi) {
          this.claimLixiForAllAccounts(sessionId, group);
        }
        break;
      }
      case 'CallerJoinGroup': {
        const text = String(args[0] !== undefined ? (typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0])) : '');
        if (/ok|success|thanh cong/i.test(text) || text === '') {
          this.log('WS', `Đã vào nhóm phòng live ${this.streamId} qua SignalR.`);
        } else {
          this.log('WARN:WS', `JoinGroup phản hồi: ${text.slice(0, 160)}`);
        }
        break;
      }
      case 'CallerTokenInvalid':
      case 'CallerTokenRevoked': {
        this.log('WARN:WS', 'Hub báo token không hợp lệ — đang refresh và vào lại nhóm...');
        refreshSessionToken(this.primaryAccount, this.site.id)
          .then((s) => { if (!s && canAutoRelogin(this.primaryAccount, this.site.id)) return autoRelogin(this.primaryAccount, this.site.id, p => this.log('AUTH', p.message)); return s; })
          .then(() => this.joinGroup())
          .catch(() => {});
        break;
      }
      case 'RecvStreamInfo': {
        const data = args[0];
        if (data && typeof data === 'object') this.applyStreamInfo(data);
        break;
      }
      case 'RecvAttendanceOffsets': {
        // Mốc điểm danh đổi giữa chừng -> cập nhật attendanceConfig
        const data = args[0];
        const offsets = Array.isArray(data) ? data
          : (data && (data.offsetsMinutes || data.offsets)) || null;
        if (Array.isArray(offsets) && this.stats.streamInfo) {
          this.stats.streamInfo.attendanceConfig = {
            ...(this.stats.streamInfo.attendanceConfig || {}),
            offsetsMinutes: offsets.map(Number).filter(n => !isNaN(n))
          };
          this.attendanceDone.clear();
          this.attendanceAttempts.clear();
          this.log('STREAM', `Mốc điểm danh cập nhật mới: ${this.stats.streamInfo.attendanceConfig.offsetsMinutes.join(', ')}`);
        }
        break;
      }
      default:
        break;
    }
  }

  // ============ STREAM DETAIL (REST poll 15s) ============

  // Cập nhật streamInfo từ detail / sự kiện WS; phát hiện restart (startedAt đổi)
  applyStreamInfo(data) {
    if (!data) return;
    const old = this.stats.streamInfo && this.stats.streamInfo.startedAt;
    const newStartedAt = data.startedAt;
    if (old && newStartedAt && new Date(old).getTime() !== new Date(newStartedAt).getTime()) {
      // Stream bị restart (lag) -> toàn bộ mốc điểm danh tính theo startedAt mới
      this.attendanceDone.clear();
      this.attendanceAttempts.clear();
      this.log('STREAM:RESTART', `⚠️ Stream đã restart! startedAt mới: ${newStartedAt} - reset trạng thái điểm danh.`);
    } else if (!old && newStartedAt) {
      const elapsed = Math.floor((Date.now() - new Date(newStartedAt).getTime()) / 60000);
      this.log('STREAM', `Livestream: ${data.displayName || data.userCode || this.streamId} | Đã phát: ${elapsed} phút`);
    }
    this.stats.streamInfo = { ...(this.stats.streamInfo || {}), ...data };
    this.emit('status', this.getStatus());
  }

  async refreshStreamDetail(first = false) {
    try {
      const res = await fetch(`${this.site.apiBase}/livestreams/detail/${this.streamId}`, {
        headers: { 'Origin': this.site.origin, 'Referer': this.currentUrl },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
      });
      const json = await res.json().catch(() => null);
      if (json && json.data && json.data.startedAt) {
        this.applyStreamInfo(json.data);
      }
    } catch (e) {
      if (first) this.log('WARN:STREAM', `Không lấy được thông tin livestream: ${e.message}`);
    }
  }

  startDetailPoll() {
    clearInterval(this.detailPollTimer);
    this.detailPollTimer = setInterval(() => {
      if (this.isRunning) this.refreshStreamDetail();
    }, DETAIL_POLL_MS);
  }

  // ============ ATTENDANCE SCHEDULER (REST thuần) ============
  // Khi vào window [O, O+windowDuration) của mỗi mốc, POST /attendance cho từng account
  // bằng token của chính nó. Nguồn mốc: /livestreams/detail -> startedAt + offsetsMinutes.
  startAttendanceScheduler() {
    clearInterval(this.attendanceTimer);
    let lastLoggedFinished = false;

    this.attendanceTimer = setInterval(async () => {
      try {
        const info = this.stats.streamInfo;
        if (!info || !info.startedAt || !this.isRunning) return;

        const startedAt = new Date(info.startedAt).getTime();
        // QQ88 trả danh sách mốc không theo thứ tự -> sắp xếp để tìm đúng mốc kế tiếp
        const offsets = ((info.attendanceConfig && info.attendanceConfig.offsetsMinutes) || [11, 19, 26, 33, 40, 46, 53, 60, 66, 73, 81, 88, 94, 100, 106, 113, 120])
          .map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
        const winDur = (info.attendanceConfig && info.attendanceConfig.windowDurationMinutes) || 2;
        const elapsedMin = (Date.now() - startedAt) / 60000;

        // 1. Cập nhật countdown và trạng thái mốc cho UI
        const nextOffset = offsets.find(o => o > elapsedMin);
        if (nextOffset) {
          const remSec = Math.max(0, Math.floor((nextOffset - elapsedMin) * 60));
          const mm = String(Math.floor(remSec / 60)).padStart(2, '0');
          const ss = String(remSec % 60).padStart(2, '0');
          this.stats.nextOffset = nextOffset;
          this.stats.nextOffsetCountdown = `${mm}:${ss}`;
          this.stats.attendanceStatus = `Đang đếm ngược mốc ${nextOffset}m`;
        } else {
          this.stats.nextOffset = 'Đã hết mốc';
          this.stats.nextOffsetCountdown = '--:--';
          const maxO = offsets[offsets.length - 1] || 120;
          this.stats.attendanceStatus = `Đã qua hết các mốc điểm danh (${Math.floor(elapsedMin)}m / tối đa ${maxO}m)`;
          if (!lastLoggedFinished) {
            lastLoggedFinished = true;
            this.log('INFO:ATTENDANCE', `ℹ️ Phiên livestream này đã phát được ${Math.floor(elapsedMin)} phút (đã qua hết các mốc điểm danh tối đa ${maxO}m).`);
          }
        }

        // 2. Điểm danh nếu trong khung giờ mốc
        const activeOffset = offsets.find(o => elapsedMin >= o && elapsedMin < o + winDur);
        if (activeOffset === undefined) {
          this.emit('status', this.getStatus());
          return;
        }

        const streamId = this.streamId;
        for (const acc of this.targetAccounts) {
          const key = `${acc.username}:${activeOffset}`;
          if (this.attendanceDone.has(key)) continue;

          const sess = (await ensureValidToken(acc.username, this.site.id, { relogin: false })) || getSession(acc.username, this.site.id);
          if (!sess || !sess.token) continue;

          this.attendanceDone.add(key);
          const attempts = (this.attendanceAttempts.get(key) || 0) + 1;
          this.attendanceAttempts.set(key, attempts);

          fetch(`${this.site.apiBase}/livestreams/${streamId}/attendance`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${sess.token}`,
              'Origin': this.site.origin,
              'Referer': this.currentUrl
            },
            body: JSON.stringify({ offsetMinutes: activeOffset }),
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
          }).then(r => r.json()).then(res => {
            if (res && (res.error === 0 || res.data)) {
              this.stats.attendanceLogs.push({
                username: acc.username,
                offsetMinutes: activeOffset,
                at: new Date().toISOString()
              });
              this.log('SUCCESS:ATTENDANCE', `🎉 [${acc.username}] ĐIỂM DANH THÀNH CÔNG mốc ${activeOffset}m!`);
            } else {
              const msg = (res && res.message) || 'thất bại';
              this.log('ERROR:ATTENDANCE', `[${acc.username}] mốc ${activeOffset}m: ${msg}`);
              if (String(msg).includes('Ngoài khung giờ') && attempts < 8) {
                this.attendanceDone.delete(key);
              }
            }
            this.emit('status', this.getStatus());
          }).catch(err => {
            // Giới hạn số lần thử lại: lỗi mạng/HTTP 429 (không phải JSON) không được retry mỗi giây vô hạn
            if (attempts < 8) this.attendanceDone.delete(key);
            this.log('ERROR:ATTENDANCE', `[${acc.username}] mốc ${activeOffset}m lỗi kết nối (lần ${attempts}): ${err.message}`);
          });
        }
      } catch (e) {}
    }, 1000);
  }

  // ============ fpHash (visitorId) — đọc từ site bằng context headless 1 lần ============

  ensureVisitorId() {
    if (this.visitorId) return Promise.resolve(this.visitorId);
    if (!this.visitorIdPromise) {
      this.visitorIdPromise = Promise.resolve(this.visitorId);
    }
    return this.visitorIdPromise;
  }

  // Lấy visitorId trước khi lì xì rơi / JoinGroup. Ưu tiên fpHash do CHÍNH site tính
  // (đọc từ React context AuthProvider); đọc hỏng mới fallback md5(primaryAccount).
  async warmVisitorId(token) {
    if (this.visitorIdPromise) return this.visitorIdPromise;
    this.visitorIdPromise = (async () => {
      for (let i = 0; i < 5 && this.isRunning && !this.visitorId; i++) {
        const v = await withTimeout(this.readVisitorIdFromSite(token), 25000, null);
        if (v) {
          this.visitorId = v;
          this.log('DEVICE', `Mã thiết bị (fpHash): ${v.slice(0, 8)}… (lấy từ chính site, cache dùng lại)`);
          this.closeFpPage();
          break;
        }
        await sleep(4000);
      }
      if (!this.visitorId) {
        this.visitorId = crypto.createHash('md5').update(String(this.primaryAccount || 'anon')).digest('hex');
        this.log('WARN:DEVICE', `Không đọc được fpHash từ site -> dùng mã thiết bị tự tính ${this.visitorId.slice(0, 8)}… (có thể kém hợp lệ hơn)`);
        this.closeFpPage();
      }
      return this.visitorId;
    })();
    return this.visitorIdPromise;
  }

  // Mở 1 context headless tối giản (chặn media/font/websocket) tới trang live, quét React fiber
  // tìm AuthProvider.memoizedProps.value.fpHash — giống hệt cách tracker.js đã làm.
  async readVisitorIdFromSite(token) {
    try {
      if (!this.fpBrowser) {
        const { chromium } = require('playwright-extra');
        const stealth = require('puppeteer-extra-plugin-stealth')();
        chromium.use(stealth);
        const chromePath = findChrome();
        const launchOptions = {
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding'
          ],
          ignoreDefaultArgs: ['--enable-automation']
        };
        this.fpBrowser = chromePath
          ? await chromium.launch({ ...launchOptions, executablePath: chromePath })
          : await chromium.launch(launchOptions);
      }
      if (!this.fpContext) {
        this.fpContext = await this.fpBrowser.newContext({ viewport: { width: 800, height: 600 } });
      }
      if (!this.fpPage || this.fpPage.isClosed()) {
        this.fpPage = await this.fpContext.newPage();
        // Chặn tài nguyên nặng + socket của chính site trong trang fingerprint
        await this.fpPage.route('**/*', route => {
          const t = route.request().resourceType();
          if (t === 'image' || t === 'media' || t === 'font') route.abort().catch(() => {});
          else route.continue().catch(() => {});
        });
        try { await this.fpPage.routeWebSocket(/./, ws => ws.close()); } catch (e) {}
        if (token) {
          await this.fpPage.addInitScript((t) => { try { localStorage.setItem('token', t); } catch (e) {} }, token);
        }
        await this.fpPage.goto(this.currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }
      return await this.fpPage.evaluate(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const readSiteFp = () => {
          const root = document.getElementById('root');
          const key = root && Object.keys(root).find(k => k.startsWith('__reactContainer'));
          if (!key) return null;
          const stack = [root[key]];
          let n = 0;
          while (stack.length && n < 30000) {
            const f = stack.pop();
            n++;
            if (!f) continue;
            const v = f.memoizedProps && f.memoizedProps.value;
            if (v && typeof v === 'object' && typeof v.fpHash === 'string' && v.fpHash) return v.fpHash;
            if (f.sibling) stack.push(f.sibling);
            if (f.child) stack.push(f.child);
          }
          return null;
        };
        // Site tính fpHash bất đồng bộ sau khi tải trang -> chờ tối đa ~10s
        for (let i = 0; i < 40 && document.getElementById('root'); i++) {
          const fp = readSiteFp();
          if (fp) return fp;
          await wait(250);
        }
        // Dự phòng: FingerprintJS CDN (có thể khác bản site đóng gói -> chỉ dùng khi bất lực)
        try {
          const FingerprintJS = await import('https://openfpcdn.io/fingerprintjs/v4');
          const fp = await FingerprintJS.load();
          const res = await fp.get();
          if (res && res.visitorId && res.visitorId.length >= 16) return res.visitorId;
        } catch (e) {}
        return null;
      });
    } catch (e) {
      return null;
    }
  }

  async closeFpPage() {
    const page = this.fpPage;
    const ctx = this.fpContext;
    const br = this.fpBrowser;
    this.fpPage = null;
    this.fpContext = null;
    this.fpBrowser = null;
    try { if (ctx) await ctx.close(); } catch (e) {}
    try { if (br) await br.close(); } catch (e) {}
  }

  // ============ SESSION KEEPALIVE ============

  startSessionKeepalive() {
    clearInterval(this.sessionKeepaliveTimer);
    const tick = async () => {
      for (const acc of this.targetAccounts) {
        if (!this.isRunning) return;
        try { await ensureValidToken(acc.username, this.site.id, { onProgress: p => this.log('AUTH', p.message) }); } catch (e) {}
      }
    };
    tick();
    this.sessionKeepaliveTimer = setInterval(tick, SESSION_KEEPALIVE_MS);
  }

  // ============ PROXY HEALTH (mỗi tài khoản 1 IP riêng) ============
  // Server báo "Hệ thống đang bận" cho các tài khoản claim cùng IP -> tài khoản có proxy
  // sẽ POST claim qua proxy riêng; proxy chết -> đánh dấu dead 60s và dùng IP máy.

  initProxyHealth() {
    for (const acc of this.targetAccounts) {
      const sess = getSession(acc.username, this.site.id);
      const proxy = sess && parseProxy(sess.proxy);
      if (!proxy || /^socks/i.test(proxy.server)) continue; // undici chỉ hỗ trợ http(s) CONNECT
      this.proxyHealth.set(acc.username, { proxy, dead: false, deadUntil: 0, deadLogged: false });
    }
    if (this.proxyHealth.size) {
      this.log('PROXY', `Dùng proxy riêng cho ${this.proxyHealth.size} tài khoản: ${[...this.proxyHealth.keys()].join(', ')}`);
    }
  }

  markProxyDead(username, reason) {
    const lane = this.proxyHealth.get(username);
    if (!lane) return;
    lane.dead = true;
    lane.deadUntil = Date.now() + 60000;
    if (!lane.deadLogged) {
      lane.deadLogged = true;
      this.log('WARN:PROXY', `[${username}] Proxy ${lane.proxy.server.replace(/^\w+:\/\//, '')} KHÔNG kết nối được (${reason}) - tạm nhận lì xì bằng IP máy, tự dùng lại proxy khi nó chạy lại.`);
    }
  }

  proxyFor(username) {
    const lane = this.proxyHealth.get(username);
    if (!lane) return null;
    if (lane.dead) {
      if (Date.now() < lane.deadUntil) return null;
      // Hết thời gian cách ly -> cho proxy thử lại 1 lần
      lane.dead = false;
      lane.deadLogged = false;
      this.log('PROXY', `[${username}] Thử lại proxy ${lane.proxy.server.replace(/^\w+:\/\//, '')}...`);
    }
    return lane.proxy;
  }

  // ============ LÌ XÌ: CLAIM TRỰC TIẾP QUA REST ============

  isLixiClaimed(username, sessionKey) {
    return this.stats.lixiClaimed.some(c => c.username === username && String(c.sessionId) === sessionKey);
  }

  // Bảng kết quả lì xì theo phiên (hiện trên UI, không trôi theo log):
  // mỗi tài khoản 1 dòng/phiên — trạng thái success | pending | failed + điểm/code/lý do.
  recordLixiResult(username, sessionKey, status, extra = {}) {
    if (!sessionKey) return null;
    const key = String(sessionKey);
    let entry = this.stats.lixiResults.find(r => r.username === username && String(r.sessionId) === key);
    if (entry) {
      entry.status = status;
      if (extra.rewardPoint !== undefined) entry.rewardPoint = extra.rewardPoint;
      if (extra.code !== undefined) entry.code = extra.code;
      if (extra.message !== undefined) entry.message = extra.message;
      entry.at = new Date().toISOString();
    } else {
      entry = {
        username,
        sessionId: key,
        status,
        rewardPoint: extra.rewardPoint || 0,
        code: extra.code || null,
        message: extra.message || '',
        at: new Date().toISOString()
      };
      this.stats.lixiResults.unshift(entry);
      if (this.stats.lixiResults.length > 300) this.stats.lixiResults.length = 300;
    }
    return entry;
  }

  getLixiResult(username, sessionKey) {
    return this.stats.lixiResults.find(r => r.username === username && String(r.sessionId) === String(sessionKey)) || null;
  }

  async claimLixiForAllAccounts(sessionId, group) {
    if (!this.config.autoLixi || !sessionId) return;
    const sessionKey = String(sessionId);
    if (this.claimedLixiSessions.has(sessionKey)) return;
    this.claimedLixiSessions.add(sessionKey);

    try {
      const streamId = group || this.streamId;
      const claimUrl = `${this.site.apiBase}/livestreams/${streamId}/reward/${sessionId}/claim`;
      const usernames = this.targetAccounts.map(a => a.username);
      const t0 = Date.now();
      const pool = this.farmer ? this.farmer.getPoolSize() : 0;
      this.log('ACTION:LIXI', `🧧 Bắt đầu nhận Lì Xì song song cho ${usernames.length} tài khoản (Phiên: ${sessionId}, token sẵn: ${pool})...`);

      // Mỗi tài khoản chạy độc lập và tự thử lại ngay khi gặp lỗi tạm thời
      const out = await Promise.all(usernames.map(u =>
        this.claimLixiForAccount(u, sessionKey, claimUrl, t0).catch((err) => {
          if (this.isRunning) this.log('ERROR:LIXI', `[${u}] Lỗi không mong muốn: ${err.message}`);
          return 'fail';
        })
      ));

      if (this.isRunning) {
        // Tài khoản thất bại sau mọi lần thử mà postAndRecord chưa ghi lý do -> ghi dòng chung
        usernames.forEach((u, i) => {
          if (out[i] !== 'ok' && !this.getLixiResult(u, sessionKey)) {
            this.recordLixiResult(u, sessionKey, 'failed', { message: 'Không nhận được (hết lượt / lỗi hệ thống)' });
          }
        });
        const rows = usernames.map(u => this.getLixiResult(u, sessionKey));
        const okRows = rows.filter(r => r && r.status !== 'failed');
        const winTxt = okRows.length
          ? okRows.map(r => `${r.username}${r.rewardPoint ? ` +${r.rewardPoint}đ` : ''}${r.code ? ` [${r.code}]` : ''}${r.status === 'pending' ? ' ⏳' : ''}`).join(', ')
          : 'không có';
        const failTxt = usernames.filter((u, i) => out[i] !== 'ok' && !(rows[i] && rows[i].status !== 'failed')).join(', ') || 'không có';
        this.log('LIXI:SUMMARY', `Hoàn tất phiên ${sessionId} (${Date.now() - t0}ms): ✅ ${okRows.length}/${usernames.length} — Trúng: ${winTxt} | Trượt: ${failTxt}`);
      }
    } catch (err) {
      this.log('ERROR:LIXI', `Lỗi xử lý phiên lì xì ${sessionId}: ${err.message}`);
    } finally {
      this.emit('status', this.getStatus());
    }
  }

  // Trả về 'ok' | 'fail'. Lỗi tạm thời (mạng, 5xx, 429, 401, thiếu token) được thử lại ngay 1 lần
  async claimLixiForAccount(username, sessionKey, claimUrl, t0) {
    let retries = 0;
    for (let attempt = 1; ; attempt++) {
      const r = await this.claimLixiOnce(username, sessionKey, claimUrl, t0);
      if (r === 'ok' || r === 'fail' || !this.isRunning) return r === 'ok' ? 'ok' : 'fail';
      if (r === 'busy') {
        if (attempt >= BUSY_MAX_ATTEMPTS) return 'fail';
        await sleep(BUSY_RETRY_DELAY_MS);
        continue;
      }
      if (++retries >= 2) return 'fail';
      await sleep(RETRY_DELAY_MS);
    }
  }

  // Lấy token Turnstile mới nhất từ bể farmer (duy nhất nguồn mint — không còn tab trang live)
  async getFreshToken(timeoutMs = 20000) {
    if (!this.farmer) return null;
    // Farmer chưa chạy (start hỏng) -> thử khởi động lại rồi chờ token
    if (!this.farmer.isRunning && !this.farmerStarting) {
      this.farmerStarting = this.farmer.start().then((started) => {
        this.farmerStarting = null;
        if (started && this.isRunning && this.config.autoLixi) {
          this.farmer.setDemand(true, this.targetAccounts.length * 2 + 1);
        }
      }).catch(() => { this.farmerStarting = null; });
    }
    return this.farmer.waitForToken(timeoutMs);
  }

  async claimLixiOnce(username, sessionKey, claimUrl, t0) {
    if (this.isLixiClaimed(username, sessionKey)) return 'ok';
    if (!this.isRunning) return 'fail';

    // Keepalive đã giữ token còn hạn; không để 1 lần refresh treo làm chậm cả lượt claim
    const sess = (await withTimeout(ensureValidToken(username, this.site.id, { relogin: false }), 3000, null)) || getSession(username, this.site.id);
    if (!sess || !sess.token) {
      this.log('WARN:LIXI', `[${username}] Bỏ qua vì chưa có phiên đăng nhập.`);
      return 'fail';
    }

    // visitorId đã được làm nóng lúc khởi động; chờ ngắn nếu chưa xong
    if (!this.visitorId) {
      await withTimeout(this.ensureVisitorId(), 3000, null);
    }
    const visitorId = this.visitorId;

    // Đường nhanh: token Turnstile có sẵn trong bể -> POST ngay
    const pooledToken = this.farmer ? this.farmer.consumeToken() : null;
    if (pooledToken) {
      const outcome = await this.postAndRecord(username, sessionKey, claimUrl, sess, pooledToken, visitorId, { fromPool: true, t0 });
      // 'busy' trả về ngay để vòng ngoài thử lại nhanh với token kế tiếp trong bể
      if (outcome !== 'slow') return outcome;
      if (!this.isRunning) return 'fail';
      this.log('WARN:LIXI', `[${username}] Token có sẵn bị từ chối, lấy token mới...`);
    } else if (this.isRunning) {
      this.log('WARN:LIXI', `[${username}] Bể token trống, chờ trình nạp token...`);
    }

    const fresh = await this.getFreshToken(20000);
    if (!this.isRunning) return 'fail';
    if (fresh) {
      return this.postAndRecord(username, sessionKey, claimUrl, sess, fresh, visitorId, { fromPool: false, t0 });
    }

    this.log('ERROR:LIXI', `[${username}] Không lấy được token Turnstile (+${Date.now() - t0}ms).`);
    return 'retry';
  }

  // deviceHash 32-char hex (chuẩn FingerprintJS x64hash128), độc nhất & ổn định cho từng user
  buildDeviceHash(username, visitorId) {
    if (username === this.primaryAccount && visitorId && /^[0-9a-f]{32}$/i.test(visitorId)) {
      return visitorId;
    }
    const seed = `${visitorId || '78win_live_v1'}:${username}`;
    return crypto.createHash('md5').update(seed).digest('hex');
  }

  // POST claim trực tiếp (không qua trang). Tài khoản có proxy -> request qua proxy của nó.
  async postClaim(username, url, bearer, turnstileToken, deviceHash) {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${bearer}`,
      'Origin': this.site.origin,
      'Referer': this.currentUrl
    };
    const body = JSON.stringify({ turnstileToken, deviceHash });
    const proxy = this.proxyFor(username);
    try {
      if (proxy) {
        const r = await proxiedRequest(url, { method: 'POST', headers, body, proxy, timeoutMs: HTTP_TIMEOUT_MS });
        let json = null;
        try { json = JSON.parse(r.rawText); } catch (e) {}
        return { status: r.status, ok: r.ok, data: json, rawText: r.rawText };
      }
      const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) {}
      return { status: r.status, ok: r.ok, data: json, rawText: text };
    } catch (err) {
      if (proxy) this.markProxyDead(username, err.message);
      return { status: 0, ok: false, error: err.message };
    }
  }

  // Server xử lý 1 claim mất ~1-2s và trả "đang bận" nếu cùng IP có claim khác đang xử lý
  // -> các POST cùng IP (máy, hoặc cùng 1 proxy) gửi LẦN LƯỢT: chờ response trước rồi mới gửi tiếp.
  async withIpLock(key, fn) {
    const prev = this.ipLocks.get(key) || Promise.resolve();
    let release;
    const mine = new Promise(r => { release = r; });
    const tail = prev.then(() => mine);
    this.ipLocks.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.ipLocks.get(key) === tail) this.ipLocks.delete(key);
    }
  }

  // Trả về 'ok' | 'fail' | 'retry' | 'slow' (token từ bể bị từ chối vì lý do khác hết lì xì -> thử token mới)
  async postAndRecord(username, sessionKey, claimUrl, sess, turnstileToken, visitorId, { fromPool, t0 = Date.now() }) {
    const deviceHash = this.buildDeviceHash(username, visitorId);
    const proxy = this.proxyFor(username);
    const ipKey = proxy ? proxy.server : 'local';

    const result = await this.withIpLock(ipKey, async () => {
      if (this.isLixiClaimed(username, sessionKey) || !this.isRunning) return null;
      return this.postClaim(username, claimUrl, sess.token, turnstileToken, deviceHash);
    });
    if (this.isLixiClaimed(username, sessionKey)) return 'ok';
    if (!this.isRunning || !result) return 'fail';
    const resData = result.data;

    if (resData && (resData.error === 0 || resData.isSuccess)) {
      if (this.isLixiClaimed(username, sessionKey)) return 'ok';
      if (this.site.claimStatusCheck) {
        // QQ88: claim chỉ được xếp hàng -> ghi nhận ngay (chặn claim trùng) rồi hỏi trạng thái để lấy điểm / mã Code
        const entry = { username, rewardPoint: 0, code: null, status: 'pending', sessionId: sessionKey, at: new Date().toISOString() };
        this.stats.lixiClaimed.push(entry);
        this.recordLixiResult(username, sessionKey, 'pending', { message: 'Đang chờ hệ thống trả phần thưởng' });
        this.log('SUCCESS:LIXI', `🎁 [${username}] Đã giành được lì xì! Đang chờ hệ thống trả phần thưởng... (+${Date.now() - t0}ms)`);
        this.emit('status', this.getStatus());
        this.pollRewardStatus(entry, claimUrl, sess);
        return 'ok';
      }
      const rewardPoint = (resData.data && resData.data.rewardPoint) || 0;
      this.stats.lixiClaimed.push({
        username,
        rewardPoint,
        sessionId: sessionKey,
        at: new Date().toISOString()
      });
      this.stats.totalRewardPoints += rewardPoint;
      this.recordLixiResult(username, sessionKey, 'success', { rewardPoint });
      this.log('SUCCESS:LIXI', `🎁 [${username}] NHẬN LÌ XÌ THÀNH CÔNG! Được +${rewardPoint} điểm! (+${Date.now() - t0}ms)`);
      this.emit('status', this.getStatus());
      return 'ok';
    }
    if (!this.isRunning) return 'fail';

    const status = result.status;
    const msg = (resData && (resData.message || resData.errorMessage)) || result.rawText || result.error || 'Thất bại';
    const code = resData && resData.error !== undefined ? ` (Mã: ${resData.error})` : (status ? ` (HTTP ${status})` : '');
    this.log('ERROR:LIXI', `[${username}] Nhận lì xì: ${String(msg).slice(0, 200)}${code} (+${Date.now() - t0}ms)`);

    if (status === 401) {
      // Token bị server thu hồi/hết hạn sớm hơn exp -> refresh; refresh hỏng thì tự đăng nhập lại (chạy nền)
      const refreshed = await refreshSessionToken(username, this.site.id);
      if (!refreshed && canAutoRelogin(username, this.site.id)) {
        autoRelogin(username, this.site.id, p => this.log('AUTH', p.message));
      }
      return 'retry';
    }
    // Server quá tải (mã -5 "đang bận xử lý") -> không phải lỗi token, thử lại liên tục
    if (/bận xử lý|thử lại sau/i.test(String(msg))) return 'busy';
    if (status === 0 || status === 409 || status === 429 || status >= 500 || !resData) return 'retry';
    // Lỗi xác minh (turnstile / thiết bị / IP): frontend cho phép thử lại -> thử lại với token mới
    if (!fromPool && QQ88_RETRYABLE.test(normalizeVi(msg))) return 'retry';
    // "Phần thưởng đã được phát hết" -> hết lì xì cho mọi người, thử lại vô ích
    if (fromPool && !/phát hết|hết lượt|đã nhận/i.test(String(msg))) return 'slow';
    // Lỗi dứt khoát (hết quà, đã nhận, sai phiên...) -> ghi vào bảng kết quả để user đọc lại
    this.recordLixiResult(username, sessionKey, 'failed', { message: String(msg).slice(0, 200) });
    this.emit('status', this.getStatus());
    return 'fail';
  }

  // QQ88: check-status cần id tài khoản lấy từ /account/me (như frontend), không phải localStorage.userId
  async getAccountId(username, sess) {
    if (this.accountIds.has(username)) return this.accountIds.get(username);
    let id = null;
    try {
      const res = await fetch(`${this.site.apiBase}/account/me`, {
        headers: { 'Authorization': `Bearer ${sess.token}`, 'Origin': this.site.origin },
        signal: AbortSignal.timeout(8000)
      });
      const j = await res.json().catch(() => null);
      id = (j && j.data && j.data.id) || null;
    } catch (e) {}
    if (id) this.accountIds.set(username, id);
    return id || sess.userId || '';
  }

  // QQ88: sau khi claim được nhận, gọi GET /livestreams/check-status mỗi 3s (tối đa 15 lần, như frontend)
  // để biết phần thưởng là điểm hay mã Code.
  async pollRewardStatus(entry, claimUrl, sess) {
    const m = String(claimUrl).match(/\/livestreams\/([^/]+)\/reward\/([^/]+)\/claim/);
    if (!m) return;
    const [, group, sessionId] = m;
    const userId = await this.getAccountId(entry.username, sess);
    const url = `${this.site.apiBase}/livestreams/check-status?groupId=${encodeURIComponent(decodeURIComponent(group))}&sessionId=${encodeURIComponent(decodeURIComponent(sessionId))}&userId=${encodeURIComponent(userId)}`;
    for (let i = 0; i < 15 && this.isRunning; i++) {
      await sleep(3000);
      const bearer = (getSession(entry.username, this.site.id) || sess).token;
      const r = await withTimeout(fetch(url, {
        headers: { 'Authorization': `Bearer ${bearer}`, 'Origin': this.site.origin },
        signal: AbortSignal.timeout(10000)
      }).then(res => res.json()).catch(() => null), 10000, null);
      const d = r && r.data;
      if (r && r.error === 0 && d && d.status === 'success') {
        entry.status = 'success';
        if (d.type === 'Code') {
          entry.code = d.code || null;
          entry.rewardPoint = Number(d.value) || 0;
          this.recordLixiResult(entry.username, entry.sessionId, 'success', { rewardPoint: entry.rewardPoint, code: entry.code, message: '' });
          this.log('SUCCESS:LIXI', `🎟️ [${entry.username}] NHẬN MÃ CODE: ${d.code}${d.value ? ` (trị giá ${d.value})` : ''}`);
        } else {
          entry.rewardPoint = Number(d.value) || 0;
          this.stats.totalRewardPoints += entry.rewardPoint;
          this.recordLixiResult(entry.username, entry.sessionId, 'success', { rewardPoint: entry.rewardPoint, message: '' });
          this.log('SUCCESS:LIXI', `🎁 [${entry.username}] Được cộng ${entry.rewardPoint} điểm!`);
        }
        this.emit('status', this.getStatus());
        return;
      }
      if ((d && d.status === 'failed') || (r && r.error !== undefined && r.error !== 0)) {
        const reason = (d && d.message) || (r && r.message) || 'không rõ lý do';
        entry.status = 'failed';
        this.recordLixiResult(entry.username, entry.sessionId, 'failed', { message: String(reason).slice(0, 200) });
        this.log('ERROR:LIXI', `[${entry.username}] Hệ thống báo nhận thưởng thất bại: ${reason}`);
        this.emit('status', this.getStatus());
        // Như frontend: lỗi xác minh / đang bận được phép nhận lại (tối đa 2 lần mỗi phiên)
        if (QQ88_RETRYABLE.test(normalizeVi(reason))) this.reclaimAfterFailedStatus(entry, claimUrl);
        return;
      }
    }
    if (entry.status === 'pending' && this.isRunning) {
      this.recordLixiResult(entry.username, entry.sessionId, 'pending', { message: 'Chưa trả kết quả, kiểm tra hòm thư tài khoản game' });
      this.log('WARN:LIXI', `[${entry.username}] Hệ thống chưa trả kết quả, kiểm tra hòm thư tài khoản game trong vài phút tới.`);
    }
  }

  reclaimAfterFailedStatus(entry, claimUrl) {
    const key = `${entry.username}:${entry.sessionId}`;
    const n = (this.reclaimCounts.get(key) || 0) + 1;
    this.reclaimCounts.set(key, n);
    if (n > QQ88_MAX_RECLAIMS || !this.isRunning) return;
    // Bỏ bản ghi "đã giành được" để vòng claim không coi là đã nhận
    this.stats.lixiClaimed = this.stats.lixiClaimed.filter(c => c !== entry);
    this.log('LIXI', `[${entry.username}] Nhận lại lì xì (lần ${n}/${QQ88_MAX_RECLAIMS})...`);
    this.recordLixiResult(entry.username, entry.sessionId, 'pending', { message: `Đang nhận lại (lần ${n})` });
    this.claimLixiForAccount(entry.username, String(entry.sessionId), claimUrl, Date.now()).catch(() => {});
  }

  async stopTracking() {
    this.isRunning = false;
    clearInterval(this.attendanceTimer);
    this.attendanceTimer = null;
    clearInterval(this.sessionKeepaliveTimer);
    this.sessionKeepaliveTimer = null;
    clearInterval(this.detailPollTimer);
    this.detailPollTimer = null;
    clearInterval(this.wsPingTimer);
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    this.wsGeneration++; // vô hiệu mọi callback của socket cũ
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.terminate(); } catch (e) {}
      this.ws = null;
    }
    this.log('STOP', 'Dừng theo dõi livestream.');
    await this.closeFpPage();
    if (this.farmer) {
      await this.farmer.stop();
      this.farmer = null;
    }
    this.proxyHealth = new Map();
    this.emit('status', this.getStatus());
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      url: this.currentUrl,
      username: this.currentUsername,
      accounts: this.targetAccounts.map(a => a.username),
      config: this.config,
      stats: this.stats,
      latestLogs: this.logs.slice(0, 30),
      farmerPoolSize: this.farmer ? this.farmer.getPoolSize() : 0,
      siteId: this.site.id
    };
  }
}

// Singleton tracker instance, export cùng hợp đồng với lib/tracker.js
const trackerInstance = new LiveTrackerWS();

module.exports = {
  startTracking: (liveUrl, username, config) => trackerInstance.startTracking(liveUrl, username, config),
  stop: () => trackerInstance.stopTracking(),
  stopTracking: () => trackerInstance.stopTracking(),
  getStatus: () => trackerInstance.getStatus(),
  on: (event, cb) => trackerInstance.on(event, cb),
  emit: (event, data) => trackerInstance.emit(event, data),
  log: (type, message, data) => trackerInstance.log(type, message, data)
};

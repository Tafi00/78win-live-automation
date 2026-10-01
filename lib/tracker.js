const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const fs = require('fs');
const path = require('path');
const { getSession, listAccounts, ensureValidToken, refreshSessionToken, autoRelogin, canAutoRelogin, parseProxy } = require('./auth');
const { getSite, siteFromUrl } = require('./sites');
const crypto = require('crypto');
const { findChrome, TurnstileFarmer } = require('./turnstile');

const APP_VERSION = require('../package.json').version;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
// Lì xì phát theo kiểu ai nhanh người đó được -> chuẩn bị sẵn mọi thứ trước khi lì xì rơi
const TURNSTILE_TOKEN_TTL_MS = 240000; // token Turnstile sống 300s, chừa biên an toàn 60s
const SESSION_KEEPALIVE_MS = 120000; // refresh token đăng nhập ở nền để lúc claim không phải chờ refresh
const RETRY_DELAY_MS = 800;
// Mã -5 "Hệ thống đang bận xử lý" xảy ra khi nhiều người claim cùng lúc -> thử lại nhanh, liên tục
const BUSY_RETRY_DELAY_MS = 350;
const BUSY_MAX_ATTEMPTS = 12;
const LIXI_BLANK_PATH = "/__lixi_claim__";
const LIXI_OPEN_CONCURRENCY = 5;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// page.evaluate của Playwright không có timeout: tab treo sẽ làm cả lượt claim treo theo
const withTimeout = (promise, ms, fallback) => {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise(r => { timer = setTimeout(() => r(fallback), ms); })
  ]).finally(() => clearTimeout(timer));
};

class LiveTracker {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isRunning = false;
    this.currentUrl = null;
    this.currentUsername = null;
    this.config = {
      autoAttendance: true,
      autoLixi: true
    };
    this.stats = {
      attendanceLogs: [],
      lixiClaimed: [],
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
    this.attendanceAttempts = new Map(); // số lần thử mỗi key
    this.farmer = null;
    this.activeRewardSession = null;
    this.claimedLixiSessions = new Set();
    this.visitorId = null;
    this.sessionKeepaliveTimer = null;
    this.siteOrigin = null;
    this.openSlotsInUse = 0;
    this.site = getSite();
    this.proxyLanes = new Map(); // username -> tab riêng đi qua proxy của tài khoản
    this.ipLocks = new Map(); // ip key -> hàng đợi POST claim tuần tự theo IP
  }

  log(type, message, data = null) {
    const entry = {
      id: Date.now() + Math.random().toString(16).slice(2),
      time: new Date().toLocaleTimeString(),
      type,
      message,
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
    let targetAccounts = [];
    // Site (78win / QQ88...) xác định theo domain của link live
    this.site = siteFromUrl(liveUrl);
    const siteId = this.site.id;

    if (username === 'all' || username === 'FULL') {
      const allAccounts = await listAccounts(siteId);
      if (!allAccounts || !allAccounts.length) {
        throw new Error(`Chưa có tài khoản ${this.site.name} nào được lưu. Vui lòng đăng nhập ít nhất 1 tài khoản.`);
      }
      targetAccounts = allAccounts;
      // Ưu tiên tài khoản còn hợp lệ làm tài khoản chính (tab live), tránh mở trang ở trạng thái chưa đăng nhập
      const primaryAcc = allAccounts.find(a => a.isValid) || allAccounts[0];
      primarySession = (await ensureValidToken(primaryAcc.username, siteId, { onProgress: p => this.log('AUTH', p.message) })) || getSession(primaryAcc.username, siteId);
      if (!primarySession || !primarySession.token) {
        throw new Error(`Chưa có phiên đăng nhập hợp lệ cho tài khoản "${primaryAcc.username}". Vui lòng đăng nhập lại.`);
      }
      this.targetAccounts = targetAccounts;
      this.primaryAccount = primaryAcc.username;
    } else {
      primarySession = (await ensureValidToken(username, siteId, { onProgress: p => this.log('AUTH', p.message) })) || getSession(username, siteId);
      if (!primarySession || !primarySession.token) {
        throw new Error(`Chưa có phiên đăng nhập hợp lệ cho tài khoản "${username}". Vui lòng đăng nhập trước.`);
      }
      this.targetAccounts = [{ username }];
      this.primaryAccount = username;
    }

    const session = primarySession;
    this.isRunning = true;
    this.currentUrl = liveUrl;
    this.currentUsername = username;
    this.config = { ...this.config, ...config };
    this.stats = {
      attendanceLogs: [],
      lixiClaimed: [],
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
    this.openSlotsInUse = 0;
    this.proxyLanes = new Map();
    this.ipLocks = new Map();
    const accountDesc = (username === 'all' || username === 'FULL')
      ? `TẤT CẢ TÀI KHOẢN (${this.targetAccounts.map(a => a.username).join(', ')})`
      : username;
    this.log('INIT', `[v${APP_VERSION}] [${this.site.name}] Khởi động theo dõi livestream: ${liveUrl} cho: ${accountDesc}...`);

    const chromePath = findChrome();
    const launchOptions = {
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        // Các cửa sổ context phụ thường bị che khuất -> không để Chrome bóp timer làm Turnstile treo
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows'
      ],
      ignoreDefaultArgs: ['--enable-automation']
    };

    try {
      if (chromePath) {
        this.browser = await chromium.launch({
          ...launchOptions,
          executablePath: chromePath
        });
      } else {
        this.browser = await chromium.launch(launchOptions);
      }
    } catch (e) {
      console.warn('[LAUNCH] Launch with executablePath failed, falling back to default:', e.message);
      this.browser = await chromium.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
    }

    // Lấy thông tin livestream trực tiếp từ API ngay lập tức để đồng bộ mốc
    const streamId = liveUrl.split('/').pop();
    fetch(`${this.site.apiBase}/livestreams/detail/${streamId}`)
      .then(r => r.json())
      .then(res => {
        if (res && res.data && res.data.startedAt) {
          this.stats.streamInfo = res.data;
          const elapsed = Math.floor((Date.now() - new Date(res.data.startedAt).getTime()) / 60000);
          this.log('STREAM', `Livestream: ${res.data.displayName || res.data.userCode} | Đã phát: ${elapsed} phút`);
          this.emit('status', this.getStatus());
        }
      }).catch(() => {});

    this.context = await this.browser.newContext({
      viewport: { width: 1366, height: 850 },
      storageState: session.storageState,
      userAgent: USER_AGENT
    });

    this.page = await this.context.newPage();
    // Lắng nghe trực tiếp các gói tin WebSocket (MessagePack) của SignalR qua Playwright CDP
    this.page.on('websocket', (ws) => {
      ws.on('framereceived', ({ payload }) => {
        try {
          if (!payload) return;
          const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
          const str = buf.toString('latin1');
          const targetIdx = str.indexOf('RecvRewardAnnounce');
          if (targetIdx !== -1) {
            // sessionId có thể là UUID có gạch hoặc 32 ký tự hex liền (vd. bac37225c3e84970a920e0844cdab691)
            const uuidMatch = str.slice(targetIdx).match(/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i);
            const sessionId = uuidMatch ? uuidMatch[0] : null;
            const currentStreamId = this.currentUrl ? this.currentUrl.split('/').pop() : '';
            if (sessionId) {
              const rewardData = { sessionId, group: currentStreamId };
              this.activeRewardSession = rewardData;
              this.log('WS:LIXI', `🧧 PHONG BAO LÌ XÌ XUẤT HIỆN! Phiên ID: ${sessionId}`);
              if (this.config.autoLixi) {
                this.claimLixiForAllAccounts(sessionId, currentStreamId);
              }
            }
          }
        } catch (e) {}
      });
    });

    await this.page.exposeFunction('__emitTrackerEvent', (eventObj) => {
      this.handleBrowserEvent(eventObj);
    });

    await this.page.addInitScript((tokenData) => {
      if (tokenData.token) localStorage.setItem('token', tokenData.token);
      if (tokenData.refreshToken) localStorage.setItem('refreshToken', tokenData.refreshToken);
      if (tokenData.userId) localStorage.setItem('userId', tokenData.userId);
      if (tokenData.displayName) localStorage.setItem('displayName', tokenData.displayName);
    }, {
      token: session.token,
      refreshToken: session.refreshToken,
      userId: session.userId,
      displayName: session.displayName
    });

    // Intercept window.turnstile để lưu callback onSuccess của React Turnstile component
    await this.page.addInitScript(() => {
      let _ts = window.turnstile;
      Object.defineProperty(window, 'turnstile', {
        configurable: true,
        get() { return _ts; },
        set(val) {
          _ts = val;
          if (val && typeof val.render === 'function') {
            const origRender = val.render;
            val.render = function (container, opt) {
              if (opt && opt.callback) {
                window.__turnstileSuccessCallback = opt.callback;
              }
              return origRender.apply(this, arguments);
            };
          }
        }
      });
      if (window.turnstile && typeof window.turnstile.render === 'function') {
        const origRender = window.turnstile.render;
        window.turnstile.render = function (container, opt) {
          if (opt && opt.callback) {
            window.__turnstileSuccessCallback = opt.callback;
          }
          return origRender.apply(this, arguments);
        };
      }
    });

    try {
      this.log('NAVIGATE', `Đang kết nối tới ${liveUrl}...`);
      await this.page.goto(liveUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });

      await this.injectTrackingEngine();

      // Scheduler Node-side: điểm danh trực tiếp qua API cho MỌI tài khoản
      if (this.config.autoAttendance) {
        this.startAttendanceScheduler();
      }

      // Khởi động Turnstile Token Farmer chạy ngầm không chặn luồng chính
      const accountCount = this.targetAccounts.length;
      this.farmer = new TurnstileFarmer({
        url: liveUrl,
        siteKey: this.site.siteKey,
        tokenTtl: TURNSTILE_TOKEN_TTL_MS,
        maxTabs: Math.min(6, Math.max(4, accountCount)),
        onStatus: (msg) => this.log('FARMER', msg)
      });
      this.farmer.start().then((started) => {
        if (!started) {
          this.log('WARN:LIXI', 'Không khởi động được trình nạp token -> mỗi lần lì xì rơi sẽ phải tạo token tại chỗ (chậm).');
          return;
        }
        if (this.config.autoLixi && this.farmer) {
          // Giữ sẵn mỗi tài khoản 2 token: đủ cho lượt đầu + thử lại / 2 phiên lì xì liên tiếp mà không phải chờ nạp
          this.farmer.setDemand(true, accountCount * 2 + 1);
        }
      }).catch((e) => {
        this.log('FARMER', `Chế độ nạp token ngầm: ${e.message}`);
      });

      // Origin của site để mở tab tạm nhận lì xì cho tài khoản phụ
      this.siteOrigin = new URL(liveUrl).origin;

      if (this.config.autoLixi) {
        // Làm nóng visitorId (tải FingerprintJS mất 1-2s) và giữ token đăng nhập luôn còn hạn
        this.warmVisitorId();
        this.startSessionKeepalive();
        this.startProxyLanes();
      }

      this.log('READY', `Đang theo dõi trực tiếp. Chờ sự kiện Điểm danh & Lì xì...`);
      this.emit('status', this.getStatus());
    } catch (err) {
      this.log('ERROR', `Lỗi khi kết nối livestream: ${err.message}`);
      await this.stopTracking();
      throw err;
    }
  }

  // Lấy visitorId trước khi lì xì rơi (thử lại tới khi được) để lúc claim không phải chờ FingerprintJS
  async warmVisitorId() {
    for (let i = 0; i < 10 && this.isRunning && !this.visitorId; i++) {
      const page = this.page && !this.page.isClosed() ? this.page : null;
      const v = page ? await withTimeout(this.getVisitorIdInPage(page), 20000, null) : null;
      if (v) { this.visitorId = v; return; }
      await sleep(5000);
    }
  }

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

  // ============ NODE-SIDE ATTENDANCE SCHEDULER ============
  // Single source of truth: khi vào window [O, O+windowDuration) của mỗi mốc,
  // POST /attendance trực tiếp cho từng account bằng token của chính nó.
  startAttendanceScheduler() {
    clearInterval(this.attendanceTimer);
    let lastLoggedFinished = false;

    this.attendanceTimer = setInterval(async () => {
      try {
        const info = this.stats.streamInfo;
        if (!info || !info.startedAt || !this.isRunning) return;

        const startedAt = new Date(info.startedAt).getTime();
        // QQ88 trả danh sách mốc không theo thứ tự (vd. [..., 115, 45, 60, 20]) -> sắp xếp để tìm đúng mốc kế tiếp
        const offsets = ((info.attendanceConfig && info.attendanceConfig.offsetsMinutes) || [11, 19, 26, 33, 40, 46, 53, 60, 66, 73, 81, 88, 94, 100, 106, 113, 120])
          .map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
        const winDur = (info.attendanceConfig && info.attendanceConfig.windowDurationMinutes) || 2;
        const elapsedMin = (Date.now() - startedAt) / 60000;

        // 1. Cập nhật countdown và trạng thái mốc cho UI trực tiếp từ Node.js
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

        const streamId = this.currentUrl.split('/').pop();
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
              'Authorization': `Bearer ${sess.token}`
            },
            body: JSON.stringify({ offsetMinutes: activeOffset })
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
            // Giới hạn số lần thử lại: trước đây lỗi mạng/HTTP 429 (không phải JSON) bị retry mỗi giây vô hạn
            if (attempts < 8) this.attendanceDone.delete(key);
            this.log('ERROR:ATTENDANCE', `[${acc.username}] mốc ${activeOffset}m lỗi kết nối (lần ${attempts}): ${err.message}`);
          });
        }
      } catch (e) {}
    }, 1000);
  }

  handleBrowserEvent(evt) {
    if (!evt || !evt.type) return;

    switch (evt.type) {
      case 'STREAM_DETAIL':
        {
          const newStartedAt = evt.data.startedAt;
          const old = this.stats.streamInfo && this.stats.streamInfo.startedAt;
          if (old && new Date(old).getTime() !== new Date(newStartedAt).getTime()) {
            // Stream bị restart (lag) -> toàn bộ mốc điểm danh tính theo startedAt mới
            this.attendanceDone.clear();
            this.attendanceAttempts.clear();
            this.log('STREAM:RESTART', `⚠️ Stream đã restart! startedAt mới: ${newStartedAt} -reset trạng thái điểm danh.`);
          } else if (!old) {
            this.log('STREAM', `Thông tin: Streamer ${evt.data.displayName || evt.data.userCode} | Bắt đầu: ${newStartedAt}`);
          }
          this.stats.streamInfo = evt.data;
        }
        break;

      case 'ATTENDANCE_COUNTDOWN':
        this.stats.nextOffset = evt.data.nextOffset;
        this.stats.nextOffsetCountdown = evt.data.countdown;
        this.emit('status', this.getStatus());
        break;

      case 'ATTENDANCE_BUTTON_VISIBLE':
        this.log('DOM:ATTENDANCE', `Nút Điểm danh đã xuất hiện: "${evt.data.text}" (tự động bấm)`);
        break;

      case 'ATTENDANCE_HTTP':
        // Response từ POST /attendance trong page (axios XHR hoặc fetch)
        {
          const body = evt.data.body;
          const status = evt.data.status;
          const offset = evt.data.offsetMinutes != null ? evt.data.offsetMinutes : this.stats.nextOffset;
          const key = `${this.primaryAccount}:${offset}`;
          if (status === 200 && body && (body.error === 0 || body.data)) {
            if (!this.attendanceDone.has(key)) {
              this.attendanceDone.add(key);
              this.stats.attendanceLogs.push({
                username: this.primaryAccount,
                offsetMinutes: offset,
                at: new Date().toISOString()
              });
              this.log('SUCCESS:ATTENDANCE', `🎉 [${this.primaryAccount}] ĐIỂM DANH THÀNH CÔNG mốc ${offset}m (qua trang web)!`);
            }
          } else if (
            !String((body && body.message) || '').includes('Ngoài khung giờ') &&
            // Scheduler Node đã điểm danh xong mốc này -> lỗi "đã điểm danh" từ nút trên trang là bình thường
            !this.stats.attendanceLogs.some(l => l.username === this.primaryAccount && l.offsetMinutes === offset)
          ) {
            // "Ngoài khung giờ" xuất hiện hàng loạt khi stream lag - chỉ log 1 lần
            this.log('ERROR:ATTENDANCE', `[${this.primaryAccount}] Trang web báo: ${(body && body.message) || ('HTTP ' + status)}`);
          }
        }
        break;

      case 'LIXI_ANNOUNCED':
        this.activeRewardSession = evt.data;
        this.log('WS:LIXI', `🧧 PHONG BAO LÌ XÌ XUẤT HIỆN! Phiên ID: ${evt.data ? evt.data.sessionId : ''}`);
        if (this.config.autoLixi && evt.data && evt.data.sessionId) {
          this.claimLixiForAllAccounts(evt.data.sessionId, evt.data.group);
        }
        break;

      case 'LIXI_CLICKED':
        this.log('DOM:LIXI', `Đã bắt trúng bao lì xì! Mở popup xác thực...`);
        let clickSession = (evt.data && evt.data.sessionId)
          ? evt.data
          : (this.activeRewardSession || null);
        if (!clickSession && this.page) {
          this.page.evaluate(() => {
            return typeof window.findRewardSessionFromDOM === 'function' ? window.findRewardSessionFromDOM() : null;
          }).then(domSess => {
            if (domSess && domSess.sessionId) {
              this.activeRewardSession = domSess;
              if (this.config.autoLixi) {
                this.claimLixiForAllAccounts(domSess.sessionId, domSess.group);
              }
            }
          }).catch(() => {});
        } else if (this.config.autoLixi && clickSession && clickSession.sessionId) {
          this.claimLixiForAllAccounts(clickSession.sessionId, clickSession.group);
        }
        break;

      case 'LIXI_MODAL_READY':
        this.log('MODAL', `Popup lì xì đã mở. Đang nạp token Turnstile & mở quà...`);
        let modalSession = (evt.data && evt.data.sessionId)
          ? evt.data
          : (this.activeRewardSession || null);
        if (!modalSession && this.page) {
          this.page.evaluate(() => {
            return typeof window.findRewardSessionFromDOM === 'function' ? window.findRewardSessionFromDOM() : null;
          }).then(domSess => {
            if (domSess && domSess.sessionId) {
              this.activeRewardSession = domSess;
              if (this.config.autoLixi) {
                this.claimLixiForAllAccounts(domSess.sessionId, domSess.group);
              }
            }
          }).catch(() => {});
        } else if (this.config.autoLixi && modalSession && modalSession.sessionId) {
          this.claimLixiForAllAccounts(modalSession.sessionId, modalSession.group);
        }
        break;
      case 'TURNSTILE_TOKEN':
        // Token của widget trên trang được chính trang dùng để claim cho tài khoản chính,
        // KHÔNG đưa vào bể dùng chung (token Turnstile chỉ dùng được 1 lần).
        break;
      case 'LIXI_CLAIM_HTTP':
        {
          const body = evt.data.body;
          const status = evt.data.status;
          // Lấy sessionId từ chính URL claim; activeRewardSession có thể đã bị phiên mới ghi đè
          const urlMatch = String(evt.data.url || '').match(/\/reward\/([^/]+)\/claim/);
          const claimSessionId = urlMatch
            ? decodeURIComponent(urlMatch[1])
            : (this.activeRewardSession && this.activeRewardSession.sessionId);
          const claimSessionKey = claimSessionId != null ? String(claimSessionId) : null;
          if (status === 200 && body && body.error === 0) {
            const rewardPoint = (body.data && body.data.rewardPoint) || 0;
            if (!claimSessionKey || !this.isLixiClaimed(this.primaryAccount, claimSessionKey)) {
              this.stats.lixiClaimed.push({
                username: this.primaryAccount,
                rewardPoint,
                sessionId: claimSessionKey,
                at: new Date().toISOString()
              });
              this.stats.totalRewardPoints += rewardPoint;
              this.log('SUCCESS:LIXI', `🎁 [${this.primaryAccount}] NHẬN LÌ XÌ THÀNH CÔNG! Được +${rewardPoint} điểm!`);
            }
          } else if (!claimSessionKey || !this.isLixiClaimed(this.primaryAccount, claimSessionKey)) {
            // Tool đã claim trực tiếp cho tài khoản chính thì lỗi "đã nhận" từ nút trên trang là bình thường
            this.log('ERROR:LIXI', `[Giao diện] Nhận lì xì thất bại: ${(body && (body.message || body.errorMessage)) || ('HTTP ' + status)}`);
          }
          this.emit('status', this.getStatus());
        }
        break;

      case 'LOG':
        this.log(evt.level || 'PAGE', evt.message);
        break;
    }
  }

  // ============ LÌ XÌ: TAB TẠM CHO TỪNG TÀI KHOẢN ============
  // Mỗi tài khoản phụ chỉ mở tab khi có lì xì: mint token Turnstile -> claim -> đóng tab ngay.
  // Tab là 1 trang trắng do Playwright trả về nhưng nằm đúng origin của site (mở gần như tức thì,
  // Turnstile & CORS vẫn hợp lệ). Không đăng nhập: claim chỉ cần Bearer token do Node cấp, còn nạp
  // refreshToken vào trang thì app web tự refresh sẽ xoay vòng và làm hỏng sessions/*.json.
  async openClaimPage(username, proxy = null) {
    const context = await this.browser.newContext({
      viewport: { width: 420, height: 640 },
      userAgent: USER_AGENT,
      ...(proxy ? { proxy } : {})
    });
    try {
      const page = await context.newPage();
      const blankUrl = this.siteOrigin + LIXI_BLANK_PATH;
      const safeName = String(username).replace(/[<>&"']/g, '');
      await page.route(blankUrl, route => route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html><head><meta charset="utf-8"><title>Nhận lì xì - ${safeName}</title></head><body></body></html>`
      }));
      await page.goto(blankUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      return { context, page };
    } catch (e) {
      try { await context.close(); } catch (err) {}
      throw e;
    }
  }

  // ============ PROXY: MỖI TÀI KHOẢN 1 IP RIÊNG ============
  // Server báo "Hệ thống đang bận" cho các tài khoản claim cùng IP -> tài khoản có proxy được giữ sẵn
  // 1 tab riêng đi qua proxy, lì xì rơi là POST claim ngay từ IP đó.
  startProxyLanes() {
    for (const acc of this.targetAccounts) {
      const sess = getSession(acc.username, this.site.id);
      const proxy = sess && parseProxy(sess.proxy);
      if (!proxy) continue;
      const lane = { username: acc.username, proxy, page: null, context: null, opening: null, ip: null };
      this.proxyLanes.set(acc.username, lane);
      this.maintainProxyLane(lane);
    }
    if (this.proxyLanes.size) {
      this.log('PROXY', `Dùng proxy riêng cho ${this.proxyLanes.size} tài khoản: ${[...this.proxyLanes.keys()].join(', ')}`);
    }
  }

  // Giữ tab proxy luôn mở sẵn (mở lại nếu bị đóng) để lì xì rơi là POST được ngay
  async maintainProxyLane(lane) {
    while (this.isRunning && this.proxyLanes.get(lane.username) === lane) {
      try { await this.ensureProxyLanePage(lane); } catch (e) {}
      await sleep(lane.page ? 15000 : 5000);
    }
  }

  async ensureProxyLanePage(lane) {
    if (lane.page && !lane.page.isClosed()) return lane.page;
    if (!lane.opening) {
      lane.opening = (async () => {
        if (lane.context) { try { await lane.context.close(); } catch (e) {} }
        lane.page = null; lane.context = null;
        const cp = await withTimeout(this.openClaimPage(lane.username, lane.proxy), 30000, null);
        if (!cp) {
          this.log('WARN:PROXY', `[${lane.username}] Không mở được tab qua proxy ${lane.proxy.server.replace(/^\w+:\/\//, '')} - sẽ thử lại.`);
          return null;
        }
        if (!this.isRunning) { try { await cp.context.close(); } catch (e) {} return null; }
        lane.context = cp.context;
        lane.page = cp.page;
        const ip = await withTimeout(cp.page.evaluate(async () => {
          try { return (await (await fetch('https://api.ipify.org?format=json')).json()).ip; } catch (e) { return null; }
        }), 15000, null);
        lane.ip = ip;
        this.log('PROXY', `[${lane.username}] Tab proxy sẵn sàng${ip ? ` - IP: ${ip}` : ' (không kiểm tra được IP)'}`);
        return cp.page;
      })().finally(() => { lane.opening = null; });
    }
    return lane.opening;
  }

  // Token Turnstile lấy từ bể farmer (IP máy); chỉ POST claim đi qua IP của proxy.
  // Trả về 'ok' | 'fail' | 'retry' | 'busy' | 'slow'
  async claimViaProxyLane(lane, username, sessionKey, claimUrl, sess, t0) {
    const page = await withTimeout(this.ensureProxyLanePage(lane), 20000, null);
    if (!this.isRunning) return 'fail';
    if (!page) return 'retry';
    let token = this.farmer ? this.farmer.consumeToken() : null;
    if (!token) {
      this.log('WARN:LIXI', `[${username}] Bể token trống, lấy token mới...`);
      const primaryPage = this.page && !this.page.isClosed() ? this.page : null;
      token = await this.getFreshToken(primaryPage);
    }
    if (!this.isRunning) return 'fail';
    if (!token) {
      this.log('ERROR:LIXI', `[${username}] Không lấy được token Turnstile (+${Date.now() - t0}ms).`);
      return 'retry';
    }
    const outcome = await this.postAndRecord(username, sessionKey, claimUrl, sess, page, token, this.visitorId, { fromPool: true, t0, ipKey: lane.proxy.server });
    // Token bị từ chối vì lý do khác -> thử lại ngay với token mới
    return outcome === 'slow' ? 'busy' : outcome;
  }

  // Giới hạn số tab tạm mở cùng lúc để không dồn CPU/RAM khi có nhiều tài khoản
  async acquireOpenSlot() {
    while (this.openSlotsInUse >= LIXI_OPEN_CONCURRENCY) await sleep(100);
    this.openSlotsInUse++;
  }

  releaseOpenSlot() {
    this.openSlotsInUse = Math.max(0, this.openSlotsInUse - 1);
  }

  // Mint trên trang trắng; nếu Turnstile không chịu ra token thì tải trang thật của site rồi thử lại
  async mintInClaimPage(page) {
    const token = await withTimeout(this.mintTurnstileInPage(page, 15000), 30000, null);
    if (token || !this.isRunning) return token;
    try {
      await page.goto(this.siteOrigin, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (e) {
      return null;
    }
    return withTimeout(this.mintTurnstileInPage(page, 15000), 30000, null);
  }

  // Render 1 widget Turnstile ẩn trong page và chờ token (token gắn với chính context đó)
  async mintTurnstileInPage(page, timeoutMs = 20000) {
    try {
      return await page.evaluate(async ({ sitekey, timeoutMs }) => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const ready = () => window.turnstile && typeof window.turnstile.render === 'function';
        if (!ready()) {
          if (!document.getElementById('__ts_api')) {
            const s = document.createElement('script');
            s.id = '__ts_api';
            s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
            s.async = true;
            document.head.appendChild(s);
          }
          for (let i = 0; i < 50 && !ready(); i++) await wait(200);
        }
        if (!ready()) return null;

        const holder = document.createElement('div');
        holder.style.cssText = 'position:fixed;right:0;bottom:0;z-index:2147483647;';
        document.body.appendChild(holder);

        let token = null;
        let widgetId = null;
        // Hook render trên tab chính sẽ ghi đè callback của modal -> giữ lại callback cũ
        const prevCb = window.__turnstileSuccessCallback;
        try {
          widgetId = window.turnstile.render(holder, { sitekey, callback: (t) => { token = t; } });
        } catch (e) {}
        window.__turnstileSuccessCallback = prevCb;

        const start = Date.now();
        while (!token && Date.now() - start < timeoutMs) {
          await wait(300);
          if (!token && widgetId != null) {
            try { token = window.turnstile.getResponse(widgetId) || null; } catch (e) {}
          }
        }
        try { if (widgetId != null) window.turnstile.remove(widgetId); } catch (e) {}
        holder.remove();
        return token;
      }, { sitekey: this.site.siteKey, timeoutMs });
    } catch (e) {
      return null;
    }
  }

  // visitorId chuẩn FingerprintJS v4 (fallback J5e canvas hash như frontend), cache trên window
  async getVisitorIdInPage(page) {
    try {
      return await page.evaluate(async () => {
        if (window.__cachedVisitorId) return window.__cachedVisitorId;

        try {
          const FingerprintJS = await import('https://openfpcdn.io/fingerprintjs/v4');
          const fp = await FingerprintJS.load();
          const res = await fp.get();
          if (res && res.visitorId && res.visitorId.length >= 16) {
            window.__cachedVisitorId = res.visitorId;
            return res.visitorId;
          }
        } catch (e) {}

        try {
          const t = document.createElement('canvas');
          const e = t.getContext('2d');
          const n = 'RewardClaim_AntiBot_2026_v1';
          e.textBaseline = 'top';
          e.font = "14px 'Arial'";
          e.textBaseline = 'alphabetic';
          e.fillStyle = '#f60';
          e.fillRect(125, 1, 62, 20);
          e.fillStyle = '#069';
          e.fillText(n, 2, 15);
          e.fillStyle = 'rgba(102, 204, 0, 0.7)';
          e.fillText(n, 4, 17);
          const r = t.toDataURL();
          let i = 0;
          for (let a = 0; a < r.length; a++) {
            const o = r.charCodeAt(a);
            i = (i << 5) - i + o;
            i |= 0;
          }
          const cvHash = 'cv_' + Math.abs(i).toString(36);
          window.__cachedVisitorId = cvHash;
          return cvHash;
        } catch (err) {}

        return null;
      });
    } catch (e) {
      return null;
    }
  }

  // deviceHash 32-char hex (chuẩn FingerprintJS x64hash128), độc nhất & ổn định cho từng user
  buildDeviceHash(username, visitorId) {
    if (username === this.primaryAccount && visitorId && /^[0-9a-f]{32}$/i.test(visitorId)) {
      return visitorId;
    }
    const seed = `${visitorId || '78win_live_v1'}:${username}`;
    return crypto.createHash('md5').update(seed).digest('hex');
  }

  async postClaimInPage(page, url, bearer, turnstileToken, deviceHash) {
    const request = page.evaluate(async ({ url, bearer, turnstileToken, deviceHash, referrer }) => {
      try {
        // Dùng __origFetch (nếu có) để tránh fetch wrapper của tab chính log trùng
        const fetchFn = window.__origFetch || window.fetch;
        const r = await fetchFn(url, {
          method: 'POST',
          referrer,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${bearer}`
          },
          body: JSON.stringify({ turnstileToken, deviceHash })
        });
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        return { status: r.status, ok: r.ok, data: json, rawText: text };
      } catch (err) {
        return { status: 0, ok: false, error: err.message };
      }
    }, { url, bearer, turnstileToken, deviceHash, referrer: this.currentUrl })
      .catch(e => ({ status: 0, ok: false, error: e.message }));
    return withTimeout(request, 20000, { status: 0, ok: false, error: 'Hết thời gian chờ phản hồi' });
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

  isLixiClaimed(username, sessionKey) {
    return this.stats.lixiClaimed.some(c => c.username === username && String(c.sessionId) === sessionKey);
  }

  async claimLixiForAllAccounts(sessionId, group) {
    if (!this.config.autoLixi || !sessionId) return;
    const sessionKey = String(sessionId);
    if (this.claimedLixiSessions.has(sessionKey)) return;
    this.claimedLixiSessions.add(sessionKey);

    try {
      const streamId = group || (this.currentUrl && this.currentUrl.split('/').pop());
      const claimUrl = `${this.site.apiBase}/livestreams/${streamId}/reward/${sessionId}/claim`;
      const usernames = this.targetAccounts.map(a => a.username);
      const t0 = Date.now();
      const pool = this.farmer ? this.farmer.getPoolSize() : 0;
      this.log('ACTION:LIXI', `🧧 Bắt đầu nhận Lì Xì song song cho ${usernames.length} tài khoản (Phiên: ${sessionId}, token sẵn: ${pool})...`);

      // Mỗi tài khoản chạy độc lập và tự thử lại ngay khi gặp lỗi tạm thời,
      // không phải chờ tài khoản chậm nhất của lượt đầu như trước
      const out = await Promise.all(usernames.map(u =>
        this.claimLixiForAccount(u, sessionKey, claimUrl, t0).catch((err) => {
          if (this.isRunning) this.log('ERROR:LIXI', `[${u}] Lỗi không mong muốn: ${err.message}`);
          return 'fail';
        })
      ));

      if (this.isRunning) {
        const okCount = out.filter(r => r === 'ok').length;
        this.log('LIXI:SUMMARY', `Hoàn tất phiên ${sessionId}: ${okCount}/${usernames.length} tài khoản nhận thành công (${Date.now() - t0}ms).`);
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

  // Lấy token Turnstile mới nhanh nhất có thể: đua giữa farmer và mint ngay trên tab chính
  // (tab chính đã tải sẵn Turnstile nên nhanh hơn nhiều so với mở tab tạm). Token về sau được trả lại bể.
  async getFreshToken(page, timeoutMs = 20000) {
    const sources = [];
    if (this.farmer) sources.push(this.farmer.waitForToken(timeoutMs));
    if (page) sources.push(withTimeout(this.mintTurnstileInPage(page, timeoutMs), timeoutMs + 10000, null));
    if (!sources.length) return null;
    return new Promise((resolve) => {
      let won = false;
      let left = sources.length;
      for (const src of sources) {
        Promise.resolve(src).catch(() => null).then((tok) => {
          if (tok && !won) {
            won = true;
            resolve(tok);
          } else if (tok && this.farmer && this.isRunning) {
            this.farmer.returnToken(tok);
          }
          if (--left === 0 && !won) resolve(null);
        });
      }
    });
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

    const primaryPage = this.page && !this.page.isClosed() ? this.page : null;
    // visitorId đã được làm nóng lúc khởi động; chỉ chờ rất ngắn nếu chưa có
    if (!this.visitorId && primaryPage) {
      const v = await withTimeout(this.getVisitorIdInPage(primaryPage), 1500, null);
      if (v) this.visitorId = v;
    }
    const visitorId = this.visitorId;

    // Tài khoản có proxy: claim từ tab riêng qua IP của proxy
    const lane = this.proxyLanes.get(username);
    if (lane) return this.claimViaProxyLane(lane, username, sessionKey, claimUrl, sess, t0);

    // Đường nhanh: token Turnstile có sẵn trong bể -> POST ngay từ tab chính
    const pooledToken = primaryPage && this.farmer ? this.farmer.consumeToken() : null;
    if (pooledToken) {
      const outcome = await this.postAndRecord(username, sessionKey, claimUrl, sess, primaryPage, pooledToken, visitorId, { fromPool: true, t0 });
      // 'busy' trả về ngay để vòng ngoài thử lại nhanh với token kế tiếp trong bể
      if (outcome !== 'slow') return outcome;
      if (!this.isRunning) return 'fail';
      this.log('WARN:LIXI', `[${username}] Token có sẵn bị từ chối, lấy token mới...`);
    } else if (this.isRunning) {
      this.log('WARN:LIXI', `[${username}] Bể token trống, lấy token mới ngay trên tab chính...`);
    }

    if (primaryPage) {
      const fresh = await this.getFreshToken(primaryPage);
      if (!this.isRunning) return 'fail';
      if (fresh) {
        return this.postAndRecord(username, sessionKey, claimUrl, sess, primaryPage, fresh, visitorId, { fromPool: false, t0 });
      }
      this.log('WARN:LIXI', `[${username}] Không lấy được token trên tab chính (+${Date.now() - t0}ms), thử tab tạm...`);
    }

    // Tài khoản chính chỉ dùng tab chính (đã thử ở trên) -> để vòng thử lại xử lý
    if (username === this.primaryAccount) return 'retry';

    // Tài khoản phụ: mở tab tạm -> claim -> luôn đóng tab (kể cả khi lỗi)
    await this.acquireOpenSlot();
    let claimPage = null;
    try {
      if (!this.isRunning || !this.browser || !this.siteOrigin) return 'fail';
      const opening = this.openClaimPage(username);
      claimPage = await withTimeout(opening, 20000, null);
      if (!claimPage) {
        // Mở quá lâu -> vẫn phải đóng context nếu nó mở xong muộn, tránh rò tab
        opening.then(cp => cp && cp.context.close()).catch(() => {});
        if (!this.isRunning) return 'fail';
        this.log('WARN:LIXI', `[${username}] Không mở được tab tạm, dùng tab chính làm dự phòng.`);
        if (!primaryPage) return 'retry';
        return await this.claimWithPage(username, sessionKey, claimUrl, sess, primaryPage, { isOwn: false, isTemp: false, t0 });
      }
      return await this.claimWithPage(username, sessionKey, claimUrl, sess, claimPage.page, { isOwn: true, isTemp: true, t0 });
    } finally {
      if (claimPage) {
        try { await claimPage.context.close(); } catch (e) {}
      }
      this.releaseOpenSlot();
    }
  }

  async claimWithPage(username, sessionKey, claimUrl, sess, page, { isOwn, isTemp, t0 = Date.now() }) {
    // Token Turnstile mint ngay trong tab của tài khoản (song song với lấy visitorId); dự phòng bể farmer
    const mint = !isOwn ? null
      : isTemp ? this.mintInClaimPage(page)
        : withTimeout(this.mintTurnstileInPage(page), 35000, null);
    // Ưu tiên visitorId của tab chính để deviceHash của 1 tài khoản luôn giống nhau giữa các nhánh
    let [turnstileToken, visitorId] = await Promise.all([
      mint,
      this.visitorId || withTimeout(this.getVisitorIdInPage(page), 10000, null)
    ]);
    // Nếu mint phải tải lại trang thật thì lần lấy visitorId song song có thể bị huỷ -> lấy lại để deviceHash ổn định
    if (!visitorId && this.isRunning) {
      visitorId = await withTimeout(this.getVisitorIdInPage(page), 10000, null);
    }
    if (!turnstileToken && this.farmer && this.isRunning) {
      turnstileToken = await this.farmer.waitForToken(15000);
    }
    if (!this.isRunning) return 'fail';
    if (!turnstileToken) {
      this.log('ERROR:LIXI', `[${username}] Không lấy được token Turnstile.`);
      return 'retry';
    }

    return this.postAndRecord(username, sessionKey, claimUrl, sess, page, turnstileToken, visitorId, { fromPool: false, t0 });
  }

  // QQ88: sau khi claim được nhận, gọi GET /livestreams/check-status mỗi 3s (tối đa 15 lần, như frontend)
  // để biết phần thưởng là điểm hay mã Code.
  async pollRewardStatus(entry, page, claimUrl, sess) {
    const m = String(claimUrl).match(/\/livestreams\/([^/]+)\/reward\/([^/]+)\/claim/);
    if (!m) return;
    const [, group, sessionId] = m;
    const userId = sess.userId || '';
    const url = `${this.site.apiBase}/livestreams/check-status?groupId=${encodeURIComponent(decodeURIComponent(group))}&sessionId=${encodeURIComponent(decodeURIComponent(sessionId))}&userId=${encodeURIComponent(userId)}`;
    for (let i = 0; i < 15 && this.isRunning; i++) {
      await sleep(3000);
      if (!page || page.isClosed()) break;
      const r = await withTimeout(page.evaluate(async ({ url, bearer }) => {
        try {
          const fetchFn = window.__origFetch || window.fetch;
          const res = await fetchFn(url, { headers: { Authorization: `Bearer ${bearer}` } });
          return await res.json();
        } catch (e) { return null; }
      }, { url, bearer: sess.token }).catch(() => null), 10000, null);
      const d = r && r.data;
      if (r && r.error === 0 && d && d.status === 'success') {
        entry.status = 'success';
        if (d.type === 'Code') {
          entry.code = d.code || null;
          entry.rewardPoint = Number(d.value) || 0;
          this.log('SUCCESS:LIXI', `🎟️ [${entry.username}] NHẬN MÃ CODE: ${d.code}${d.value ? ` (trị giá ${d.value})` : ''}`);
        } else {
          entry.rewardPoint = Number(d.value) || 0;
          this.stats.totalRewardPoints += entry.rewardPoint;
          this.log('SUCCESS:LIXI', `🎁 [${entry.username}] Được cộng ${entry.rewardPoint} điểm!`);
        }
        this.emit('status', this.getStatus());
        return;
      }
      if ((d && d.status === 'failed') || (r && r.error !== undefined && r.error !== 0)) {
        entry.status = 'failed';
        this.log('ERROR:LIXI', `[${entry.username}] Hệ thống báo nhận thưởng thất bại: ${(d && d.message) || (r && r.message) || 'không rõ lý do'}`);
        this.emit('status', this.getStatus());
        return;
      }
    }
    if (entry.status === 'pending' && this.isRunning) {
      this.log('WARN:LIXI', `[${entry.username}] Hệ thống chưa trả kết quả, kiểm tra hòm thư tài khoản game trong vài phút tới.`);
    }
  }

  // Trả về 'ok' | 'fail' | 'retry' | 'slow' (token từ bể bị từ chối vì lý do khác hết lì xì -> thử token mới)
  async postAndRecord(username, sessionKey, claimUrl, sess, page, turnstileToken, visitorId, { fromPool, t0 = Date.now(), ipKey = 'local' }) {
    const deviceHash = this.buildDeviceHash(username, visitorId);

    const result = await this.withIpLock(ipKey, async () => {
      if (this.isLixiClaimed(username, sessionKey) || !this.isRunning) return null;
      return this.postClaimInPage(page, claimUrl, sess.token, turnstileToken, deviceHash);
    });
    if (this.isLixiClaimed(username, sessionKey)) return 'ok';
    if (!this.isRunning || !result) return 'fail';
    const resData = result ? result.data : null;

    if (resData && (resData.error === 0 || resData.isSuccess)) {
      if (this.isLixiClaimed(username, sessionKey)) return 'ok';
      if (this.site.claimStatusCheck) {
        // QQ88: claim chỉ được xếp hàng -> ghi nhận ngay (chặn claim trùng) rồi hỏi trạng thái để lấy điểm / mã Code
        const entry = { username, rewardPoint: 0, code: null, status: 'pending', sessionId: sessionKey, at: new Date().toISOString() };
        this.stats.lixiClaimed.push(entry);
        this.log('SUCCESS:LIXI', `🎁 [${username}] Đã giành được lì xì! Đang chờ hệ thống trả phần thưởng... (+${Date.now() - t0}ms)`);
        this.emit('status', this.getStatus());
        this.pollRewardStatus(entry, page, claimUrl, sess);
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
      this.log('SUCCESS:LIXI', `🎁 [${username}] NHẬN LÌ XÌ THÀNH CÔNG! Được +${rewardPoint} điểm! (+${Date.now() - t0}ms)`);
      this.emit('status', this.getStatus());
      return 'ok';
    }
    if (!this.isRunning) return 'fail';

    const status = result ? result.status : 0;
    const msg = (resData && (resData.message || resData.errorMessage)) || (result && result.rawText) || (result && result.error) || 'Thất bại';
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
    if (status === 0 || status === 429 || status >= 500 || !resData) return 'retry';
    // "Phần thưởng đã được phát hết" -> hết lì xì cho mọi người, thử lại vô ích
    if (fromPool && !/phát hết|hết lượt|đã nhận/i.test(String(msg))) return 'slow';
    return 'fail';
  }

  async injectTrackingEngine() {
    await this.page.evaluate((cfg) => {
      if (window.__TRACKER_INJECTED__) return;
      window.__TRACKER_INJECTED__ = true;

      const origFetch = window.fetch;
      window.__origFetch = origFetch;

      // 1. FETCH wrapper
      window.fetch = async function (...args) {
        const url = typeof args[0] === 'string' ? args[0] : ((args[0] && args[0].url) || '');
        const response = await origFetch.apply(this, args);
        try {
          if (url.includes('/attendance') || (url.includes('/reward') && url.includes('/claim')) || url.includes('/livestreams/detail/')) {
            response.clone().json().then(data => {
              if (url.includes('/attendance')) {
                if (response.status === 200 && data && data.error === 0) {
                  window.__attendanceSuccessAt = Date.now();
                }
                window.__emitTrackerEvent({ type: 'ATTENDANCE_HTTP', data: { url, status: response.status, body: data } });
              } else if (url.includes('/claim')) {
                window.__emitTrackerEvent({ type: 'LIXI_CLAIM_HTTP', data: { url, status: response.status, body: data } });
              } else if (data && data.data) {
                window.__emitTrackerEvent({ type: 'STREAM_DETAIL', data: data.data });
              }
            }).catch(() => {});
          }
        } catch (e) {}
        return response;
      };

      // 2. XMLHttpRequest wrapper (axios dùng XHR - đây là kênh chính của app)
      const XHR = XMLHttpRequest.prototype;
      const origOpen = XHR.open;
      const origSend = XHR.send;
      XHR.open = function (method, url) {
        this.__trackerUrl = String(url || '');
        this.__trackerMethod = method;
        return origOpen.apply(this, arguments);
      };
      XHR.send = function (body) {
        this.addEventListener('load', function () {
          try {
            const url = this.__trackerUrl || '';
            if (!url) return;
            if (url.includes('/attendance') || (url.includes('/reward') && url.includes('/claim'))) {
              let parsed = null;
              let reqOffset = null;
              try { parsed = JSON.parse(this.responseText); } catch (e) {}
              try { reqOffset = JSON.parse(body).offsetMinutes; } catch (e) {}
              if (url.includes('/attendance') && this.status === 200 && parsed && parsed.error === 0) {
                window.__attendanceSuccessAt = Date.now();
              }
              window.__emitTrackerEvent({
                type: url.includes('/attendance') ? 'ATTENDANCE_HTTP' : 'LIXI_CLAIM_HTTP',
                data: { url, status: this.status, body: parsed, offsetMinutes: reqOffset }
              });
            }
          } catch (e) {}
        });
        return origSend.apply(this, arguments);
      };
      // 3. WebSocket (SignalR) - bắt sự kiện RecvRewardAnnounce
      const OrigWebSocket = window.WebSocket;
      window.WebSocket = function (...wsArgs) {
        const ws = new OrigWebSocket(...wsArgs);
        ws.addEventListener('message', function (event) {
          if (typeof event.data === 'string') {
            const packets = event.data.split('\x1e').filter(Boolean);
            for (const pkt of packets) {
              try {
                const parsed = JSON.parse(pkt);
                if (parsed.type === 1 && parsed.target === 'RecvRewardAnnounce') {
                  const rewardData = parsed.arguments && parsed.arguments[0];
                  window.__lastRewardSession = rewardData;
                  window.__emitTrackerEvent({ type: 'LIXI_ANNOUNCED', data: rewardData });
                }
              } catch (e) {}
            }
          }
        });
        return ws;
      };
      window.WebSocket.prototype = OrigWebSocket.prototype;

      // Wrap window.turnstile để bắt token khi widget tự giải thành công
      if (window.turnstile && typeof window.turnstile.render === 'function') {
        const origRender = window.turnstile.render;
        window.turnstile.render = function (container, opt) {
          if (opt && opt.callback) {
            const origCb = opt.callback;
            opt.callback = function (token) {
              window.__emitTrackerEvent({ type: 'TURNSTILE_TOKEN', data: { token } });
              return origCb.apply(this, arguments);
            };
          }
          return origRender.apply(this, arguments);
        };
      }

      // 4. Lấy stream detail 1 lần để Node tính mốc điểm danh
      const token = localStorage.getItem('token');
      const streamId = window.location.pathname.split('/').pop();
      if (streamId) {
        origFetch(`${cfg.apiBase}/livestreams/detail/${streamId}`, {
          headers: { Authorization: token ? `Bearer ${token}` : '' }
        }).then(r => r.json()).then(res => {
          if (res && res.data && res.data.startedAt) {
            // Callback chạy sau khi script kết thúc nên có thể gán biến dưới đây
            streamStartedAt = new Date(res.data.startedAt);
            if (res.data.attendanceConfig && res.data.attendanceConfig.offsetsMinutes) {
              offsetsMinutes = res.data.attendanceConfig.offsetsMinutes.slice().sort((a, b) => a - b);
            }
            window.__emitTrackerEvent({ type: 'STREAM_DETAIL', data: res.data });
          }
        }).catch(() => {});
      }

      // 5. Fast polling DOM (300ms)
      let streamStartedAt = null;
      let offsetsMinutes = [11, 19, 26, 33, 40, 46, 53, 60, 66, 73, 81, 88, 94, 100, 106, 113, 120];

      // Đăng ký nhận STREAM_DETAIL từ chính fetch wrapper ở trên
      // Helper trích xuất sessionId từ React Fiber của nút lì xì hoặc modal
      // Luôn đọc DOM trước: trả cache trước sẽ trả về phiên lì xì CŨ (đã claim) ở đợt sau -> bị bỏ qua
      window.findRewardSessionFromDOM = function () {
        try {
          const elements = Array.from(document.querySelectorAll('button, div')).filter(b =>
            (b.className && typeof b.className === 'string' && (b.className.includes('animate-lixi-fall') || b.className.includes('ant-modal'))) ||
            (b.innerText && b.innerText.includes('MỞ LÌ XÌ NGAY'))
          );
          for (const el of elements) {
            const k = Object.keys(el).find(key => key.startsWith('__reactFiber'));
            if (k) {
              let f = el[k];
              let d = 0;
              while (f && d < 25) {
                if (f.memoizedProps) {
                  for (const [pk, pv] of Object.entries(f.memoizedProps)) {
                    if (pv && typeof pv === 'object') {
                      if (pv.sessionId) {
                        window.__lastRewardSession = { sessionId: pv.sessionId, group: pv.group || window.location.pathname.split('/').pop() };
                        return window.__lastRewardSession;
                      }
                    }
                  }
                }
                if (f.memoizedState) {
                  let hook = f.memoizedState;
                  while (hook) {
                    const s = hook.memoizedState;
                    if (Array.isArray(s)) {
                      const found = s.slice().reverse().find(item => item && item.sessionId);
                      if (found) {
                        window.__lastRewardSession = { sessionId: found.sessionId, group: found.group || window.location.pathname.split('/').pop() };
                        return window.__lastRewardSession;
                      }
                    } else if (s && typeof s === 'object' && s.sessionId) {
                      window.__lastRewardSession = { sessionId: s.sessionId, group: s.group || window.location.pathname.split('/').pop() };
                      return window.__lastRewardSession;
                    }
                    hook = hook.next;
                  }
                }
                f = f.return;
                d++;
              }
            }
          }
        } catch (e) {}
        return window.__lastRewardSession || null;
      };

      window.__emitTrackerEvent({ type: 'LOG', level: 'ENGINE', message: 'Tracking engine đã kích hoạt (HTTP + XHR + WebSocket + DOM).' });
      let lastAttendanceClick = 0;
      let lastLixiClick = 0;

      setInterval(() => {
        // Countdown cho UI
        if (streamStartedAt) {
          const now = new Date();
          const diffMin = (now - streamStartedAt) / 60000;
          const nextOffset = offsetsMinutes.find(o => o > diffMin);
          if (nextOffset) {
            const remSec = Math.max(0, Math.floor((nextOffset - diffMin) * 60));
            const mm = String(Math.floor(remSec / 60)).padStart(2, '0');
            const ss = String(remSec % 60).padStart(2, '0');
            window.__emitTrackerEvent({
              type: 'ATTENDANCE_COUNTDOWN',
              data: { nextOffset, countdown: `${mm}:${ss}` }
            });
          }
        }

        // A. Auto-click Điểm danh (cooldown 5s; ngừng 60s sau 1 lần thành công)
        if (cfg.autoAttendance) {
          if (Date.now() - (window.__attendanceSuccessAt || 0) > 60000) {
            const diemDanhBtn = Array.from(document.querySelectorAll('button')).find(b =>
              b.innerText && b.innerText.includes('Điểm danh')
            );
            if (diemDanhBtn && !diemDanhBtn.disabled) {
              const now = Date.now();
              if (now - lastAttendanceClick > 5000) {
                lastAttendanceClick = now;
                window.__emitTrackerEvent({
                  type: 'ATTENDANCE_BUTTON_VISIBLE',
                  data: { text: diemDanhBtn.innerText.trim() }
                });
                diemDanhBtn.click();
              }
            }
          }
        }

        // B. Auto bắt lì xì rơi (cooldown 5s, không click khi modal đang mở)
        if (cfg.autoLixi) {
          const openBtn = Array.from(document.querySelectorAll('button')).find(b =>
            b.innerText && b.innerText.includes('MỞ LÌ XÌ NGAY')
          );

          if (openBtn) {
            const sess = (typeof window.findRewardSessionFromDOM === 'function' ? window.findRewardSessionFromDOM() : null) || window.__lastRewardSession || {};
            if (!openBtn.hasAttribute('data-modal-logged')) {
              openBtn.setAttribute('data-modal-logged', 'true');
              window.__emitTrackerEvent({ type: 'LIXI_MODAL_READY', data: sess });
            }

            // KHÔNG tự bấm "MỞ LÌ XÌ NGAY": tool đã claim thẳng qua API cho mọi tài khoản.
            // Nút trên trang gửi thêm 1 POST claim từ IP máy mỗi 3s, chồng lên các claim khác
            // cùng IP -> server trả "Hệ thống đang bận xử lý" (-5).
          } else {
            const lixiBtns = Array.from(document.querySelectorAll('button')).filter(b => {
              const img = b.querySelector('img');
              return (img && img.alt === 'Bao lì xì') ||
                (b.className && b.className.includes('animate-lixi-fall') && !b.className.includes('pointer-events-none'));
            });
            if (lixiBtns.length > 0) {
              const now = Date.now();
              if (now - lastLixiClick > 4000) {
                lastLixiClick = now;
                const sess = (typeof window.findRewardSessionFromDOM === 'function' ? window.findRewardSessionFromDOM() : null) || window.__lastRewardSession || {};
                window.__emitTrackerEvent({ type: 'LIXI_CLICKED', data: sess });
                lixiBtns[0].click();
              }
            }
          }
        }
      }, 300);

      // Fetch lại detail mỗi 15s để bắt kịp startedAt mới khi stream bị restart (lag)
      setInterval(() => {
        const t = localStorage.getItem('token');
        origFetch(`${cfg.apiBase}/livestreams/detail/${window.location.pathname.split('/').pop()}`, {
          headers: { Authorization: t ? `Bearer ${t}` : '' }
        }).then(r => r.json()).then(res => {
          if (res && res.data && res.data.startedAt) {
            streamStartedAt = new Date(res.data.startedAt);
            if (res.data.attendanceConfig && res.data.attendanceConfig.offsetsMinutes) {
              offsetsMinutes = res.data.attendanceConfig.offsetsMinutes.slice().sort((a, b) => a - b);
            }
            window.__emitTrackerEvent({ type: 'STREAM_DETAIL', data: res.data });
          }
        }).catch(() => {});
      }, 15000);
    }, { ...this.config, apiBase: this.site.apiBase });
  }

  async stopTracking() {
    this.isRunning = false;
    clearInterval(this.attendanceTimer);
    this.attendanceTimer = null;
    clearInterval(this.sessionKeepaliveTimer);
    this.sessionKeepaliveTimer = null;
    this.log('STOP', 'Dừng theo dõi livestream.');
    if (this.farmer) {
      await this.farmer.stop();
      this.farmer = null;
    }
    if (this.browser) {
      // browser.close() đóng luôn các tab tạm nhận lì xì còn đang mở
      try { await this.browser.close(); } catch (e) {}
      this.browser = null;
      this.context = null;
      this.page = null;
    }
    this.openSlotsInUse = 0;
    this.proxyLanes = new Map();
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
      farmerPoolSize: this.farmer ? this.farmer.getPoolSize() : 0
    };
  }
}

// Singleton tracker instance
const trackerInstance = new LiveTracker();

module.exports = trackerInstance;

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const fs = require('fs');
const path = require('path');
const { getSession, listAccounts } = require('./auth');
const crypto = require('crypto');
const { findChrome, TurnstileFarmer } = require('./turnstile');

const API_BASE = 'https://live-78win-apiclient.attcloud.org/api';

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

    if (username === 'all' || username === 'FULL') {
      const allAccounts = await listAccounts();
      if (!allAccounts || !allAccounts.length) {
        throw new Error('Chưa có tài khoản nào được lưu. Vui lòng đăng nhập ít nhất 1 tài khoản.');
      }
      targetAccounts = allAccounts;
      primarySession = getSession(allAccounts[0].username);
      this.targetAccounts = targetAccounts;
      this.primaryAccount = allAccounts[0].username;
    } else {
      primarySession = getSession(username);
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
    const accountDesc = (username === 'all' || username === 'FULL')
      ? `TẤT CẢ TÀI KHOẢN (${this.targetAccounts.map(a => a.username).join(', ')})`
      : username;
    this.log('INIT', `Khởi động theo dõi livestream: ${liveUrl} cho: ${accountDesc}...`);

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
    fetch(`${API_BASE}/livestreams/detail/${streamId}`)
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
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    });

    this.page = await this.context.newPage();
    // Lắng nghe trực tiếp các gói tin WebSocket (MessagePack) của SignalR qua Playwright CDP
    this.page.on('websocket', (ws) => {
      ws.on('framereceived', ({ payload }) => {
        try {
          if (!payload) return;
          const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
          const str = buf.toString('latin1');
          if (str.includes('RecvRewardAnnounce')) {
            const uuidMatch = str.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
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
      this.farmer = new TurnstileFarmer({
        url: liveUrl,
        onStatus: (msg) => this.log('FARMER', msg)
      });
      this.farmer.start().then(() => {
        if (this.config.autoLixi && this.farmer) {
          this.farmer.setDemand(true, Math.max(3, this.targetAccounts.length));
        }
      }).catch((e) => {
        this.log('FARMER', `Chế độ nạp token ngầm: ${e.message}`);
      });

      this.log('READY', `Đang theo dõi trực tiếp. Chờ sự kiện Điểm danh & Lì xì...`);
      this.emit('status', this.getStatus());
    } catch (err) {
      this.log('ERROR', `Lỗi khi kết nối livestream: ${err.message}`);
      await this.stopTracking();
      throw err;
    }
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
        const offsets = (info.attendanceConfig && info.attendanceConfig.offsetsMinutes) || [11, 19, 26, 33, 40, 46, 53, 60, 66, 73, 81, 88, 94, 100, 106, 113, 120];
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

          const sess = getSession(acc.username);
          if (!sess || !sess.token) continue;

          this.attendanceDone.add(key);
          const attempts = (this.attendanceAttempts.get(key) || 0) + 1;
          this.attendanceAttempts.set(key, attempts);

          fetch(`${API_BASE}/livestreams/${streamId}/attendance`, {
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
            this.attendanceDone.delete(key);
            this.log('ERROR:ATTENDANCE', `[${acc.username}] Lỗi kết nối: ${err.message}`);
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
          } else if (!String((body && body.message) || '').includes('Ngoài khung giờ')) {
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
        if (evt.data && evt.data.token && this.farmer) {
          this.farmer.pool.push({ token: evt.data.token, createdAt: Date.now() });
        }
        break;
      case 'LIXI_CLAIM_HTTP':
        {
          const body = evt.data.body;
          const status = evt.data.status;
          if (status === 200 && body && body.error === 0) {
            const rewardPoint = (body.data && body.data.rewardPoint) || 0;
            this.stats.lixiClaimed.push({ rewardPoint, at: new Date().toISOString() });
            this.stats.totalRewardPoints += rewardPoint;
            this.log('SUCCESS:LIXI', `🎁 NHẬN LÌ XÌ THÀNH CÔNG! Được +${rewardPoint} điểm!`);
          } else {
            this.log('ERROR:LIXI', `Nhận lì xì thất bại: ${(body && body.message) || ('HTTP ' + status)}`);
          }
          this.emit('status', this.getStatus());
        }
        break;

      case 'LOG':
        this.log(evt.level || 'PAGE', evt.message);
        break;
    }
  }

  async claimLixiForAllAccounts(sessionId, group) {
    if (!this.config.autoLixi || !sessionId) return;
    const sessionKey = String(sessionId);
    if (this.claimedLixiSessions.has(sessionKey)) return;
    this.claimedLixiSessions.add(sessionKey);

    const streamId = group || (this.currentUrl && this.currentUrl.split('/').pop());
    this.log('ACTION:LIXI', `🧧 Bắt đầu nhận Lì Xì cho ${this.targetAccounts.length} tài khoản (Phiên: ${sessionId})...`);

    if (this.farmer) {
      this.farmer.setDemand(true, Math.max(3, this.targetAccounts.length));
    }

    // 1. Kích hoạt nhận Lì Xì cho tài khoản chính (Primary) ngay trên giao diện tab trình duyệt
    if (this.page) {
      this.farmer?.waitForToken(5000).then(pageToken => {
        if (pageToken && this.page) {
          this.page.evaluate((tok) => {
            try {
              if (typeof window.__turnstileSuccessCallback === 'function') {
                window.__turnstileSuccessCallback(tok);
              }
              const input = document.querySelector('[name="cf-turnstile-response"]');
              if (input) input.value = tok;
              setTimeout(() => {
                const openBtn = Array.from(document.querySelectorAll('button')).find(b =>
                  b.innerText && b.innerText.includes('MỞ LÌ XÌ NGAY')
                );
                if (openBtn) {
                  openBtn.disabled = false;
                  openBtn.click();
                }
              }, 200);
            } catch (e) {}
          }, pageToken).catch(() => {});
        }
      }).catch(() => {});
    }

    // 2. Lấy visitorId chuẩn từ trang trình duyệt
    let browserVisitorId = null;
    if (this.page) {
      try {
        browserVisitorId = await this.page.evaluate(() => {
          try {
            const t = document.createElement('canvas');
            const e = t.getContext('2d');
            const n = 'https://live-78win.pages.dev';
            t.width = 200; t.height = 30;
            e.textBaseline = 'top'; e.font = '14px Arial'; e.textBaseline = 'alphabetic';
            e.fillStyle = '#f60'; e.fillRect(125, 1, 62, 20); e.fillStyle = '#069'; e.fillText(n, 2, 15);
            e.fillStyle = 'rgba(102, 204, 0, 0.7)'; e.fillText(n, 4, 17);
            const r = t.toDataURL();
            let i = 0;
            for (let a = 0; a < r.length; a++) { const o = r.charCodeAt(a); i = (i << 5) - i + o; i |= 0; }
            return 'cv_' + Math.abs(i).toString(36);
          } catch (err) {
            return null;
          }
        });
      } catch (e) {}
    }

    // 3. Xử lý nhận Lì Xì cho các tài khoản còn lại thông qua chính ngữ cảnh trình duyệt Chrome
    const otherAccounts = this.targetAccounts.filter(acc => acc.username !== this.primaryAccount);
    (async () => {
      for (const acc of otherAccounts) {
        const sess = getSession(acc.username);
        if (!sess || !sess.token) {
          this.log('WARN:LIXI', `[${acc.username}] Bỏ qua vì chưa có phiên đăng nhập.`);
          continue;
        }

        // Kiểm tra hạn sử dụng của JWT token
        try {
          const parts = sess.token.split('.');
          if (parts.length === 3) {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
            if (payload && payload.exp && Date.now() / 1000 > payload.exp) {
              this.log('ERROR:LIXI', `[${acc.username}] Token đăng nhập đã hết hạn! Vui lòng đăng nhập lại tài khoản này.`);
              continue;
            }
          }
        } catch (e) {}

        const deviceHash = browserVisitorId || crypto.createHash('md5').update(`78win-${acc.username}`).digest('hex');

        // Lấy token Turnstile từ bể Token Farmer
        let turnstileToken = null;
        if (this.farmer) {
          turnstileToken = await this.farmer.waitForToken(15000);
        }

        if (!turnstileToken) {
          this.log('ERROR:LIXI', `[${acc.username}] Không lấy được token Turnstile từ bể.`);
          continue;
        }

        // Gửi claim trực tiếp qua ngữ cảnh trình duyệt Chrome (đầy đủ Origin, Referer, TLS fingerprint, Cookie)
        try {
          let claimResult = null;
          if (this.page) {
            claimResult = await this.page.evaluate(async ({ url, token, turnstileToken, deviceHash }) => {
              try {
                const r = await window.fetch(url, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
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
            }, {
              url: `${API_BASE}/livestreams/${streamId}/reward/${sessionId}/claim`,
              token: sess.token,
              turnstileToken,
              deviceHash
            });
          } else {
            // Fallback Node.js fetch kèm đầy đủ headers giả lập browser
            const res = await fetch(`${API_BASE}/livestreams/${streamId}/reward/${sessionId}/claim`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${sess.token}`,
                'Origin': 'https://78win-live.pages.dev',
                'Referer': `https://78win-live.pages.dev/live/${streamId}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
              },
              body: JSON.stringify({ turnstileToken, deviceHash })
            });
            const text = await res.text();
            let json = null;
            try { json = JSON.parse(text); } catch (e) {}
            claimResult = { status: res.status, ok: res.ok, data: json, rawText: text };
          }

          const resData = claimResult ? claimResult.data : null;
          if (resData && resData.error === 0) {
            const rewardPoint = (resData.data && resData.data.rewardPoint) || 0;
            this.stats.lixiClaimed.push({
              username: acc.username,
              rewardPoint,
              sessionId,
              at: new Date().toISOString()
            });
            this.stats.totalRewardPoints += rewardPoint;
            this.log('SUCCESS:LIXI', `🎁 [${acc.username}] NHẬN LÌ XÌ THÀNH CÔNG! Được +${rewardPoint} điểm!`);
          } else {
            const msg = (resData && (resData.message || resData.errorMessage)) || (claimResult && claimResult.rawText) || (claimResult && claimResult.error) || 'Thất bại';
            const code = resData && resData.error !== undefined ? ` (Mã: ${resData.error})` : (claimResult && claimResult.status ? ` (HTTP ${claimResult.status})` : '');
            this.log('ERROR:LIXI', `[${acc.username}] Nhận lì xì: ${msg}${code}`);
          }
          this.emit('status', this.getStatus());
        } catch (err) {
          this.log('ERROR:LIXI', `[${acc.username}] Lỗi kết nối: ${err.message}`);
        }

        // Pacing delay 400ms giữa các tài khoản để tránh bị ThrottlerException (HTTP 429)
        await new Promise(r => setTimeout(r, 400));
      }

      this.log('LIXI:SUMMARY', `Hoàn tất xử lý Lì Xì phiên ${sessionId}.`);
      this.emit('status', this.getStatus());
    })().catch(() => {});
  }

  async injectTrackingEngine() {
    await this.page.evaluate((cfg) => {
      if (window.__TRACKER_INJECTED__) return;
      window.__TRACKER_INJECTED__ = true;

      const origFetch = window.fetch;

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
        origFetch(`${'https://live-78win-apiclient.attcloud.org/api'}/livestreams/detail/${streamId}`, {
          headers: { Authorization: token ? `Bearer ${token}` : '' }
        }).then(r => r.json()).then(res => {
          if (res && res.data && res.data.startedAt) {
            // Callback chạy sau khi script kết thúc nên có thể gán biến dưới đây
            streamStartedAt = new Date(res.data.startedAt);
            if (res.data.attendanceConfig && res.data.attendanceConfig.offsetsMinutes) {
              offsetsMinutes = res.data.attendanceConfig.offsetsMinutes;
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
      window.findRewardSessionFromDOM = function () {
        if (window.__lastRewardSession && window.__lastRewardSession.sessionId) {
          return window.__lastRewardSession;
        }
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
                      const found = s.find(item => item && item.sessionId);
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
      let lastClaimClick = 0;

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

            // Nếu có token từ callback, tự động click nút
            if (!openBtn.disabled) {
              const now = Date.now();
              if (now - lastClaimClick > 3000) {
                lastClaimClick = now;
                openBtn.click();
              }
            }
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
        origFetch(`${'https://live-78win-apiclient.attcloud.org/api'}/livestreams/detail/${window.location.pathname.split('/').pop()}`, {
          headers: { Authorization: t ? `Bearer ${t}` : '' }
        }).then(r => r.json()).then(res => {
          if (res && res.data && res.data.startedAt) {
            streamStartedAt = new Date(res.data.startedAt);
            if (res.data.attendanceConfig && res.data.attendanceConfig.offsetsMinutes) {
              offsetsMinutes = res.data.attendanceConfig.offsetsMinutes;
            }
            window.__emitTrackerEvent({ type: 'STREAM_DETAIL', data: res.data });
          }
        }).catch(() => {});
      }, 15000);
    }, this.config);
  }

  async stopTracking() {
    this.isRunning = false;
    clearInterval(this.attendanceTimer);
    this.attendanceTimer = null;
    this.log('STOP', 'Dừng theo dõi livestream.');
    if (this.farmer) {
      await this.farmer.stop();
      this.farmer = null;
    }
    if (this.browser) {
      try { await this.browser.close(); } catch (e) {}
      this.browser = null;
      this.context = null;
      this.page = null;
    }
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

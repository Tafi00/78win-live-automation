/**
 * Cloudflare Turnstile Token Farmer cho 78win-live.
 * Tham khảo kiến trúc từ code-tele-v4 (chrome_tokens.py / submitter.py):
 * - Dùng Google Chrome thật với CDP (Chrome DevTools Protocol) để qua mặt anti-bot.
 * - Mở tab ngầm đến 78win-live.pages.dev, render Turnstile widget và lấy token.
 * - Duy trì bể token (token pool) dùng chung cho tất cả tài khoản.
 */

const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');

function findChrome() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ];

  if (process.platform === 'win32') {
    const bases = [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA
    ];
    for (const b of bases) {
      if (b) candidates.push(path.join(b, 'Google/Chrome/Application/chrome.exe'));
    }
  } else if (process.platform === 'linux') {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser'
    );
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function httpGetJson(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

class TurnstileFarmer {
  constructor(options = {}) {
    this.url = options.url || 'https://78win-live.pages.dev';
    this.siteKey = options.siteKey || '0x4AAAAAAEm2LdKEVhgZvq9H';
    this.maxTabs = options.maxTabs || 2;
    this.tokenTtl = options.tokenTtl || 90000; // 90 giây
    this.profileDir = path.join(os.tmpdir(), `farmer-78win-${Date.now()}`);
    this.pool = [];
    this.process = null;
    this.port = null;
    this.browserWsUrl = null;
    this.isRunning = false;
    this.demand = false;
    this.msgId = 0;
    this.onStatus = options.onStatus || (() => {});
    this.targetPoolSize = options.targetPoolSize || 3;
    this.waiters = [];
  }

  async start() {
    if (this.isRunning) return true;

    const chrome = findChrome();
    if (!chrome) {
      this.onStatus('[FARMER] Không tìm thấy Google Chrome thật trên máy để nạp token Turnstile.');
      return false;
    }

    try {
      this.port = await getFreePort();
      fs.mkdirSync(this.profileDir, { recursive: true });

      const args = [
        `--remote-debugging-port=${this.port}`,
        '--remote-debugging-address=127.0.0.1',
        '--remote-allow-origins=*',
        `--user-data-dir=${this.profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-default-apps',
        '--no-startup-window',
        '--silent-launch',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--window-position=5000,5000',
        '--window-size=200,200',
        '--start-minimized',
        'about:blank'
      ];

      this.process = spawn(chrome, args, { stdio: 'ignore' });
      this.isRunning = true;

      // Chờ Chrome mở cổng debug CDP
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 150));
        try {
          const ver = await httpGetJson(`http://127.0.0.1:${this.port}/json/version`);
          if (ver && ver.webSocketDebuggerUrl) {
            this.browserWsUrl = ver.webSocketDebuggerUrl;
            break;
          }
        } catch (e) {}
      }

      if (!this.browserWsUrl) {
        await this.stop();
        this.onStatus('[FARMER] Chrome không mở được cổng debug CDP.');
        return false;
      }

      // Giấu cửa sổ Chrome trên macOS / Windows
      this._hideWindow();

      this.onStatus('[FARMER] Trình nạp token Cloudflare Turnstile CDP đã sẵn sàng.');
      this.loopPromise = this._loop();
      return true;
    } catch (err) {
      this.onStatus(`[FARMER] Lỗi khởi động farmer: ${err.message}`);
      await this.stop();
      return false;
    }
  }

  _hideWindow() {
    if (!this.process || !this.process.pid) return;
    try {
      if (process.platform === 'darwin') {
        execSync(`osascript -e 'tell application "System Events" to set visible of (first process whose unix id is ${this.process.pid}) to false' 2>/dev/null || true`);
      } else if (process.platform === 'win32') {
        const pid = this.process.pid;
        const cmd = `powershell -NoProfile -Command "(Get-Process -Id ${pid}).MainWindowHandle" 2>$null`;
        execSync(cmd);
      }
    } catch (e) {}
  }

  setDemand(wanted, targetSize = null) {
    this.demand = !!wanted;
    if (targetSize != null) {
      this.targetPoolSize = targetSize;
    }
  }

  async stop() {
    this.isRunning = false;
    this.demand = false;

    // Wake up any waiters
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      w(null);
    }

    if (this.process) {
      try { this.process.kill(); } catch (e) {}
      this.process = null;
    }
    try {
      fs.rmSync(this.profileDir, { recursive: true, force: true });
    } catch (e) {}
    this.pool = [];
  }

  async _sendWs(ws, method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.msgId;
      const handler = (event) => {
        try {
          const raw = typeof event.data === 'string' ? event.data : event.data.toString();
          const msg = JSON.parse(raw);
          if (msg.id === id) {
            ws.removeEventListener('message', handler);
            resolve(msg);
          }
        } catch (e) {}
      };
      ws.addEventListener('message', handler);
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        ws.removeEventListener('message', handler);
        resolve({});
      }
      setTimeout(() => {
        ws.removeEventListener('message', handler);
        resolve({});
      }, 6000);
    });
  }

  async _browserCall(method, params = {}) {
    if (!this.browserWsUrl) return {};
    let ws = null;
    try {
      ws = new WebSocket(this.browserWsUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
        setTimeout(() => reject(new Error('Browser WS timeout')), 3000);
      });
      return await this._sendWs(ws, method, params);
    } catch (e) {
      return {};
    } finally {
      if (ws) {
        try { ws.close(); } catch (e) {}
      }
    }
  }

  _notifyWaiters() {
    while (this.waiters.length > 0 && this.pool.length > 0) {
      const waiter = this.waiters.shift();
      const token = this.consumeToken();
      if (token) waiter(token);
    }
  }

  async _loop() {
    const INJECT_SCRIPT = `
    (() => {
      try {
        if (window.turnstile && !document.getElementById('farmer-ts')) {
          const d = document.createElement('div');
          d.id = 'farmer-ts';
          document.body.appendChild(d);
          window.turnstile.render('#farmer-ts', { sitekey: '${this.siteKey}' });
        }
      } catch (e) {}
    })()`;

    const TOKEN_EXPRESSION = `
    (() => {
      try {
        const el = document.querySelector('[name="cf-turnstile-response"]');
        if (el && el.value) return el.value;
        if (window.turnstile && typeof window.turnstile.getResponse === 'function') {
          const v = window.turnstile.getResponse();
          if (v) return v;
        }
        return '';
      } catch (e) { return ''; }
    })()`;

    while (this.isRunning) {
      // Dọn token hết hạn (> 90s)
      const now = Date.now();
      this.pool = this.pool.filter(t => now - t.createdAt < this.tokenTtl);

      // Nếu không có nhu cầu hoặc bể token đã đủ, nghỉ một lúc
      if (!this.demand || this.pool.length >= this.targetPoolSize) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      // Mở 1 tab ngầm để harvest token
      let opened = null;
      try {
        opened = await this._browserCall('Target.createTarget', { url: this.url, background: true });
      } catch (e) {}

      const targetId = opened?.result?.targetId;
      if (!targetId) {
        await new Promise(r => setTimeout(r, 600));
        continue;
      }

      try {
        let wsUrl = null;
        for (let i = 0; i < 25; i++) {
          await new Promise(r => setTimeout(r, 200));
          const list = await httpGetJson(`http://127.0.0.1:${this.port}/json/list`).catch(() => null);
          const tab = (list || []).find(t => t.id === targetId);
          if (tab && tab.webSocketDebuggerUrl) {
            wsUrl = tab.webSocketDebuggerUrl;
            break;
          }
        }

        if (wsUrl) {
          const tabWs = new WebSocket(wsUrl);
          await new Promise((resolve, reject) => {
            tabWs.addEventListener('open', resolve, { once: true });
            tabWs.addEventListener('error', reject, { once: true });
            setTimeout(() => reject(new Error('Tab WS timeout')), 3000);
          }).catch(() => null);

          await this._sendWs(tabWs, 'Runtime.enable');

          // Chờ Turnstile sinh token (tối đa 18 giây)
          const startAt = Date.now();
          let gotToken = null;

          while (this.isRunning && Date.now() - startAt < 18000) {
            await this._sendWs(tabWs, 'Runtime.evaluate', { expression: INJECT_SCRIPT });
            await new Promise(r => setTimeout(r, 500));

            const evalRes = await this._sendWs(tabWs, 'Runtime.evaluate', {
              expression: TOKEN_EXPRESSION,
              returnByValue: true
            });
            const token = evalRes?.result?.result?.value;
            if (token && typeof token === 'string' && token.length > 20) {
              gotToken = token;
              break;
            }
          }

          try { tabWs.close(); } catch (e) {}

          if (gotToken) {
            this.pool.push({ token: gotToken, createdAt: Date.now() });
            this.onStatus(`[FARMER] Đã nhận Turnstile token mới (Bể token: ${this.pool.length}/${this.targetPoolSize}).`);
            this._notifyWaiters();
          }
        }
      } catch (err) {
        // Tab error handled gracefully
      } finally {
        try {
          await this._browserCall('Target.closeTarget', { targetId });
        } catch (e) {}
      }

      await new Promise(r => setTimeout(r, 200));
    }
  }

  consumeToken() {
    const now = Date.now();
    this.pool = this.pool.filter(t => now - t.createdAt < this.tokenTtl);
    if (this.pool.length > 0) {
      return this.pool.shift().token;
    }
    return null;
  }

  async waitForToken(timeoutMs = 15000) {
    const immediate = this.consumeToken();
    if (immediate) return immediate;

    // Kích hoạt demand để farmer nạp ngay
    this.setDemand(true);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(resolve);
        if (idx !== -1) this.waiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);

      this.waiters.push((token) => {
        clearTimeout(timer);
        resolve(token);
      });
    });
  }

  getPoolSize() {
    const now = Date.now();
    this.pool = this.pool.filter(t => now - t.createdAt < this.tokenTtl);
    return this.pool.length;
  }
}

module.exports = {
  findChrome,
  TurnstileFarmer
};

const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');
const http = require('http');

let mainWindow = null;
const PORT = process.env.PORT || 3300;

function isServerRunning(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/api/accounts`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function errorPageHtml(title, detail) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Lỗi khởi động</title>
<style>
  body { background:#020617; color:#f8fafc; font-family:-apple-system,'Segoe UI',Roboto,sans-serif;
         display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
  .box { max-width:640px; padding:32px; background:#0f172a; border:1px solid #334155;
         border-radius:16px; box-shadow:0 10px 30px rgba(0,0,0,.5); }
  h1 { color:#f87171; margin:0 0 12px; font-size:20px; }
  pre { white-space:pre-wrap; word-break:break-all; color:#94a3b8; font-size:12px;
        background:#020617; padding:12px; border-radius:8px; border:1px solid #1e293b; }
  button { margin-top:16px; padding:10px 24px; border:none; border-radius:10px; cursor:pointer;
           background:#2563eb; color:#fff; font-weight:700; font-size:14px; }
  button:hover { background:#1d4ed8; }
</style></head>
<body><div class="box">
  <h1>&#9888;&#65039; ${title}</h1>
  <pre>${detail}</pre>
  <button onclick="location.reload()">Thử lại</button>
</div></body></html>`);
}

async function startServerIfNeeded() {
  if (await isServerRunning(PORT)) {
    console.log(`[ELECTRON] Server đã chạy sẵn trên port ${PORT}.`);
    return;
  }

  console.log(`[ELECTRON] Khởi động Express server trên port ${PORT}...`);
  let bootError = null;
  try {
    require('./server.js');
  } catch (e) {
    bootError = e;
    console.error('[ELECTRON] Lỗi khi start server:', e);
  }

  // Wait until the server actually accepts connections (max ~15s)
  for (let i = 0; i < 30; i++) {
    if (await isServerRunning(PORT)) return;
    await new Promise(r => setTimeout(r, 500));
  }

  if (bootError) {
    throw new Error(bootError.stack || bootError.message);
  }
  throw new Error(`Server không lắng nghe trên port ${PORT} sau 15 giây.`);
}

async function loadApp() {
  // Retry loading the dashboard a few times in case the server is slow to bind
  let lastErr = null;
  for (let i = 0; i < 5; i++) {
    try {
      await mainWindow.loadURL(`http://localhost:${PORT}`);
      return;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  console.error('[ELECTRON] Failed to load URL:', lastErr);
  await mainWindow.loadURL(errorPageHtml('Không tải được giao diện ứng dụng',
    `Không kết nối được http://localhost:${PORT}\n\n${lastErr ? String(lastErr) : ''}`));
}

async function createWindow() {
  let bootError = null;
  try {
    await startServerIfNeeded();
  } catch (e) {
    bootError = e;
  }

  mainWindow = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 900,
    minHeight: 650,
    title: '78Win Live - Automation Tool',
    backgroundColor: '#020617',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  Menu.setApplicationMenu(null); // clean look, no default File/Edit/View menu bar

  if (bootError) {
    await mainWindow.loadURL(errorPageHtml('Lỗi khởi động dịch vụ nội bộ', String(bootError)));
  } else {
    await loadApp();
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const http = require('http');

let mainWindow = null;
let serverInstance = null;
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

async function startServerIfNeeded() {
  const alreadyUp = await isServerRunning(PORT);
  if (!alreadyUp) {
    console.log(`[ELECTRON] Khởi động Express server trên port ${PORT}...`);
    try {
      // server.js starts listening when required
      require('./server.js');
      // wait 500ms
      await new Promise(r => setTimeout(r, 600));
    } catch (e) {
      console.error('[ELECTRON] Lỗi khi start server:', e);
    }
  } else {
    console.log(`[ELECTRON] Server đã chạy sẵn trên port ${PORT}.`);
  }
}

async function createWindow() {
  await startServerIfNeeded();

  mainWindow = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 900,
    minHeight: 650,
    title: '78Win Live - Automation Tool',
    backgroundColor: '#020617',
    titleBarStyle: 'hiddenInset', // Sleek native macOS styling with traffic lights
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

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

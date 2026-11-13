'use strict';
// CobraTex desktop shell — a locked-down window that opens the hosted web app. Nothing else.
// Security model: no Node in the page, sandboxed renderer, navigation pinned to the app origin,
// every permission denied, webviews blocked, external links open in the system browser (https only).
const { app, BrowserWindow, Menu, dialog, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
let APP_URL;
try {
  APP_URL = new URL(cfg.appUrl);
} catch {
  APP_URL = null;
}
const isLocalDev = APP_URL && ['localhost', '127.0.0.1'].includes(APP_URL.hostname);

if (!app.requestSingleInstanceLock()) app.quit();

const isInternal = (u) => {
  try {
    return new URL(u).origin === APP_URL.origin;
  } catch {
    return false;
  }
};
const openExternalSafe = (u) => {
  try {
    if (new URL(u).protocol === 'https:') void shell.openExternal(u);
  } catch {
    /* ignore malformed URLs */
  }
};

let win = null;

function offline() {
  if (!win) return;
  void win.loadFile(path.join(__dirname, 'offline.html'), { query: { u: APP_URL.toString() } });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 420,
    minHeight: 600,
    show: false,
    backgroundColor: '#0D1B2A',
    title: cfg.title || 'CobraTex',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: isLocalDev === true, // closed in production builds
    },
  });
  win.once('ready-to-show', () => win.show());

  // Pop-ups: allow blank print/preview windows and same-origin; everything else leaves to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank' || isInternal(url)) return { action: 'allow' };
    openExternalSafe(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file:') || isInternal(url)) return;
    event.preventDefault();
    openExternalSafe(url);
  });
  win.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) offline(); // -3 = aborted (normal during redirects)
  });

  void win.loadURL(APP_URL.toString());
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  if (!APP_URL || (APP_URL.protocol !== 'https:' && !isLocalDev)) {
    dialog.showErrorBox('إعداد غير صالح', 'عنوان التطبيق في config.json يجب أن يكون https.');
    app.quit();
    return;
  }
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

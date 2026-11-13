'use strict';
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null;
let backend = null;
const logFile = path.join(app.getPath('userData'), 'cobratex.log');
const log = (m) => { try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${m}\n`); } catch { /* ignore */ } };

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function createWindow(url) {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 1000, minHeight: 640, backgroundColor: '#0D1B2A', title: 'CobraTex كوبرا تكس',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  // نافذة ربط Google (OAuth) تُفتح داخل التطبيق لتتمكن من إرسال postMessage للنافذة الرئيسية؛ أي رابط خارجي آخر يُفتح في المتصفح.
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith('https://accounts.google.com/')) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 560, height: 720, autoHideMenuBar: true, parent: win } };
    }
    if (/^https?:/i.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, u) => {
    if (!u.startsWith(url) && !u.startsWith('https://accounts.google.com/')) { e.preventDefault(); shell.openExternal(u); }
  });
  win.loadURL(url);
  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  try {
    backend = await require('./server').start(app.getPath('userData'), log);
    createWindow(backend.url);
  } catch (err) {
    log(String(err && err.stack || err));
    const port = /EADDRINUSE/.test(String(err)) ? '\n\nالمنفذ مستخدم من برنامج آخر: غيّر "port" في ملف config.json داخل مجلد data.' : '';
    dialog.showErrorBox('تعذّر تشغيل كوبرا تكس', `${err && err.message || err}${port}\n\nالسجل: ${logFile}`);
    app.exit(1);
  }
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting || !backend) return;
  e.preventDefault(); quitting = true;
  backend.stop().finally(() => app.exit(0));
});
app.on('window-all-closed', () => app.quit());

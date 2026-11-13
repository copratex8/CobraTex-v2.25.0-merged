import { useSyncExternalStore } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type Os = 'ios' | 'android' | 'windows' | 'mac' | 'linux' | 'other';
export type Browser = 'chrome' | 'edge' | 'firefox' | 'safari' | 'samsung' | 'other';
export interface Env { os: Os; browser: Browser; mobile: boolean }

function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

export function detectEnv(): Env {
  const ua = navigator.userAgent;
  const ipadOs = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  const os: Os = /iPhone|iPad|iPod/.test(ua) || ipadOs ? 'ios' : /Android/.test(ua) ? 'android' : /Windows/.test(ua) ? 'windows' : /Mac OS X|Macintosh/.test(ua) ? 'mac' : /Linux|X11/.test(ua) ? 'linux' : 'other';
  const browser: Browser = /SamsungBrowser/.test(ua) ? 'samsung' : /Edg\//.test(ua) || /EdgA\//.test(ua) || /EdgiOS/.test(ua) ? 'edge'
    : /Firefox\/|FxiOS/.test(ua) ? 'firefox' : /Chrome\/|CriOS/.test(ua) ? 'chrome' : /Safari\//.test(ua) ? 'safari' : 'other';
  return { os, browser, mobile: os === 'ios' || os === 'android' };
}

interface Snapshot { canPrompt: boolean; installed: boolean }

let deferred: BeforeInstallPromptEvent | null = null;
let snapshot: Snapshot = { canPrompt: false, installed: typeof window !== 'undefined' ? isStandalone() : false };
const listeners = new Set<() => void>();
const publish = () => {
  snapshot = { canPrompt: deferred !== null, installed: snapshot.installed };
  listeners.forEach((l) => l());
};

// يُستورد من main.tsx مبكرًا: الحدث يُطلَق مرة واحدة وقد يسبق تركيب أي مكوّن (مثلًا أثناء شاشة الدخول).
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    publish();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    snapshot = { canPrompt: false, installed: true };
    publish();
  });
}

export function useInstallState(): Snapshot {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => snapshot,
    () => snapshot,
  );
}

/** يعرض نافذة التثبيت الأصلية للمتصفح (Android/Windows/Chrome/Edge). يُرجع false إن لم تكن متاحة. */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const evt = deferred;
  deferred = null;
  publish();
  await evt.prompt();
  const { outcome } = await evt.userChoice;
  return outcome === 'accepted';
}

/** ملفات اختصار لسطح المكتب تُولَّد محليًا (لا خادم): Windows .url · macOS .webloc · Linux .desktop */
export function shortcutFile(kind: 'url' | 'webloc' | 'desktop', name: string): { blob: Blob; filename: string } {
  const url = `${window.location.origin}/`;
  const safe = name.replace(/[\\/:*?"<>|]/g, ' ').trim() || 'App';
  if (kind === 'url') return { blob: new Blob([`[InternetShortcut]\r\nURL=${url}\r\n`], { type: 'application/octet-stream' }), filename: `${safe}.url` };
  if (kind === 'webloc') {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>URL</key><string>${url}</string></dict></plist>\n`;
    return { blob: new Blob([xml], { type: 'application/octet-stream' }), filename: `${safe}.webloc` };
  }
  return { blob: new Blob([`[Desktop Entry]\nType=Link\nName=${safe}\nURL=${url}\n`], { type: 'application/octet-stream' }), filename: `${safe}.desktop` };
}

export function downloadShortcut(kind: 'url' | 'webloc' | 'desktop', name: string): void {
  const { blob, filename } = shortcutFile(kind, name);
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

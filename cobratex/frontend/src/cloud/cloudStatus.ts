import { useSyncExternalStore } from 'react';
import { backendOrigin } from '@/api/client';

/**
 * حالة الاتصال بالسحابة (مستخلصة من مؤشر "السحابة" في شريط الهدى العلوي).
 * يفحص GET /health في الباك إند دوريًا:
 *  - online   : الخادم يستجيب بسرعة.
 *  - waking   : الخادم يستجيب ببطء/لم يرد بعد (استضافة مجانية "نائمة" تستيقظ — طبيعي أول طلب).
 *  - offline  : لا إنترنت أو الخادم لا يستجيب.
 */
export type CloudState = 'checking' | 'online' | 'waking' | 'offline';
export interface CloudSnapshot { state: CloudState; latencyMs: number | null; checkedAt: number | null }

const POLL_MS = 60_000;
const SLOW_MS = 4_000;
const TIMEOUT_MS = 45_000;

let snapshot: CloudSnapshot = { state: 'checking', latencyMs: null, checkedAt: null };
const listeners = new Set<() => void>();
let started = false;
let inFlight = false;

function set(next: CloudSnapshot) {
  snapshot = next;
  for (const l of listeners) l();
}

export async function checkCloud(): Promise<void> {
  if (inFlight) return;
  if (!navigator.onLine) {
    set({ state: 'offline', latencyMs: null, checkedAt: Date.now() });
    return;
  }
  inFlight = true;
  const startedAt = performance.now();
  const slowTimer = window.setTimeout(() => {
    if (inFlight) set({ ...snapshot, state: 'waking' });
  }, SLOW_MS);
  const abort = new AbortController();
  const abortTimer = window.setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${backendOrigin}/health`, { cache: 'no-store', signal: abort.signal });
    const latency = Math.round(performance.now() - startedAt);
    set({ state: res.ok ? 'online' : 'offline', latencyMs: latency, checkedAt: Date.now() });
  } catch {
    set({ state: 'offline', latencyMs: null, checkedAt: Date.now() });
  } finally {
    window.clearTimeout(slowTimer);
    window.clearTimeout(abortTimer);
    inFlight = false;
  }
}

function start() {
  if (started) return;
  started = true;
  void checkCloud();
  window.setInterval(() => {
    if (document.visibilityState === 'visible') void checkCloud();
  }, POLL_MS);
  window.addEventListener('online', () => void checkCloud());
  window.addEventListener('offline', () => set({ state: 'offline', latencyMs: null, checkedAt: Date.now() }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkCloud();
  });
}

function subscribe(cb: () => void) {
  start();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useCloudStatus(): CloudSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}

export const CLOUD_LABELS: Record<CloudState, string> = {
  checking: 'جارٍ فحص الاتصال…',
  online: 'متصل بالسحابة',
  waking: 'الخادم يستيقظ… لحظات',
  offline: 'غير متصل',
};

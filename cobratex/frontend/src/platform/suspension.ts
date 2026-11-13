import { useSyncExternalStore } from 'react';

/** حالة "الخدمة موقوفة" كما أمر بها المطوّر عن بُعد (أو انتهاء الترخيص) — تُملأ من مُعترِض axios أو من PlatformWatcher. */
export type SuspensionReason = 'suspended' | 'expired';
interface Suspension { suspended: boolean; message: string; reason: SuspensionReason }

let state: Suspension = { suspended: false, message: '', reason: 'suspended' };
const listeners = new Set<() => void>();

export function markSuspended(message: string, reason: SuspensionReason = 'suspended'): void {
  if (state.suspended && state.message === message && state.reason === reason) return;
  state = { suspended: true, message, reason };
  for (const l of listeners) l();
}

export function useSuspension(): Suspension {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => state,
  );
}

/**
 * حالة الترخيص كما يفرضها الخادم (2.22.0): block = يغطي الواجهة (نطاق/جهاز غير مرخَّص، منتهٍ بوضع الإيقاف، لا ترخيص)،
 * notice = رفض كتابة فقط (منتهٍ بوضع القراءة) فيظهر شريط ولا يُحجب العرض.
 */
interface LicenseIssue { code: string; message: string; block: boolean }
let lic: LicenseIssue | null = null;
const licListeners = new Set<() => void>();
export function markLicenseIssue(code: string, message: string, block: boolean): void {
  if (lic && lic.code === code && lic.block === block) return;
  lic = { code, message, block };
  for (const l of licListeners) l();
}
export function useLicenseIssue(): LicenseIssue | null {
  return useSyncExternalStore((cb) => { licListeners.add(cb); return () => { licListeners.delete(cb); }; }, () => lic);
}

import { useState, type ReactNode } from 'react';
import { useAuth } from '@/auth/AuthContext';
import { useBrand } from '@/brand/BrandProvider';
import { ContactActions } from '@/brand/DeveloperContact';
import { APP_VERSION } from '@/cloud/updates';
import { compareVersions } from '@/platform/version';
import { usePlatformStatus } from '@/platform/usePlatformStatus';

const FORCED_KEY = 'cx_forced_reload_at';

/** تحديث «صلب»: يلغي عامل الخدمة والكاش ثم يعيد التحميل ليجلب أحدث نسخة من الخادم. */
async function hardRefresh(): Promise<void> {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {
    /* نكمل بإعادة التحميل على أي حال */
  }
  try {
    sessionStorage.setItem(FORCED_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
  window.location.reload();
}

function Bar({ tone, children }: { tone: 'red' | 'amber' | 'blue'; children: ReactNode }) {
  const bg = tone === 'red' ? '#b91c1c' : tone === 'amber' ? 'linear-gradient(135deg,var(--gold),var(--gold2))' : 'linear-gradient(135deg,#2980b9,var(--blue))';
  const color = tone === 'amber' ? 'var(--navy)' : '#fff';
  return (
    <div className="ct-no-print flex flex-wrap items-center justify-center gap-3 px-4 py-2 text-sm font-semibold" style={{ background: bg, color }}>
      {children}
    </div>
  );
}

/**
 * تنبيهات يتحكم بها المطوّر عن بُعد (من لوحة المطور):
 *  1) إصدار جديد متاح (اختياري)  ← لافتة بزر تحديث.
 *  2) إصدار أدنى مطلوب (إجباري)   ← شاشة تمنع العمل حتى التحديث.
 * (لافتة قرب انتهاء الترخيص في cloud/LicenseBanner.tsx)
 */
export default function RemoteNotices() {
  const { user } = useAuth();
  const brand = useBrand();
  const { data } = usePlatformStatus(user?.tenantId);
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem('cx_dismissed_remote');
    } catch {
      return null;
    }
  });
  const dismiss = (k: string) => {
    setDismissed(k);
    try {
      sessionStorage.setItem('cx_dismissed_remote', k);
    } catch {
      /* ignore */
    }
  };
  if (!data) return null;

  const upd = data.update;
  const mustUpdate = !!upd?.minVersion && compareVersions(APP_VERSION, upd.minVersion) < 0;
  const canUpdate = !!upd?.latestVersion && compareVersions(APP_VERSION, upd.latestVersion) < 0;

  if (mustUpdate) {
    let recentlyTried = false;
    try {
      recentlyTried = Date.now() - Number(sessionStorage.getItem(FORCED_KEY) ?? 0) < 120_000;
    } catch {
      /* ignore */
    }
    return (
      <div className="fixed inset-0 z-[1100] flex items-center justify-center p-6 text-center" style={{ background: 'rgba(13,27,42,.97)' }}>
        <div className="max-w-md text-white">
          <div className="mb-3 text-5xl">⬆️</div>
          <h2 className="mb-2 text-xl font-bold" style={{ color: 'var(--gold2)' }}>تحديث إلزامي للنظام</h2>
          <p className="mb-2 text-sm text-white/80">{upd?.message || 'يلزم تحديث البرنامج للاستمرار. لن تفقد أي بيانات.'}</p>
          <p className="mb-5 text-xs text-white/50" dir="ltr">v{APP_VERSION} → v{upd?.minVersion}</p>
          {recentlyTried ? (
            <>
              <p className="mb-3 text-sm text-amber-200">لم تصل النسخة الجديدة بعد من الخادم. حاول بعد دقائق أو تواصل مع الدعم.</p>
              <ContactActions text={`مرحبًا، ${brand.appName} يطلب تحديثًا إلزاميًا ولا يكتمل.`} />
            </>
          ) : (
            <button className="btn btn-gold" onClick={() => void hardRefresh()}>تحديث الآن</button>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      {canUpdate && upd && dismissed !== `upd:${upd.latestVersion}` && (
        <Bar tone="blue">
          <span>⬆️ إصدار جديد متاح: v{upd.latestVersion}{upd.message ? ` — ${upd.message}` : ''}</span>
          <button className="rounded-lg bg-white/90 px-3 py-1 text-xs font-bold text-slate-900" onClick={() => void hardRefresh()}>تحديث الآن</button>
          <button onClick={() => dismiss(`upd:${upd.latestVersion}`)} aria-label="إخفاء" className="text-base leading-none">✕</button>
        </Bar>
      )}
    </>
  );
}

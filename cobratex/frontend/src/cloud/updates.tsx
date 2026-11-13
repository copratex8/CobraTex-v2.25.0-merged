import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { useBrand } from '@/brand/BrandProvider';
import { useSuspension, useLicenseIssue } from '@/platform/suspension';
import { ContactActions } from '@/brand/DeveloperContact';

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  downloadUrl?: string | null;
  notes?: string | null;
  note?: string;
  announcement?: string | null;
  license?: { status?: string; message?: string } | null;
}

/**
 * إدارة التحديثات عن بُعد (مستخلصة من نظام الإشعارات الإداري/الترخيص في الهدى لكن بلا Firebase):
 * الباك إند يقرأ ملف JSON ثابت مجاني (UPDATE_FEED_URL) ويمرّر منه: الإصدار الأحدث، الملاحظات،
 * إعلان إداري، وحالة الترخيص. راجع docs/CLOUD-AND-UPDATES.md.
 */
export function useUpdateInfo() {
  return useQuery({
    queryKey: ['update-info', APP_VERSION],
    queryFn: async () =>
      (await apiClient.get<UpdateInfo>('/system/update-check', { params: { currentVersion: APP_VERSION } })).data,
    staleTime: 30 * 60_000,
    refetchInterval: 30 * 60_000,
    retry: false,
  });
}

/** أحداث تحديث عامل الخدمة (واجهة جديدة جاهزة للتفعيل). */
function useServiceWorkerUpdate() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let cancelled = false;
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg || cancelled) return;
      if (reg.waiting && navigator.serviceWorker.controller) setWaiting(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        installing?.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) setWaiting(installing);
        });
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return {
    waiting,
    apply: () => {
      if (!waiting) return;
      navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
      waiting.postMessage({ type: 'SKIP_WAITING' });
    },
  };
}

function Bar({ tone, children }: { tone: 'gold' | 'blue'; children: ReactNode }) {
  const bg = tone === 'gold' ? 'linear-gradient(135deg,var(--gold),var(--gold2))' : 'linear-gradient(135deg,#2980b9,var(--blue))';
  const color = tone === 'gold' ? 'var(--navy)' : '#fff';
  return (
    <div className="ct-no-print flex flex-wrap items-center justify-center gap-3 px-4 py-2 text-sm font-semibold" style={{ background: bg, color }}>
      {children}
    </div>
  );
}

/** الشريط العلوي: إعلان إداري، تحديث متاح للنظام، تحديث واجهة جاهز. */
export function UpdateBars() {
  const { data } = useUpdateInfo();
  const sw = useServiceWorkerUpdate();
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem('cx_dismissed_bar');
    } catch {
      return null;
    }
  });
  const dismiss = (key: string) => {
    setDismissed(key);
    try {
      sessionStorage.setItem('cx_dismissed_bar', key);
    } catch {
      /* التخزين غير متاح — يكفي الإخفاء الحالي */
    }
  };

  const announcement = data?.announcement ?? null;
  const showAnnouncement = announcement && dismissed !== `a:${announcement}`;
  const showUpdate = data?.updateAvailable && dismissed !== `u:${data.latestVersion}`;

  return (
    <>
      {sw.waiting && (
        <Bar tone="blue">
          <span>🔄 يتوفر تحديث جديد لواجهة النظام</span>
          <button onClick={sw.apply} className="rounded-lg bg-white/90 px-3 py-1 text-xs font-bold text-slate-900">
            تحديث الآن
          </button>
        </Bar>
      )}
      {showAnnouncement && (
        <Bar tone="gold">
          <span>📢 {announcement}</span>
          <button onClick={() => dismiss(`a:${announcement}`)} aria-label="إخفاء" className="text-base leading-none">✕</button>
        </Bar>
      )}
      {showUpdate && data && (
        <Bar tone="blue">
          <span>
            ⬆️ إصدار جديد متاح: {data.latestVersion}
            {data.notes ? ` — ${data.notes}` : ''}
          </span>
          {data.downloadUrl && (
            <a href={data.downloadUrl} target="_blank" rel="noreferrer noopener" className="rounded-lg bg-white/90 px-3 py-1 text-xs font-bold text-slate-900">
              التفاصيل
            </a>
          )}
          <button onClick={() => dismiss(`u:${data.latestVersion}`)} aria-label="إخفاء" className="text-base leading-none">✕</button>
        </Bar>
      )}
    </>
  );
}

/**
 * قفل الترخيص (soft gate): إن أعاد ملف التحديث license.status = suspended|blocked|expired تظهر طبقة
 * تغطي الواجهة. ملاحظة أمنية صريحة: هذا حاجز واجهة فقط (قابل للتجاوز تقنيًا) ومخصص للتنبيه التجاري؛
 * الحماية الحقيقية للبيانات تبقى في الباك إند (JWT/RBAC/عزل المستأجر).
 */
export function LicenseGate() {
  const { data, refetch, isFetching } = useUpdateInfo();
  const remote = useSuspension();
  const issue = useLicenseIssue();
  const brand = useBrand();
  const lockedByServer = !!issue?.block;
  const status = remote.suspended ? (remote.reason === 'expired' ? 'expired' : 'suspended') : lockedByServer ? (issue!.code === 'LICENSE_EXPIRED' ? 'expired' : 'blocked') : data?.license?.status;
  if (!status || !['suspended', 'blocked', 'expired'].includes(status)) return null;
  const expired = status === 'expired';
  const message = remote.suspended ? remote.message : lockedByServer ? issue!.message : data?.license?.message;
  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center p-6 text-center" style={{ background: 'rgba(13,27,42,.96)' }}>
      <div className="max-w-md">
        <div className="mb-3 text-5xl">{expired ? '⏳' : '🔒'}</div>
        <h2 className="mb-2 text-xl font-bold" style={{ color: 'var(--gold2)' }}>
          {expired ? 'انتهى اشتراك النظام' : 'تم إيقاف الخدمة مؤقتًا'}
        </h2>
        <p className="mb-5 text-sm text-white/70">
          {message || 'يرجى التواصل مع مزوّد الخدمة لتجديد الترخيص أو تسوية الاشتراك.'}
        </p>
        {(brand.supportPhone || brand.supportEmail) && (
          <p className="mb-3 text-sm text-white/80" dir="ltr">
            {[brand.supportPhone, brand.supportEmail].filter(Boolean).join('  •  ')}
          </p>
        )}
        <ContactActions
          className="mb-5"
          text={expired ? `مرحبًا، انتهى ترخيص ${brand.appName} وأرغب في التجديد.` : `مرحبًا، خدمة ${brand.appName} موقوفة وأحتاج المساعدة.`}
        />
        <button
          onClick={() => (remote.suspended || lockedByServer ? window.location.reload() : void refetch())}
          disabled={isFetching}
          className="btn btn-gold"
        >
          {isFetching ? 'جارٍ التحقق…' : 'إعادة التحقق'}
        </button>
      </div>
    </div>
  );
}

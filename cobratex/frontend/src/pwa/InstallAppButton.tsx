import { useState } from 'react';
import { useBrand } from '@/brand/BrandProvider';
import { detectEnv, downloadShortcut, promptInstall, useInstallState, type Env } from '@/pwa/installStore';

const DISMISS_KEY = 'cobratex_install_banner_dismissed_at';
const DISMISS_DAYS = 7;

function bannerDismissed(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
    return at > 0 && Date.now() - at < DISMISS_DAYS * 86_400_000;
  } catch {
    return false;
  }
}

function steps(env: Env): string[] {
  if (env.os === 'ios') {
    return env.browser === 'safari'
      ? ['اضغط زر «مشاركة» (المربع الذي يخرج منه سهم لأعلى) أسفل الشاشة.', 'اختر «إضافة إلى الشاشة الرئيسية».', 'اضغط «إضافة» — ستجد أيقونة التطبيق في شاشتك الرئيسية.']
      : ['افتح هذا الرابط في متصفح Safari (مطلوب من آبل لإضافة الاختصار).', 'اضغط زر «مشاركة» ثم «إضافة إلى الشاشة الرئيسية» ثم «إضافة».'];
  }
  if (env.os === 'android') return ['اضغط قائمة المتصفح ⋮ (أعلى الشاشة).', 'اختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».', 'أكّد بالضغط على «تثبيت/إضافة» — يظهر الاختصار في شاشتك الرئيسية.'];
  if (env.browser === 'edge') return ['اضغط القائمة ⋯ أعلى المتصفح.', 'اختر «التطبيقات» ثم «تثبيت هذا الموقع كتطبيق».', 'اضغط «تثبيت» — يُنشأ اختصار على سطح المكتب وقائمة ابدأ.'];
  if (env.browser === 'chrome') return ['اضغط أيقونة التثبيت ⊕ في يمين شريط العنوان، أو القائمة ⋮ ← «حفظ ومشاركة» ← «تثبيت…».', 'اضغط «تثبيت» — يُنشأ اختصار على سطح المكتب وقائمة ابدأ.'];
  if (env.browser === 'safari') return ['من قائمة «ملف» اختر «إضافة إلى Dock».'];
  return ['متصفحك لا يدعم تثبيت التطبيقات. استخدم Chrome أو Edge، أو نزّل ملف الاختصار أدناه لوضعه على سطح المكتب.'];
}

function GuideModal({ onClose }: { onClose: () => void }) {
  const brand = useBrand();
  const env = detectEnv();
  const desktopFile = env.os === 'windows' ? 'url' : env.os === 'mac' ? 'webloc' : env.os === 'linux' ? 'desktop' : null;
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(`${window.location.origin}/`).then(() => setCopied(true));
  };
  return (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 text-slate-800 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-1 text-lg font-extrabold">📲 إضافة اختصار {brand.appName}</h2>
        <p className="mb-4 text-sm text-slate-500">{env.mobile ? 'لفتح البرنامج بضغطة واحدة من شاشة الموبايل أو التابلت.' : 'لفتح البرنامج بضغطة واحدة من سطح المكتب.'}</p>
        <ol className="mb-4 list-decimal space-y-2 ps-5 text-sm leading-7">
          {steps(env).map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        {desktopFile && (
          <div className="mb-3 rounded-xl bg-slate-50 p-3 text-sm">
            <p className="mb-2 font-semibold">أو نزّل اختصارًا جاهزًا لسطح المكتب:</p>
            <button className="w-full rounded-lg bg-slate-900 px-4 py-2 font-bold text-white" onClick={() => downloadShortcut(desktopFile, brand.appName)}>
              ⬇ تنزيل اختصار سطح المكتب
            </button>
            <p className="mt-2 text-xs text-slate-500">بعد التنزيل اسحب الملف إلى سطح المكتب (قد يطلب المتصفح تأكيد حفظه).</p>
          </div>
        )}
        <div className="flex gap-2">
          <button className="flex-1 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold" onClick={copy}>
            {copied ? '✓ تم نسخ الرابط' : 'نسخ رابط البرنامج'}
          </button>
          <button className="flex-1 rounded-lg bg-slate-200 px-4 py-2 text-sm font-semibold" onClick={onClose}>إغلاق</button>
        </div>
      </div>
    </div>
  );
}

type Variant = 'banner' | 'sidebar' | 'icon';

/**
 * زر «إضافة اختصار»: يثبّت التطبيق بنافذة المتصفح الأصلية حيث أمكن، وإلا يعرض خطوات دقيقة لنوع الجهاز/المتصفح
 * وملف اختصار لسطح المكتب. 'banner' = لافتة بارزة تظهر من أول فتح (شاشة الدخول) ويمكن تأجيلها 7 أيام.
 */
export default function InstallAppButton({ variant }: { variant: Variant }) {
  const brand = useBrand();
  const { canPrompt, installed } = useInstallState();
  const [guide, setGuide] = useState(false);
  const [hidden, setHidden] = useState(() => variant === 'banner' && bannerDismissed());

  if (!brand.installPrompt || installed || hidden) return null;

  const act = async () => {
    if (canPrompt && (await promptInstall())) return;
    if (!canPrompt) setGuide(true);
  };
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* التخزين غير متاح */
    }
    setHidden(true);
  };
  const env = detectEnv();

  return (
    <>
      {variant === 'banner' && (
        <div className="ct-no-print mb-4 flex w-full max-w-sm items-center gap-3 rounded-2xl bg-white/95 p-3 shadow-xl">
          <span className="text-3xl" aria-hidden="true">📲</span>
          <div className="min-w-0 flex-1 text-sm">
            <b className="block text-slate-900">أضف اختصار البرنامج</b>
            <span className="text-xs text-slate-500">{env.mobile ? 'على الشاشة الرئيسية للموبايل/التابلت' : 'على سطح المكتب للوصول السريع'}</span>
          </div>
          <button className="rounded-lg px-3 py-2 text-sm font-bold text-slate-900" style={{ background: 'var(--gold2)' }} onClick={() => void act()}>إضافة</button>
          <button className="px-1 text-lg leading-none text-slate-400" aria-label="لاحقًا" onClick={dismiss}>✕</button>
        </div>
      )}
      {variant === 'sidebar' && (
        <button onClick={() => void act()} className="btn btn-gold mb-2 w-full justify-center">📲 إضافة اختصار التطبيق</button>
      )}
      {variant === 'icon' && (
        <button onClick={() => void act()} title="إضافة اختصار التطبيق" aria-label="إضافة اختصار التطبيق" className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-50 text-base">📲</button>
      )}
      {guide && <GuideModal onClose={() => setGuide(false)} />}
    </>
  );
}

import { useBrand } from '@/brand/BrandProvider';

/** أرقام الدولية: 01014868778 → 201014868778 (مصر). تُمرَّر كما هي إن بدأت بـ+ أو كانت دولية. */
export function toWhatsAppNumber(raw: string): string {
  const d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d.slice(1);
  if (d.startsWith('00')) return d.slice(2);
  if (d.startsWith('0')) return '20' + d.slice(1);
  return d;
}
export function whatsappUrl(number: string, text: string): string {
  return `https://wa.me/${toWhatsAppNumber(number)}?text=${encodeURIComponent(text)}`;
}

const WaIcon = ({ size = 26 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" fill="currentColor">
    <path d="M16.04 3C9.4 3 4 8.38 4 15c0 2.12.56 4.19 1.62 6.01L4 29l8.2-1.58A12.1 12.1 0 0 0 16.04 27C22.66 27 28 21.62 28 15S22.66 3 16.04 3zm0 21.98c-1.8 0-3.56-.48-5.1-1.4l-.37-.22-4.86.94.98-4.74-.24-.39A9.93 9.93 0 0 1 6.07 15c0-5.5 4.46-9.97 9.97-9.97S26 9.5 26 15s-4.46 9.98-9.96 9.98zm5.47-7.46c-.3-.15-1.77-.87-2.04-.97-.28-.1-.48-.15-.68.15-.2.3-.78.97-.95 1.17-.18.2-.35.22-.65.07-.3-.15-1.27-.47-2.42-1.5-.9-.8-1.5-1.78-1.67-2.08-.18-.3-.02-.46.13-.6.13-.14.3-.35.45-.52.15-.18.2-.3.3-.5.1-.2.05-.38-.02-.53-.08-.15-.68-1.64-.93-2.25-.24-.58-.5-.5-.68-.5l-.58-.01c-.2 0-.52.07-.8.38-.27.3-1.04 1.02-1.04 2.5s1.07 2.9 1.22 3.1c.15.2 2.1 3.2 5.08 4.49.7.3 1.26.48 1.69.62.7.22 1.35.19 1.86.12.57-.08 1.77-.72 2.02-1.42.25-.7.25-1.3.17-1.42-.07-.12-.27-.2-.57-.35z" />
  </svg>
);

/** زر واتساب عائم للتواصل المباشر مع المطوّر (دعم فني). يظهر على كل الصفحات ولا يُطبع. */
export function WhatsAppFab() {
  const { developer, appName } = useBrand();
  const number = developer.whatsapp || developer.phone;
  if (!number) return null;
  return (
    <a
      href={whatsappUrl(number, `مرحبًا، أحتاج مساعدة في نظام ${appName}`)}
      target="_blank" rel="noreferrer noopener"
      className="ct-no-print fixed z-[800] flex items-center justify-center rounded-full shadow-xl transition-transform hover:scale-105"
      style={{ position: 'fixed', left: 16, bottom: 'max(16px, env(safe-area-inset-bottom))', width: 52, height: 52, background: '#25D366', color: '#fff' }}
      aria-label="تواصل مع الدعم الفني عبر واتساب" title="تواصل مع الدعم الفني عبر واتساب" data-testid="whatsapp-fab"
    >
      <WaIcon />
    </a>
  );
}
/** رقم المطوّر الاحتياطي: يبقى متاحًا حتى لو أُفرغ حقل developer.phone في brand.json. */
export const FALLBACK_DEVELOPER_PHONE = '01014868778';

export function useDeveloperContact() {
  const { developer, appName } = useBrand();
  const phone = developer.whatsapp?.trim() || developer.phone?.trim() || FALLBACK_DEVELOPER_PHONE;
  return {
    phone,
    name: developer.name,
    appName,
    tel: `tel:+${toWhatsAppNumber(phone)}`,
    wa: (text?: string) => whatsappUrl(phone, text ?? `مرحبًا، أحتاج مساعدة بخصوص نظام ${appName}`),
  };
}

/** أزرار «واتساب + اتصال» داخل الصفحات (شاشة الإيقاف، شاشة الدخول، التحديث الإلزامي). */
export function ContactActions({ text, className = '' }: { text?: string; className?: string }) {
  const c = useDeveloperContact();
  return (
    <div className={`flex flex-wrap items-center justify-center gap-2 ${className}`}>
      <a href={c.wa(text)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold text-white" style={{ background: '#25D366' }}>
        <WaIcon size={16} /> واتساب
      </a>
      <a href={c.tel} className="inline-flex items-center gap-2 rounded-lg bg-white/90 px-4 py-2 text-sm font-bold text-slate-900">
        <span aria-hidden="true">📞</span> <span dir="ltr">{c.phone}</span>
      </a>
    </div>
  );
}
export { WaIcon };

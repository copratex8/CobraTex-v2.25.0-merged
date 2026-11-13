import { useDeveloperContact } from '@/brand/contact';

/** زر واتساب عائم (اتصال مباشر بالمطوّر). لا يظهر في الطباعة. */
export default function WhatsAppButton({ text }: { text?: string }) {
  const c = useDeveloperContact();
  const message = text ?? `مرحبًا، أحتاج مساعدة بخصوص نظام ${c.appName}`;
  return (
    <a
      href={c.wa(message)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="تواصل مع المطوّر عبر واتساب"
      title={`واتساب: ${c.phone}`}
      className="ct-no-print fixed bottom-4 start-4 z-40 flex items-center gap-2 rounded-full px-4 py-3 text-sm font-bold text-white shadow-lg transition hover:scale-105"
      style={{ background: '#25D366' }}
    >
      <span aria-hidden="true" className="text-lg leading-none">💬</span>
      <span className="hidden sm:inline">واتساب</span>
    </a>
  );
}

/** أزرار «واتساب + اتصال» داخل الصفحات (شاشة الإيقاف، لافتات الاشتراك، شاشة الدخول). */
export function ContactActions({ text, className = '' }: { text?: string; className?: string }) {
  const c = useDeveloperContact();
  return (
    <div className={`flex flex-wrap items-center justify-center gap-2 ${className}`}>
      <a
        href={c.wa(text ?? `مرحبًا، أحتاج مساعدة بخصوص نظام ${c.appName}`)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold text-white"
        style={{ background: '#25D366' }}
      >
        <span aria-hidden="true">💬</span> واتساب
      </a>
      <a href={c.tel} className="inline-flex items-center gap-2 rounded-lg bg-white/90 px-4 py-2 text-sm font-bold text-slate-900">
        <span aria-hidden="true">📞</span> <span dir="ltr">{c.phone}</span>
      </a>
    </div>
  );
}

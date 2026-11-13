import { useBrand } from '@/brand/BrandProvider';
import { WaIcon, whatsappUrl } from '@/brand/DeveloperContact';

/** شعار الهوية (من brand.json). `size` بالبكسل. */
export function BrandLogo({ size = 64, className = '' }: { size?: number; className?: string }) {
  const brand = useBrand();
  return (
    <img
      src={brand.logoUrl}
      alt={brand.appName}
      width={size}
      height={size}
      className={`rounded-2xl bg-white object-contain p-1 ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

/** الشعار الكامل (الشعار + الاسم + الشعار اللفظي) — يُعرض على خلفية بيضاء. */
export function BrandLogoFull({ width = 220, className = '' }: { width?: number; className?: string }) {
  const brand = useBrand();
  return <img src={brand.logoFullUrl} alt={brand.appName} className={className} style={{ width, maxWidth: '100%', height: 'auto' }} />;
}

/** سطر حقوق التطوير — يظهر في تذييل الصفحات وشاشة الدخول وصفحة الإعدادات. */
export function DeveloperCredit({ className = '' }: { className?: string }) {
  const { developer } = useBrand();
  if (!developer.showCredit) return null;
  const text = developer.creditText;
  return (
    <p className={className} data-testid="developer-credit">
      {developer.url ? (
        <a href={developer.url} target="_blank" rel="noreferrer noopener" className="hover:underline">
          {text}
        </a>
      ) : (
        text
      )}
      {developer.phone && (
        <>
          {' · '}
          <a href={`tel:${developer.phone}`} dir="ltr" className="hover:underline" data-testid="developer-phone">
            {developer.phone}
          </a>
          {' · '}
          <a href={whatsappUrl(developer.whatsapp || developer.phone, 'مرحبًا، أحتاج مساعدة في النظام')} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 align-middle hover:underline" data-testid="developer-whatsapp">
            <WaIcon size={13} /> واتساب
          </a>
        </>
      )}
    </p>
  );
}

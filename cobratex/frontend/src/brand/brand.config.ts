/**
 * الهوية الافتراضية لـ CobraTex + محرّك دمج الهوية (White-label).
 *
 * أولوية القيم (الأعلى يغلب):  /brand.json (وقت التشغيل)  >  هذه القيم الافتراضية.
 * أي عميل تجاري يعيد بيع النظام باسمه يعدّل `public/brand.json` فقط (الاسم، الشعار، الألوان، اسم الشركة)
 * — لا كود يتغيّر. راجع docs/WHITE-LABEL.md.
 */

export interface BrandConfig {
  appName: string;
  appNameEn: string;
  tagline: string;
  /** شعار مربع (الشريط الجانبي، الإعدادات). */
  logoUrl: string;
  /** الشعار الكامل مع الاسم (شاشة الدخول). */
  logoFullUrl: string;
  faviconUrl: string;
  /** اسم الجهة المالكة/المعيدة للبيع (تظهر في التذييل وصفحة الدخول). */
  companyName: string;
  website: string;
  supportPhone: string;
  supportEmail: string;
  developer: {
    name: string;
    creditText: string;
    /** رقم هاتف المطوّر: يظهر بجانب سطر الحقوق (اتركه فارغًا لإخفائه). */
    phone: string;
    /** رقم واتساب المطوّر بالصيغة الدولية بلا + (مثال 201014868778). فارغ = يُستخدم phone. */
    whatsapp: string;
    url: string;
    /** إخفاء/إظهار سطر حقوق المطوّر — قرار مالك الترخيص (المطوّر الأصلي) لا العميل النهائي. */
    showCredit: boolean;
  };
  theme: { navy: string; navy2: string; gold: string; gold2: string };
  /** يُملأ تلقائيًا في شاشة الدخول (مفيد لنشر عميل واحد). فارغ = يُدخَل يدويًا ويُحفَظ آخر قيمة. */
  defaultTenantId: string;
  installPrompt: boolean;
}

export const DEFAULT_BRAND: BrandConfig = {
  appName: 'كوبرا تكس',
  appNameEn: 'CobraTex',
  tagline: 'نظام إدارة موارد المؤسسات المتكامل',
  logoUrl: '/brand/emblem.png',
  logoFullUrl: '/brand/logo-full.jpg',
  faviconUrl: '/favicon.png',
  companyName: 'كوبرا تكس',
  website: '',
  supportPhone: '',
  supportEmail: '',
  developer: {
    name: 'شركة حي تك',
    creditText: 'تم التطوير بواسطة شركة حي تك - جميع الحقوق محفوظة',
    phone: '01014868778',
    whatsapp: '201014868778',
    url: '',
    showCredit: true,
  },
  theme: { navy: '#0D1B2A', navy2: '#162336', gold: '#C9A84C', gold2: '#E8C96A' },
  defaultTenantId: '',
  installPrompt: true,
};

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** دمج عميق: القيم النصية الفارغة في الملف لا تمسح الافتراضي (باستثناء الحقول الاختيارية الفارغة أصلًا). */
export function mergeBrand<T extends Json>(base: T, override: unknown): T {
  if (!isObject(override)) return base;
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key.startsWith('_')) continue; // مفاتيح التعليقات مثل _readme
    const current = out[key];
    if (isObject(current) && isObject(value)) out[key] = mergeBrand(current, value);
    else if (typeof value === typeof current && value !== undefined && value !== null) {
      out[key] = typeof value === 'string' && value.trim() === '' && typeof current === 'string' && current !== '' ? current : value;
    }
  }
  return out as T;
}

const CLIENT_KEY = 'cobratex_client_slug';

/** يحدّد عميل هذا الرابط (2.23.0): النطاق ثم ?c=الرمز ثم ?t=المعرّف؛ ويتذكر الرمز لجلسات PWA بلا استعلام. */
async function loadClientBrand(): Promise<{ tenantId: string | null; brand: Record<string, unknown> } | null> {
  const base = import.meta.env.VITE_API_BASE_URL;
  if (!base) return null;
  try {
    const sp = new URLSearchParams(location.search);
    let slug = sp.get('c');
    const t = sp.get('t');
    try { if (slug) localStorage.setItem(CLIENT_KEY, slug); else if (!t) slug = localStorage.getItem(CLIENT_KEY); } catch { /* ignore */ }
    const q = new URLSearchParams({ host: location.hostname });
    if (slug) q.set('c', slug);
    if (t) q.set('t', t);
    const res = await fetch(`${base}/public/brand?${q}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const r = await res.json();
    return r && r.tenantId ? r : null;
  } catch { return null; }
}

/** يجلب /brand.json (أو VITE_BRAND_CONFIG_URL) ثم يطبّق فوقه هوية العميل من الخادم إن وُجدت. أي فشل يُرجع الأساس بصمت. */
export async function loadBrand(): Promise<BrandConfig> {
  const url = import.meta.env.VITE_BRAND_CONFIG_URL || '/brand.json';
  let base: BrandConfig = DEFAULT_BRAND;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (res.ok) base = mergeBrand(DEFAULT_BRAND as unknown as Json, await res.json()) as unknown as BrandConfig;
  } catch { /* الافتراضي */ }
  const client = await loadClientBrand();
  if (!client) return base;
  const merged = mergeBrand(base as unknown as Json, client.brand) as unknown as BrandConfig;
  // لا يُسمح لهوية العميل بتغيير بيانات المطوّر (الخادم لا يقبلها أصلًا — حماية مزدوجة).
  return { ...merged, developer: base.developer, defaultTenantId: client.tenantId ?? merged.defaultTenantId };
}

/** يطبّق الهوية على المستند: متغيرات الألوان، العنوان، أيقونة التبويب، لون شريط المتصفح. */
export function applyBrandToDocument(brand: BrandConfig): void {
  const root = document.documentElement;
  root.style.setProperty('--navy', brand.theme.navy);
  root.style.setProperty('--navy2', brand.theme.navy2);
  root.style.setProperty('--gold', brand.theme.gold);
  root.style.setProperty('--gold2', brand.theme.gold2);
  document.title = `${brand.appName} | ${brand.appNameEn}`;
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute('content', brand.theme.navy);
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (icon && brand.faviconUrl) icon.href = brand.faviconUrl;
}

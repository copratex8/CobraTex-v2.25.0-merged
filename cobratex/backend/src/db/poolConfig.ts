import type { PoolConfig } from 'pg';

/**
 * إعداد اتصال PostgreSQL موحَّد (يستخدمه pool.ts و migrate.ts) ليعمل بلا تعديل على:
 * - PostgreSQL محلي (بلا SSL).
 * - Supabase / Neon / أي مزود سحابي (SSL إلزامي).
 *
 * متغيرات اختيارية (لا تغيّر السلوك المحلي الافتراضي):
 * - DATABASE_SSL = "true" | "false" | "auto"(افتراضي): auto يفعّل SSL تلقائيًا لأي مضيف غير محلي.
 * - DATABASE_SSL_CA: محتوى شهادة CA (PEM) للتحقق الصارم من الخادم. بدونه يُشفَّر الاتصال دون التحقق
 *   من هوية الخادم (rejectUnauthorized=false) — وهو الخيار العملي مع مجمّع اتصالات Supabase المجاني.
 * - DB_POOL_MAX: أقصى عدد اتصالات (افتراضي 10). على Vercel Serverless اضبطه على 1 أو 2.
 */
export function buildPoolConfig(databaseUrl: string): PoolConfig {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    // رابط غير قابل للتحليل (مثلًا رمز خاص غير مُرمَّز في كلمة المرور) — نُمرِّره كما هو ليُبلغ pg بالخطأ الأوضح.
    return { connectionString: databaseUrl, max: Number(process.env.DB_POOL_MAX ?? 10), idleTimeoutMillis: 30_000 };
  }
  const host = url.hostname;
  const isLocal = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) || host.endsWith('.local');

  // pg-connection-string يُعطي قيم sslmode/ssl في الرابط أولوية على خيار ssl الصريح — نُزيلها ونتحكم نحن.
  const hadSslParam = url.searchParams.has('sslmode') || url.searchParams.has('ssl');
  url.searchParams.delete('sslmode');
  url.searchParams.delete('ssl');

  const mode = (process.env.DATABASE_SSL ?? 'auto').toLowerCase();
  const useSsl = mode === 'true' ? true : mode === 'false' ? false : !isLocal || hadSslParam;

  let ssl: PoolConfig['ssl'] = undefined;
  if (useSsl) {
    const ca = process.env.DATABASE_SSL_CA;
    ssl = ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };
  }

  return {
    connectionString: url.toString(),
    ssl,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
  };
}

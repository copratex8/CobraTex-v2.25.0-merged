import 'dotenv/config';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`متغير البيئة المطلوب غير معرَّف: ${name}`);
  }
  return value;
}

function strongSecret(name: string): string {
  const v = requireEnv(name);
  if ((process.env.NODE_ENV ?? 'development') === 'production' && v.length < 32) throw new Error(`${name} قصير جدًا: يلزم 32 حرفًا عشوائيًا على الأقل في الإنتاج`);
  return v;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: requireEnv('DATABASE_URL'),
  jwtAccessSecret: strongSecret('JWT_ACCESS_SECRET'),
  jwtRefreshSecret: strongSecret('JWT_REFRESH_SECRET'),
  // خلف بروكسي (Vercel/Render/Nginx) اضبط TRUST_PROXY=1 ليُحسب حدّ المحاولات على IP العميل الحقيقي لا على IP البروكسي.
  trustProxy: process.env.TRUST_PROXY ? (Number.isNaN(Number(process.env.TRUST_PROXY)) ? process.env.TRUST_PROXY : Number(process.env.TRUST_PROXY)) : (process.env.NODE_ENV === 'production' ? 1 : false),
  accessTokenTtl: '15m',
  refreshTokenTtl: '7d',
  // اختياري عمدًا (undefined محليًا لا يكسر التطوير) — إن ضُبط، يُشترَط تمريره لإنشاء أي مستأجر
  // جديد عبر /bootstrap (راجع bootstrapRoutes.ts). بلا ضبطه، المسار مفتوح للجميع — مقبول للتطوير
  // المحلي فقط، خطر أمني حقيقي في أي بيئة منشورة (إنشاء مستأجرين/حسابات مالك بلا حد).
  bootstrapSecret: process.env.BOOTSTRAP_SECRET,
  // نطاقات الواجهة المسموح لها بالاتصال (مفصولة بفواصل). بلا ضبط: مفتوح في التطوير فقط؛ في الإنتاج يُسجَّل تحذير ويبقى مفتوحًا
  // حفاظًا على النشرات القائمة (المصادقة بتوكن Bearer لا كوكيز فخطر CORS المفتوح محدود، لكن الحصر أصحّ).
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map((x) => x.trim().replace(/\/$/, '')).filter(Boolean),
};

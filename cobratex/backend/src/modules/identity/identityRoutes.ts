import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { login, refreshSession, logoutSession } from '@/modules/identity/identityService';

export const authRouter = Router();

// بعد الانتقال إلى Supabase Auth اضبط DISABLE_LEGACY_LOGIN=true: يُغلق الدخول/التجديد الخاص (سطح هجوم إضافي، وحدّ المحاولات
// في الذاكرة لا يصمد على Serverless). الدخول يصبح عبر Supabase Auth فقط (حدود معدّل + CAPTCHA اختياري من لوحته).
authRouter.use(['/auth/login', '/auth/refresh'], (_req, res, next) => {
  if (process.env.DISABLE_LEGACY_LOGIN === 'true') return res.status(404).json({ error: 'غير متاح' });
  next();
});

/**
 * فجوة موثَّقة كانت في هذا الملف نفسه (راجع الإصدار السابق): لا حدّ لمحاولات تسجيل الدخول إطلاقًا،
 * ما يسمح بهجمات القوة الغاشمة (brute force) على كلمات المرور. حد معقول: 10 محاولات كل 15 دقيقة
 * لكل IP، يُحسَب فقط للمحاولات الفاشلة (نجاح الدخول لا يُستهلَك من الحصة) حتى لا يُعاقَب مستخدم
 * شرعي يُخطئ مرة أو اثنتين ثم ينجح.
 */
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'محاولات دخول كثيرة جدًا، حاول مجددًا بعد قليل' },
});

/** حدّ ثانٍ لكل (عميل + بريد) بصرف النظر عن الـIP: يُفشل تخمين كلمة مرور حساب بعينه من عدة عناوين. */
const accountRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: false,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${String(req.body?.tenantId ?? '').slice(0, 40)}|${String(req.body?.email ?? '').toLowerCase().slice(0, 200)}`,
  validate: { keyGeneratorIpFallback: false },
  message: { error: 'محاولات دخول كثيرة لهذا الحساب، حاول مجددًا بعد قليل' },
});
const refreshRateLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false, message: { error: 'طلبات تجديد كثيرة، حاول لاحقًا' } });

authRouter.post('/auth/login', loginRateLimiter, accountRateLimiter, async (req, res, next) => {
  try {
    const { email, password, tenantId } = req.body ?? {};
    if (!email || !password || !tenantId) {
      return res.status(422).json({ error: 'البريد وكلمة المرور ومعرّف المستأجر مطلوبة' });
    }
    const session = await login(email, password, tenantId);
    res.status(200).json(session);
  } catch (err) {
    next(err);
  }
});

/**
 * فجوة موثَّقة كانت في AuthContext.tsx/client.ts بالواجهة: لا Refresh Token إطلاقًا، الجلسة
 * تنتهي بعد 15 دقيقة وتتطلب دخولًا جديدًا. مسار عام (بلا authMiddleware) عمدًا: access token قد
 * يكون منتهيًا فعلًا عند طلب التجديد، فالثقة هنا في توقيع refresh token نفسه (راجع
 * identityService.refreshSession)، بالضبط كما /auth/login لا يتطلب توكنًا أصلًا.
 */
authRouter.post('/auth/refresh', refreshRateLimiter, async (req, res, next) => {
  try {
    const { refreshToken } = req.body ?? {};
    if (!refreshToken) return res.status(422).json({ error: 'refreshToken مطلوب' });
    const session = await refreshSession(refreshToken);
    res.status(200).json(session);
  } catch (err) {
    next(err);
  }
});

authRouter.post('/auth/logout', async (req, res, next) => {
  try {
    const { refreshToken } = req.body ?? {};
    if (refreshToken) await logoutSession(refreshToken);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

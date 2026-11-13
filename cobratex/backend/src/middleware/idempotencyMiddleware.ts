import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { pool } from '@/db/pool';

/**
 * يدعم رأس Idempotency-Key القياسي. عند تكرار نفس المفتاح لنفس المؤسسة ونفس المسار:
 * - إن كان جسم الطلب مطابقًا لأول مرة → تُعاد نفس الاستجابة المخزَّنة دون تنفيذ العملية مجددًا.
 * - إن اختلف جسم الطلب لنفس المفتاح → 422 (سوء استخدام للمفتاح، منع كتم أخطاء صامتة).
 * يُسجَّل الرد الفعلي بعد اكتمال المعالج عبر اعتراض res.json (انظر أسفل الملف).
 */
export function idempotencyMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.header('Idempotency-Key');
    if (!key) return next(); // الرأس اختياري؛ العمليات القابلة لإعادة الإرسال فقط تحتاجه

    const companyId = req.ctx?.companyId;
    if (!companyId) return next(); // يُطبَّق بعد authMiddleware فقط

    const endpoint = `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`;
    const requestHash = crypto.createHash('sha256').update(JSON.stringify(req.body ?? {})).digest('hex');

    const existing = await pool.query(
      `SELECT request_hash, response_status, response_body FROM idempotency_keys
       WHERE company_id = $1 AND idempotency_key = $2 AND endpoint = $3`,
      [companyId, key, endpoint],
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      if (row.request_hash !== requestHash) {
        return res.status(422).json({
          error: 'مفتاح Idempotency-Key مستخدم من قبل بجسم طلب مختلف',
        });
      }
      return res.status(row.response_status).json(row.response_body);
    }

    const originalJson = res.json.bind(res);
    // نعترض res.json بنسخة تنتظر (await) اكتمال كتابة السجل في قاعدة البيانات *قبل* إرسال
    // الاستجابة الفعلية للعميل — يمنع هذا نافذة سباق (race window) بين رد الطلب الأول ووصول
    // طلب ثانٍ سريع جدًا بنفس المفتاح (كما ظهر فعليًا في اختبار التعارض قبل هذا الإصلاح).
    res.json = ((body: unknown) => {
      pool
        .query(
          `INSERT INTO idempotency_keys(company_id, idempotency_key, endpoint, request_hash, response_status, response_body)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (company_id, idempotency_key, endpoint) DO NOTHING`,
          [companyId, key, endpoint, requestHash, res.statusCode, JSON.stringify(body)],
        )
        .catch((e) => console.error('idempotency store failed', e))
        .finally(() => originalJson(body));
      return res;
    }) as typeof res.json;

    next();
  };
}

import { Request, Response, NextFunction } from 'express';
import { ForbiddenScopeError } from '@/shared/requestContext';
import { AppError } from '@/shared/errors';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ForbiddenScopeError) {
    return res.status(403).json({ error: err.message });
  }
  if (err instanceof AppError) {
    const code = (err as { code?: string }).code;
    return res.status(err.status).json(code ? { error: err.message, code } : { error: err.message });
  }
  // خطأ multer (رفع ملفات) — الأشيع: تجاوز الحد الأقصى لحجم الملف. رسالة عربية واضحة بدل 500 عام.
  const multerErr = err as { name?: string; code?: string };
  if (multerErr?.name === 'MulterError') {
    const message = multerErr.code === 'LIMIT_FILE_SIZE' ? 'حجم الملف يتجاوز الحد المسموح' : 'تعذَّر رفع الملف';
    return res.status(422).json({ error: message });
  }
  // خطأ قيد قاعدة بيانات (FK/UNIQUE/CHECK/Trigger) — لا نُسرّب تفاصيل SQL الداخلية للعميل،
  // لكن نُسجّلها في السجل، ونُعيد 409 لأخطاء القيود المعروفة.
  const pgErr = err as { code?: string; message?: string };
  if (pgErr?.code && ['23505', '23503', '23514', 'P0001'].includes(pgErr.code)) {
    console.error('[db-constraint]', pgErr.code, pgErr.message);
    // P0001 = RAISE EXCEPTION من قواعد العمل (رسالتها عربية مقصودة للمستخدم)؛ قيود 23xxx لا تُسرَّب تفاصيلها.
    return res.status(409).json({ error: 'تعارض في قواعد سلامة البيانات', ...(pgErr.code === 'P0001' ? { detail: pgErr.message } : {}) });
  }
  // eslint-disable-next-line no-console
  console.error(err);
  return res.status(500).json({ error: 'خطأ داخلي غير متوقع' });
}

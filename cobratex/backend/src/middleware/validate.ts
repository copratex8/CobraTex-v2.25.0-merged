import { Request, Response, NextFunction } from 'express';
import { ZodType, ZodError } from 'zod';
import { ValidationError } from '@/shared/errors';

interface ValidationSchemas {
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
}

function formatZodError(error: ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('؛ ');
}

/**
 * تحقق مركزي على الخادم لـ params/query/body، برسائل 422 واضحة. المخططات تستخدم .strict()
 * افتراضيًا (عبر z.strictObject أو .strict()) لرفض أي حقل غير متوقع — يمنع تسريب حقول أمنية
 * (company_id/tenant_id/branch_id/warehouse_id) عبر جسم الطلب أو الاستعلام دون أن يلحظها أحد؛
 * أي حقل مرسل يفوق المخطط يُرفض صراحة بدل تجاهله بصمت.
 */
export function validate(schemas: ValidationSchemas) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params) as typeof req.params;
      // ملاحظة: req.query في Express 5 خاصية getter بلا setter (مُشتقّة من req.url مباشرة)،
      // فإعادة تعيينها (req.query = ...) ترمي TypeError في الوضع الصارم. نكتفي بالتحقق (parse)
      // لإثبات الصحة ورفض الحقول غير المتوقعة، دون محاولة استبدال الكائن نفسه؛ المسارات تقرأ
      // req.query كما هي (نصوصًا خامًا) بعد اجتياز التحقق بنجاح.
      if (schemas.query) schemas.query.parse(req.query);
      if (schemas.body) req.body = schemas.body.parse(req.body ?? {});
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        return next(new ValidationError(`تحقق من المدخلات فشل: ${formatZodError(err)}`));
      }
      next(err);
    }
  };
}

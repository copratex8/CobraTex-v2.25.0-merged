import { Request, Response, NextFunction } from 'express';

/** يتحقق فقط من امتلاك كود الصلاحية (بلا فحص فرع، لأن الفرع غالبًا يأتي من body ويُفحص داخل الخدمة). */
export function requirePermission(code: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.ctx.assertPermission(code);
      next();
    } catch (err) {
      next(err);
    }
  };
}

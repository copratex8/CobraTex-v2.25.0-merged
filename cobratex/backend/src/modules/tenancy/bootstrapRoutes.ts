import { Router } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { validatePassword } from '@/modules/identity/userAdminService';
import { login } from '@/modules/identity/identityService';
import { provisionTenant } from '@/modules/tenancy/provisioning';
import { config } from '@/config';

export const bootstrapRouter = Router();

const sameSecret = (a: string, b: string) => { const x = crypto.createHash('sha256').update(a).digest(), y = crypto.createHash('sha256').update(b).digest(); return crypto.timingSafeEqual(x, y); };
const bootstrapLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'محاولات كثيرة، حاول لاحقًا' } });

bootstrapRouter.post('/bootstrap', bootstrapLimiter, async (req, res, next) => {
  try {
    // بلا هذا الحد، أي زائر على الإنترنت يستطيع إنشاء مستأجرين/حسابات مالك بلا نهاية على قاعدة
    // البيانات المشتركة. مفعَّل تلقائيًا فقط عند ضبط BOOTSTRAP_SECRET (اختياري محليًا، إلزامي عمليًا
    // في أي بيئة منشورة — راجع دليل النشر).
    // الإنتاج بلا BOOTSTRAP_SECRET = إغلاق كامل (كان مفتوحًا للجميع). التطوير المحلي يبقى مفتوحًا.
    if (!config.bootstrapSecret && config.nodeEnv === 'production') {
      return res.status(503).json({ error: 'إنشاء المستأجرين مغلق: اضبط BOOTSTRAP_SECRET على الخادم' });
    }
    if (config.bootstrapSecret && !sameSecret(req.get('x-bootstrap-secret') ?? '', config.bootstrapSecret)) {
      return res.status(401).json({ error: 'غير مصرَّح بإنشاء مستأجر جديد' });
    }

    const {
      tenantName,
      companyLegalName,
      companyDisplayName,
      branchName,
      warehouseName,
      ownerFullName,
      ownerEmail,
      ownerPassword,
    } = req.body ?? {};

    if (!tenantName || !companyLegalName || !ownerEmail || !ownerPassword) {
      return res.status(422).json({ error: 'حقول الإعداد الأول ناقصة' });
    }

    validatePassword(ownerPassword);
    const ids = await provisionTenant({ tenantName, companyLegalName, companyDisplayName, branchName, warehouseName, ownerFullName, ownerEmail, ownerPassword });
    const owner = { id: ids.ownerUserId };
    const session = await login(ownerEmail, ownerPassword, ids.tenantId);

    res.status(201).json({ ...ids, ownerUserId: owner.id, accessToken: session.accessToken, refreshToken: session.refreshToken });
  } catch (err) {
    next(err);
  }
});

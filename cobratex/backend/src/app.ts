import path from 'path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from '@/config';
import rateLimit from 'express-rate-limit';
import { pool } from '@/db/pool';
import { authMiddleware } from '@/middleware/authMiddleware';
import { errorHandler } from '@/middleware/errorHandler';
import { bootstrapRouter } from '@/modules/tenancy/bootstrapRoutes';
import { companySettingsRouter } from '@/modules/tenancy/companySettingsRoutes';
import { authRouter } from '@/modules/identity/identityRoutes';
import { userAdminRouter } from '@/modules/identity/userAdminRoutes';
import { itemsRouter } from '@/modules/items/itemRoutes';
import { inventoryRouter } from '@/modules/inventory/stockRoutes';
import { accountingRouter } from '@/modules/accounting/accountingRoutes';
import { customerRouter } from '@/modules/sales/customerRoutes';
import { supplierRouter } from '@/modules/purchasing/supplierRoutes';
import { salesRouter } from '@/modules/sales/salesRoutes';
import { purchaseOrderRouter } from '@/modules/purchasing/purchaseOrderRoutes';
import { taxRouter } from '@/modules/accounting/taxRoutes';
import { treasuryRouter } from '@/modules/treasury/treasuryRoutes';
import { systemRouter } from '@/modules/system/systemRoutes';
import { notificationRouter } from '@/modules/notifications/notificationRoutes';
import { attachmentRouter } from '@/modules/system/attachmentRoutes';
import { realtimeRouter } from '@/modules/system/realtimeRoutes';
import { manufacturingRouter } from '@/modules/manufacturing/manufacturingRoutes';
import { textileRouter } from '@/modules/manufacturing/textileRoutes';
import { textileExtraRouter } from '@/modules/manufacturing/textileExtraRoutes';
import { textileMillRouter } from '@/modules/manufacturing/textileMillRoutes';
import { textileSubcontractRouter } from '@/modules/manufacturing/textileSubcontractRoutes';
import { textileOpsRouter } from '@/modules/manufacturing/textileOpsRoutes';
import { textileDeliveryRouter } from '@/modules/manufacturing/textileDeliveryRoutes';
import { textileUtilitiesRouter } from '@/modules/manufacturing/textileUtilitiesRoutes';
import { textileSimulatorRouter } from '@/modules/manufacturing/textileSimulatorRoutes';
import { textileHrRouter } from '@/modules/manufacturing/textileHrRoutes';
import { textileBlendRouter } from '@/modules/manufacturing/textileBlendRoutes';
import { textileTraceRouter } from '@/modules/manufacturing/textileTraceRoutes';
import { moduleGuard } from '@/modules/platform/activityModules';
import { activityRouter } from '@/modules/platform/activityRoutes';
import { fxRouter } from '@/modules/accounting/fxRoutes';
import { textileSalesLinkRouter } from '@/modules/manufacturing/textileSalesLinkRoutes';
import { textileAdvancedRouter } from '@/modules/manufacturing/textileAdvancedRoutes';
import { loadAllPlugins } from '@/plugins/loader';
import { backupRouter, backupCallbackRouter } from '@/modules/backup/backupRoutes';
import { platformRouter } from '@/modules/platform/platformRoutes';
import { platformGuard, licenseGuard } from '@/modules/platform/platformGuard';

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet());
  if (config.corsOrigins.length) {
    app.use(cors({ origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)) }));
  } else {
    if (config.nodeEnv === 'production') console.warn('[تحذير أمني] CORS_ORIGINS غير مضبوط: الخادم يقبل أي نطاق. اضبطه على نطاق الواجهة.');
    app.use(cors());
  }
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // فحص يصل إلى القاعدة (للمراقبة .github/workflows/uptime.yml): يكشف توقّف قاعدة العميل أو إيقافها لعدم النشاط، ويُبقيها نشطة.
  // لا يُرجع أي تفاصيل؛ محدود المعدّل لأنه عام.
  const dbHealthLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
  app.get('/health/db', dbHealthLimiter, async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'down' });
    }
  });

  // مستوى التحكم عن بُعد (لوحة المطور): حالة التشغيل العامة + أوامر المطوّر. يسبق كل المسارات ليُنفِّذ
  // زر الإيقاف على كل شيء ما عدا المسارات المستثناة داخل الحارس (/public /developer /system /bootstrap).
  app.use('/api', platformRouter);
  app.use('/api', platformGuard);
  app.use('/api', licenseGuard);

  // مسارات عامة (بلا مصادقة): الإعداد الأول وتسجيل الدخول ومعلومات النظام (إصدار/إضافات)
  app.use('/api', bootstrapRouter);
  app.use('/api', authRouter);
  app.use('/api', systemRouter);
  // النسخ الاحتياطي + Google Drive: رد OAuth عام (state موقَّع)، وباقي المسارات بصلاحية system.backup.manage (داخل الراوتر).
  app.use('/api/backup', backupCallbackRouter);
  app.use('/api/backup', backupRouter);

  // نظام الإضافات: يكتشف ويُحمِّل كل مجلد في plugins/ عند إقلاع كل تطبيق — راجع src/plugins/loader.ts
  const { router: pluginsRouter, loaded: loadedPlugins } = loadAllPlugins();
  app.set('loadedPlugins', loadedPlugins);

  // أصول الواجهة الأمامية للإضافات (ملفات JS خام لعناصر ويب) — عامة عمدًا (لا مصادقة)، فهي كود
  // ثابت يُقدَّم للمتصفح، تمامًا كأي حزمة JS عامة؛ الحماية الفعلية على البيانات، لا على الكود نفسه.
  app.use('/plugin-assets', express.static(path.resolve(process.cwd(), 'plugins')));

  // كل ما بعد هذا السطر يتطلب توكن صالح، ويحصل على req.ctx (RequestContext) مُشتقًا منه فقط
  // ملفات النشاط: حارس الوحدات يسبق كل الراوترات المقيَّدة، و/modules/me للواجهة.
  app.use('/api', moduleGuard);
  app.use('/api', authMiddleware, activityRouter);
  app.use('/api', authMiddleware, itemsRouter);
  app.use('/api', authMiddleware, inventoryRouter);
  app.use('/api', authMiddleware, accountingRouter);
  app.use('/api', authMiddleware, customerRouter);
  app.use('/api', authMiddleware, supplierRouter);
  app.use('/api', authMiddleware, salesRouter);
  app.use('/api', authMiddleware, purchaseOrderRouter);
  app.use('/api', authMiddleware, taxRouter);
  app.use('/api', authMiddleware, treasuryRouter);
  app.use('/api', authMiddleware, companySettingsRouter);
  app.use('/api', authMiddleware, pluginsRouter);
  app.use('/api', authMiddleware, notificationRouter);
  app.use('/api', authMiddleware, attachmentRouter);
  app.use('/api', authMiddleware, realtimeRouter);
  app.use('/api', authMiddleware, userAdminRouter);
  app.use('/api', authMiddleware, manufacturingRouter);
  app.use('/api', authMiddleware, textileRouter);
  app.use('/api', authMiddleware, textileExtraRouter);
  app.use('/api', authMiddleware, textileAdvancedRouter);
  app.use('/api', authMiddleware, textileMillRouter);
  app.use('/api', authMiddleware, textileSubcontractRouter);
  app.use('/api', authMiddleware, textileOpsRouter);
  app.use('/api', authMiddleware, textileDeliveryRouter);
  app.use('/api', authMiddleware, textileUtilitiesRouter);
  app.use('/api', authMiddleware, textileSimulatorRouter);
  app.use('/api', authMiddleware, textileHrRouter);
  app.use('/api', authMiddleware, textileBlendRouter);
  app.use('/api', authMiddleware, textileTraceRouter);
  app.use('/api', authMiddleware, fxRouter);
  app.use('/api', authMiddleware, textileSalesLinkRouter);

  app.use(errorHandler);
  return app;
}

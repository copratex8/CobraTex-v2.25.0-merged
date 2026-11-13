import { Router } from 'express';
import { publicSummary } from '@/modules/platform/licenseService';
import { getCompanyModules, MODULES, RULES, profileOf } from '@/modules/platform/activityModules';

/** للمستخدم المصادَق: وحدات شركته الفعّالة (تُخفي الواجهة ما لا يتاح). */
export const activityRouter = Router();
activityRouter.get('/modules/me', async (req, res, next) => {
  try { const m = await getCompanyModules(req.ctx.companyId); res.json({ profile: m.profile, profileName: profileOf(m.profile)?.name ?? m.profile, modules: m.modules, catalog: MODULES.map(({ key, name }) => ({ key, name })), rules: RULES }); } catch (e) { next(e); }
});

/** حالة ترخيص عميلي (لشريط التنبيه في الواجهة). */
activityRouter.get('/license/status', async (req, res, next) => { try { res.json(await publicSummary(req.ctx.tenantId)); } catch (e) { next(e); } });

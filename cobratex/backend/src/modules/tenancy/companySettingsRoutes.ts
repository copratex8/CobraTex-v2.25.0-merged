import { Router } from 'express';
import { updateFxGainLossAccount, updateManufacturingEnabled, getMyCompany, listBranches, createActivity, listActivities, updateActivityStatus } from '@/modules/tenancy/tenancyService';
import { validate } from '@/middleware/validate';
import { updateManufacturingEnabledBodySchema } from '@/shared/zodSchemas';

export const companySettingsRouter = Router();

companySettingsRouter.get('/company', async (req, res, next) => {
  try { res.status(200).json(await getMyCompany(req.ctx)); } catch (err) { next(err); }
});

companySettingsRouter.get('/branches', async (req, res, next) => {
  try { res.status(200).json(await listBranches(req.ctx)); } catch (err) { next(err); }
});

companySettingsRouter.post('/activities', async (req, res, next) => {
  try { res.status(201).json(await createActivity(req.ctx, req.body)); } catch (err) { next(err); }
});

companySettingsRouter.get('/activities', async (req, res, next) => {
  try { res.status(200).json(await listActivities(req.ctx)); } catch (err) { next(err); }
});

companySettingsRouter.patch('/activities/:id', async (req, res, next) => {
  try { res.status(200).json(await updateActivityStatus(req.ctx, String(req.params.id), req.body.isActive)); } catch (err) { next(err); }
});

companySettingsRouter.put('/company/settings/fx-gain-loss-account', async (req, res, next) => {
  try {
    res.status(200).json(await updateFxGainLossAccount(req.ctx, req.body.accountId));
  } catch (err) { next(err); }
});

companySettingsRouter.put('/company/settings/manufacturing-enabled', validate({ body: updateManufacturingEnabledBodySchema }), async (req, res, next) => {
  try { res.status(200).json(await updateManufacturingEnabled(req.ctx, req.body.enabled)); } catch (err) { next(err); }
});

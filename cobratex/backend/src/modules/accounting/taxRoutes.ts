import { Router } from 'express';
import { createTaxType, changeTaxRate, listTaxTypes } from '@/modules/accounting/taxService';

export const taxRouter = Router();

taxRouter.get('/accounting/tax-types', async (req, res, next) => {
  try { res.status(200).json(await listTaxTypes(req.ctx)); } catch (err) { next(err); }
});

taxRouter.post('/accounting/tax-types', async (req, res, next) => {
  try { res.status(201).json(await createTaxType(req.ctx, req.body)); } catch (err) { next(err); }
});

taxRouter.post('/accounting/tax-types/:id/change-rate', async (req, res, next) => {
  try {
    const { newRatePercent, effectiveFrom, ...options } = req.body ?? {};
    res.status(201).json(await changeTaxRate(req.ctx, req.params.id, newRatePercent, effectiveFrom, options));
  } catch (err) { next(err); }
});

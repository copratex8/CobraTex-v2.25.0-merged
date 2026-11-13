import { Router } from 'express';
import { idParamSchema } from '@/shared/zodSchemas';
import { validate } from '@/middleware/validate';
import * as svc from '@/modules/accounting/fxRatesService';

export const fxRouter = Router();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const h = (fn: (req: any) => Promise<unknown> | unknown, status = 200) => async (req: any, res: any, next: any) => { try { res.status(status).json(await fn(req)); } catch (e) { next(e); } };
fxRouter.get('/fx/currencies', h((r) => svc.listCurrencies(r.ctx)));
fxRouter.post('/fx/currencies', validate({ body: svc.currencyBodySchema }), h((r) => svc.upsertCurrency(r.ctx, r.body), 201));
fxRouter.get('/fx/rates', validate({ query: svc.ratesListSchema }), h((r) => svc.listRates(r.ctx, r.query)));
fxRouter.get('/fx/rate', validate({ query: svc.rateQuerySchema }), h((r) => svc.getRate(r.ctx, r.query)));
fxRouter.post('/fx/rates', validate({ body: svc.rateBodySchema }), h((r) => svc.setRate(r.ctx, r.body), 201));
fxRouter.post('/fx/rates/bulk', validate({ body: svc.bulkRatesSchema }), h((r) => svc.setRates(r.ctx, r.body), 201));
fxRouter.get('/fx/convert', validate({ query: svc.convertQuerySchema }), h((r) => svc.convert(r.ctx, r.query)));
fxRouter.get('/fx/revaluation', validate({ query: svc.revalQuerySchema }), h((r) => svc.revaluation(r.ctx, r.query)));
import * as post from '@/modules/accounting/fxRevalPosting';
fxRouter.get('/fx/accounts', h((r) => post.getAccounts(r.ctx)));
fxRouter.put('/fx/accounts', validate({ body: post.accountsSchema }), h((r) => post.setAccounts(r.ctx, r.body)));
fxRouter.get('/fx/revaluations', h((r) => post.listRevaluations(r.ctx)));
fxRouter.post('/fx/revaluations', validate({ body: post.postRevalSchema }), h((r) => post.postRevaluation(r.ctx, r.body), 201));
fxRouter.post('/fx/revaluations/:id/reverse', validate({ params: idParamSchema, body: post.reverseRevalSchema }), h((r) => post.reverseRevaluation(r.ctx, String(r.params.id), r.body)));

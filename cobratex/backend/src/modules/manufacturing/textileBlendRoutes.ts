import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { idParamSchema } from '@/shared/zodSchemas';
import * as svc from '@/modules/manufacturing/textileBlendService';

export const textileBlendRouter = Router();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const h = (fn: (req: any) => Promise<unknown> | unknown, status = 200) => async (req: any, res: any, next: any) => { try { res.status(status).json(await fn(req)); } catch (e) { next(e); } };
const id = (r: any) => String(r.params.id); // eslint-disable-line @typescript-eslint/no-explicit-any
textileBlendRouter.get('/textile/blend-recipes', validate({ query: svc.recipeQuerySchema }), h((r) => svc.listRecipes(r.ctx, r.query)));
textileBlendRouter.get('/textile/blend-recipes/resolve', validate({ query: svc.resolveQuerySchema }), h((r) => svc.resolve(r.ctx, r.query)));
textileBlendRouter.get('/textile/blend-recipes/report', validate({ query: svc.blendReportQuerySchema }), h((r) => svc.machineBlendReport(r.ctx, r.query)));
textileBlendRouter.post('/textile/blend-recipes', validate({ body: svc.recipeCreateSchema }), h((r) => svc.createRecipe(r.ctx, r.body), 201));
textileBlendRouter.get('/textile/blend-recipes/:id', validate({ params: idParamSchema }), h((r) => svc.getRecipe(r.ctx, id(r))));
textileBlendRouter.put('/textile/blend-recipes/:id', validate({ params: idParamSchema, body: svc.recipeUpdateSchema }), h((r) => svc.updateDraft(r.ctx, id(r), r.body)));
textileBlendRouter.delete('/textile/blend-recipes/:id', validate({ params: idParamSchema }), h((r) => svc.deleteDraft(r.ctx, id(r))));
textileBlendRouter.post('/textile/blend-recipes/:id/lock', validate({ params: idParamSchema }), h((r) => svc.lockRecipe(r.ctx, id(r))));
textileBlendRouter.post('/textile/blend-recipes/:id/new-version', validate({ params: idParamSchema, body: svc.newVersionSchema }), h((r) => svc.newVersion(r.ctx, id(r), r.body), 201));
textileBlendRouter.get('/textile/blend-recipes/:id/requirements', validate({ params: idParamSchema, query: svc.reqQuerySchema }), h((r) => svc.requirements(r.ctx, id(r), Number(r.query.quantity))));
textileBlendRouter.post('/textile/production-orders/:id/blend', validate({ params: idParamSchema, body: svc.attachSchema }), h((r) => svc.attachToOrder(r.ctx, id(r), r.body)));
textileBlendRouter.get('/textile/production-orders/:id/blend-variance', validate({ params: idParamSchema }), h((r) => svc.orderVariance(r.ctx, id(r))));
textileBlendRouter.post('/textile/blend-recipes/:id/generate-bom', validate({ params: idParamSchema, body: svc.genBomSchema }), h((r) => svc.generateBom(r.ctx, id(r), r.body), 201));
textileBlendRouter.get('/textile/blend-recipes/:id/cost', validate({ params: idParamSchema, query: svc.costQuerySchema }), h((r) => svc.recipeCost(r.ctx, id(r), r.query)));
textileBlendRouter.get('/textile/blend-recipes/item/:id/cost-comparison', validate({ params: idParamSchema, query: svc.costQuerySchema }), h((r) => svc.costComparison(r.ctx, id(r), r.query)));
textileBlendRouter.get('/textile/production-orders/:id/blend-availability', validate({ params: idParamSchema }), h((r) => svc.orderAvailability(r.ctx, id(r))));

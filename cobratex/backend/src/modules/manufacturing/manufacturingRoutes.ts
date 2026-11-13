import { Router } from 'express';
import { validate } from '@/middleware/validate';
import { idParamSchema, createBomBodySchema, createProductionOrderBodySchema, updateOperationCostsBodySchema, reverseDocumentBodySchema } from '@/shared/zodSchemas';
import { paginationQuerySchema, parsePagination } from '@/shared/pagination';
import { idempotencyMiddleware } from '@/middleware/idempotencyMiddleware';
import {
  createBom, listBoms, getBomById,
  createProductionOrder, updateOperationCosts, postProductionOrder, reverseProductionOrder, getProductionOrderById, listProductionOrders,
} from '@/modules/manufacturing/manufacturingService';

export const manufacturingRouter = Router();

/* ============================== قائمة المواد (BOM) ============================== */

manufacturingRouter.post('/manufacturing/boms', validate({ body: createBomBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(201).json(await createBom(req.ctx, req.body)); } catch (err) { next(err); }
});

manufacturingRouter.get('/manufacturing/boms', async (req, res, next) => {
  try { res.status(200).json(await listBoms(req.ctx)); } catch (err) { next(err); }
});

manufacturingRouter.get('/manufacturing/boms/:id', validate({ params: idParamSchema }), async (req, res, next) => {
  try { res.status(200).json(await getBomById(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});

/* ============================== أوامر التصنيع (Production Orders) ============================== */

manufacturingRouter.post('/manufacturing/orders', validate({ body: createProductionOrderBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(201).json(await createProductionOrder(req.ctx, req.body)); } catch (err) { next(err); }
});

manufacturingRouter.get('/manufacturing/orders', validate({ query: paginationQuerySchema }), async (req, res, next) => {
  try {
    const { page, pageSize, status } = parsePagination(req.query as Record<string, unknown>);
    res.status(200).json(await listProductionOrders(req.ctx, page, pageSize, status));
  } catch (err) { next(err); }
});

manufacturingRouter.get('/manufacturing/orders/:id', validate({ params: idParamSchema }), async (req, res, next) => {
  try { res.status(200).json(await getProductionOrderById(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});

manufacturingRouter.post('/manufacturing/orders/:id/post', validate({ params: idParamSchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(200).json(await postProductionOrder(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});

manufacturingRouter.post('/manufacturing/orders/:id/reverse', validate({ params: idParamSchema, body: reverseDocumentBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(200).json(await reverseProductionOrder(req.ctx, String(req.params.id), req.body.reason)); } catch (err) { next(err); }
});

manufacturingRouter.put('/manufacturing/orders/:id/operations', validate({ params: idParamSchema, body: updateOperationCostsBodySchema }), async (req, res, next) => {
  try { res.status(200).json(await updateOperationCosts(req.ctx, String(req.params.id), req.body.operations)); } catch (err) { next(err); }
});

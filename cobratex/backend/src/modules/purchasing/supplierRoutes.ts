import { Router } from 'express';
import { idempotencyMiddleware } from '@/middleware/idempotencyMiddleware';
import { createSupplier, getSupplierById, listSuppliers, getSupplierStatement, updateSupplierStatus } from '@/modules/purchasing/supplierService';
import { validate } from '@/middleware/validate';
import { idParamSchema, createSupplierBodySchema, toggleActiveBodySchema } from '@/shared/zodSchemas';
import { paginationQuerySchema, parsePagination } from '@/shared/pagination';

export const supplierRouter = Router();

supplierRouter.post('/suppliers', validate({ body: createSupplierBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try {
    res.status(201).json(await createSupplier(req.ctx, req.body));
  } catch (err) {
    next(err);
  }
});

supplierRouter.get('/suppliers', validate({ query: paginationQuerySchema }), async (req, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req.query as Record<string, unknown>);
    res.status(200).json(await listSuppliers(req.ctx, page, pageSize));
  } catch (err) {
    next(err);
  }
});

supplierRouter.get('/suppliers/:id', validate({ params: idParamSchema }), async (req, res, next) => {
  try {
    res.status(200).json(await getSupplierById(req.ctx, String(req.params.id)));
  } catch (err) {
    next(err);
  }
});

supplierRouter.patch('/suppliers/:id', validate({ params: idParamSchema, body: toggleActiveBodySchema }), async (req, res, next) => {
  try {
    res.status(200).json(await updateSupplierStatus(req.ctx, String(req.params.id), req.body.isActive));
  } catch (err) {
    next(err);
  }
});

supplierRouter.get('/suppliers/:id/statement', validate({ params: idParamSchema }), async (req, res, next) => {
  try {
    const { fromDate, toDate } = req.query as Record<string, string | undefined>;
    res.status(200).json(await getSupplierStatement(req.ctx, String(req.params.id), { fromDate, toDate }));
  } catch (err) { next(err); }
});

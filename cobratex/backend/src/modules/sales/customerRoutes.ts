import { Router } from 'express';
import { idempotencyMiddleware } from '@/middleware/idempotencyMiddleware';
import { validate } from '@/middleware/validate';
import { idParamSchema, createCustomerBodySchema, toggleActiveBodySchema } from '@/shared/zodSchemas';
import { paginationQuerySchema, parsePagination } from '@/shared/pagination';
import { createCustomer, getCustomerById, listCustomers, getCustomerStatement, updateCustomerStatus } from '@/modules/sales/customerService';

export const customerRouter = Router();

customerRouter.post('/customers', validate({ body: createCustomerBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try {
    res.status(201).json(await createCustomer(req.ctx, req.body));
  } catch (err) {
    next(err);
  }
});

customerRouter.get('/customers', validate({ query: paginationQuerySchema }), async (req, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req.query as Record<string, unknown>);
    res.status(200).json(await listCustomers(req.ctx, page, pageSize));
  } catch (err) {
    next(err);
  }
});

customerRouter.get('/customers/:id/statement', validate({ params: idParamSchema }), async (req, res, next) => {
  try {
    const { fromDate, toDate } = req.query as Record<string, string | undefined>;
    res.status(200).json(await getCustomerStatement(req.ctx, String(req.params.id), { fromDate, toDate }));
  } catch (err) { next(err); }
});

customerRouter.get('/customers/:id', validate({ params: idParamSchema }), async (req, res, next) => {
  try {
    res.status(200).json(await getCustomerById(req.ctx, String(req.params.id)));
  } catch (err) {
    next(err);
  }
});

customerRouter.patch('/customers/:id', validate({ params: idParamSchema, body: toggleActiveBodySchema }), async (req, res, next) => {
  try {
    res.status(200).json(await updateCustomerStatus(req.ctx, String(req.params.id), req.body.isActive));
  } catch (err) {
    next(err);
  }
});

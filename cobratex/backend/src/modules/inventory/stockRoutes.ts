import { Router } from 'express';
import { idempotencyMiddleware } from '@/middleware/idempotencyMiddleware';
import { validate } from '@/middleware/validate';
import { stockBalanceQuerySchema, createStocktakeBodySchema, reverseDocumentBodySchema, idParamSchema } from '@/shared/zodSchemas';
import { paginationQuerySchema, parsePagination } from '@/shared/pagination';
import {
  recordInMovement,
  recordOutMovement,
  getStockBalance,
  rebuildStockBalanceFromLedger,
} from '@/modules/inventory/stockService';
import { createWarehouse, listWarehouses } from '@/modules/inventory/warehouseService';
import { getInventoryValuationReport, inventoryValuationQuerySchema } from '@/modules/accounting/reportingService';
import { createStocktake, postStocktake, reverseStocktake, getStocktakeById, listStocktakes } from '@/modules/inventory/stocktakeService';

export const inventoryRouter = Router();

inventoryRouter.post('/inventory/movements/in', idempotencyMiddleware(), async (req, res, next) => {
  try {
    const result = await recordInMovement(req.ctx, req.body);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

inventoryRouter.post('/inventory/movements/out', idempotencyMiddleware(), async (req, res, next) => {
  try {
    const result = await recordOutMovement(req.ctx, req.body);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

inventoryRouter.get('/inventory/balance', validate({ query: stockBalanceQuerySchema }), async (req, res, next) => {
  try {
    const { warehouseId, itemId, batchId } = req.query as Record<string, string | undefined>;
    const balance = await getStockBalance(req.ctx, warehouseId!, itemId!, batchId ?? null);
    res.json(balance);
  } catch (err) {
    next(err);
  }
});

inventoryRouter.post('/inventory/balance/rebuild', async (req, res, next) => {
  try {
    const { warehouseId, itemId, batchId } = req.body ?? {};
    const rebuilt = await rebuildStockBalanceFromLedger(req.ctx, warehouseId, itemId, batchId ?? null);
    res.json(rebuilt);
  } catch (err) {
    next(err);
  }
});

inventoryRouter.get('/inventory/reports/valuation', validate({ query: inventoryValuationQuerySchema }), async (req, res, next) => {
  try {
    const { warehouseId, onlyWithStock } = inventoryValuationQuerySchema.parse(req.query);
    res.status(200).json(await getInventoryValuationReport(req.ctx, warehouseId, onlyWithStock));
  } catch (err) { next(err); }
});

inventoryRouter.post('/warehouses', idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(201).json(await createWarehouse(req.ctx, req.body)); } catch (err) { next(err); }
});

inventoryRouter.get('/warehouses', async (req, res, next) => {
  try { res.status(200).json(await listWarehouses(req.ctx)); } catch (err) { next(err); }
});

/**
 * راجع تعليق stocktakeLineBodySchema في zodSchemas.ts — الخدمة كاملة، هذه أول مسارات HTTP لها.
 */
inventoryRouter.post('/inventory/stocktakes', validate({ body: createStocktakeBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(201).json(await createStocktake(req.ctx, req.body)); } catch (err) { next(err); }
});

inventoryRouter.get('/inventory/stocktakes', validate({ query: paginationQuerySchema }), async (req, res, next) => {
  try {
    const { page, pageSize, status } = parsePagination(req.query as Record<string, unknown>);
    res.status(200).json(await listStocktakes(req.ctx, page, pageSize, status));
  } catch (err) { next(err); }
});

inventoryRouter.get('/inventory/stocktakes/:id', validate({ params: idParamSchema }), async (req, res, next) => {
  try { res.status(200).json(await getStocktakeById(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});

inventoryRouter.post('/inventory/stocktakes/:id/post', validate({ params: idParamSchema }), async (req, res, next) => {
  try { res.status(200).json(await postStocktake(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});

inventoryRouter.post('/inventory/stocktakes/:id/reverse', validate({ params: idParamSchema, body: reverseDocumentBodySchema }), async (req, res, next) => {
  try { res.status(200).json(await reverseStocktake(req.ctx, String(req.params.id), req.body.reason)); } catch (err) { next(err); }
});

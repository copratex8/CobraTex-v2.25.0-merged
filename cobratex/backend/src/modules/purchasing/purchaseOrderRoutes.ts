import { Router } from 'express';
import { idempotencyMiddleware } from '@/middleware/idempotencyMiddleware';
import { createPurchaseOrder, transitionPurchaseOrderStatus, getPurchaseOrderById, listPurchaseOrders} from '@/modules/purchasing/purchaseOrderService';
import { createGoodsReceipt, postGoodsReceipt, getGoodsReceiptById, listGoodsReceipts} from '@/modules/purchasing/goodsReceiptService';
import {
  createSupplierInvoice, postSupplierInvoice, reverseSupplierInvoice, getSupplierInvoiceById, listSupplierInvoices} from '@/modules/purchasing/supplierInvoiceService';
import {
  createSupplierPayment, postSupplierPayment, reverseSupplierPayment, getSupplierPaymentById, getSupplierInvoiceRemainingBalance,
  allocateAdvancePayment, listSupplierPayments} from '@/modules/purchasing/supplierPaymentService';
import {
  createPurchaseReturn, postPurchaseReturn, reversePurchaseReturn, getPurchaseReturnById, listPurchaseReturns} from '@/modules/purchasing/purchaseReturnService';
import {
  createExpenseInvoice, postExpenseInvoice, reverseExpenseInvoice, getExpenseInvoiceById, listExpenseInvoices} from '@/modules/purchasing/expenseInvoiceService';
import { validate } from '@/middleware/validate';
import { idParamSchema, createSupplierInvoiceBodySchema, createSupplierPaymentBodySchema, allocateSupplierAdvanceBodySchema, createPurchaseReturnBodySchema, createExpenseInvoiceBodySchema, reverseDocumentBodySchema, createPurchaseOrderBodySchema, createGoodsReceiptBodySchema, transitionStatusBodySchema } from '@/shared/zodSchemas';
import { paginationQuerySchema, parsePagination } from '@/shared/pagination';
import { getPurchaseSummaryReport, purchaseSummaryQuerySchema } from '@/modules/accounting/reportingService';

export const purchaseOrderRouter = Router();

purchaseOrderRouter.post('/purchasing/orders', validate({ body: createPurchaseOrderBodySchema }), async (req, res, next) => {
  try { res.status(201).json(await createPurchaseOrder(req.ctx, req.body)); } catch (err) { next(err); }
});
purchaseOrderRouter.get('/purchasing/orders/:id', validate({ params: idParamSchema }), async (req, res, next) => {
  try { res.status(200).json(await getPurchaseOrderById(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
purchaseOrderRouter.post('/purchasing/orders/:id/transition', validate({ params: idParamSchema, body: transitionStatusBodySchema }), async (req, res, next) => {
  try { res.status(200).json(await transitionPurchaseOrderStatus(req.ctx, String(req.params.id), req.body.target)); } catch (err) { next(err); }
});

purchaseOrderRouter.post('/purchasing/receipts', validate({ body: createGoodsReceiptBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(201).json(await createGoodsReceipt(req.ctx, req.body)); } catch (err) { next(err); }
});
purchaseOrderRouter.get('/purchasing/receipts/:id', validate({ params: idParamSchema }), async (req, res, next) => {
  try { res.status(200).json(await getGoodsReceiptById(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
purchaseOrderRouter.post('/purchasing/receipts/:id/post', idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(200).json(await postGoodsReceipt(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});

purchaseOrderRouter.post('/purchasing/invoices', validate({ body: createSupplierInvoiceBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(201).json(await createSupplierInvoice(req.ctx, req.body)); } catch (err) { next(err); }
});
purchaseOrderRouter.get('/purchasing/invoices/:id', validate({ params: idParamSchema }), async (req, res, next) => {
  try { res.status(200).json(await getSupplierInvoiceById(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
purchaseOrderRouter.post('/purchasing/invoices/:id/post', idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(200).json(await postSupplierInvoice(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
purchaseOrderRouter.post('/purchasing/invoices/:id/reverse', validate({ params: idParamSchema, body: reverseDocumentBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(200).json(await reverseSupplierInvoice(req.ctx, String(req.params.id), req.body.reason)); } catch (err) { next(err); }
});

purchaseOrderRouter.post('/purchasing/payments', validate({ body: createSupplierPaymentBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(201).json(await createSupplierPayment(req.ctx, req.body)); } catch (err) { next(err); }
});
purchaseOrderRouter.get('/purchasing/payments/:id', validate({ params: idParamSchema }), async (req, res, next) => {
  try { res.status(200).json(await getSupplierPaymentById(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
purchaseOrderRouter.post('/purchasing/payments/:id/post', idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(200).json(await postSupplierPayment(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
purchaseOrderRouter.post('/purchasing/payments/:id/reverse', validate({ params: idParamSchema, body: reverseDocumentBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(200).json(await reverseSupplierPayment(req.ctx, String(req.params.id), req.body.reason)); } catch (err) { next(err); }
});
purchaseOrderRouter.get('/purchasing/invoices/:id/remaining-balance', validate({ params: idParamSchema }), async (req, res, next) => {
  try { res.status(200).json(await getSupplierInvoiceRemainingBalance(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
purchaseOrderRouter.post('/purchasing/payments/:id/allocate', validate({ params: idParamSchema, body: allocateSupplierAdvanceBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(200).json(await allocateAdvancePayment(req.ctx, String(req.params.id), req.body.allocations)); } catch (err) { next(err); }
});

purchaseOrderRouter.post('/purchasing/expense-invoices', validate({ body: createExpenseInvoiceBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(201).json(await createExpenseInvoice(req.ctx, req.body)); } catch (err) { next(err); }
});
purchaseOrderRouter.get('/purchasing/expense-invoices/:id', validate({ params: idParamSchema }), async (req, res, next) => {
  try { res.status(200).json(await getExpenseInvoiceById(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
purchaseOrderRouter.post('/purchasing/expense-invoices/:id/post', idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(200).json(await postExpenseInvoice(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
purchaseOrderRouter.post('/purchasing/expense-invoices/:id/reverse', validate({ params: idParamSchema, body: reverseDocumentBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(200).json(await reverseExpenseInvoice(req.ctx, String(req.params.id), req.body.reason)); } catch (err) { next(err); }
});

purchaseOrderRouter.post('/purchasing/returns', validate({ body: createPurchaseReturnBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(201).json(await createPurchaseReturn(req.ctx, req.body)); } catch (err) { next(err); }
});
purchaseOrderRouter.get('/purchasing/returns/:id', validate({ params: idParamSchema }), async (req, res, next) => {
  try { res.status(200).json(await getPurchaseReturnById(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
purchaseOrderRouter.post('/purchasing/returns/:id/post', idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(200).json(await postPurchaseReturn(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
purchaseOrderRouter.post('/purchasing/returns/:id/reverse', validate({ params: idParamSchema, body: reverseDocumentBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(200).json(await reversePurchaseReturn(req.ctx, String(req.params.id), req.body.reason)); } catch (err) { next(err); }
});

purchaseOrderRouter.get('/purchasing/orders', validate({ query: paginationQuerySchema }), async (req, res, next) => {
  try {
    const { page, pageSize, status } = parsePagination(req.query as Record<string, unknown>);
    res.status(200).json(await listPurchaseOrders(req.ctx, page, pageSize, status));
  } catch (err) { next(err); }
});

purchaseOrderRouter.get('/purchasing/receipts', validate({ query: paginationQuerySchema }), async (req, res, next) => {
  try {
    const { page, pageSize, status } = parsePagination(req.query as Record<string, unknown>);
    res.status(200).json(await listGoodsReceipts(req.ctx, page, pageSize, status));
  } catch (err) { next(err); }
});

purchaseOrderRouter.get('/purchasing/invoices', validate({ query: paginationQuerySchema }), async (req, res, next) => {
  try {
    const { page, pageSize, status, supplierId } = parsePagination(req.query as Record<string, unknown>);
    res.status(200).json(await listSupplierInvoices(req.ctx, page, pageSize, status, supplierId));
  } catch (err) { next(err); }
});

purchaseOrderRouter.get('/purchasing/returns', validate({ query: paginationQuerySchema }), async (req, res, next) => {
  try {
    const { page, pageSize, status } = parsePagination(req.query as Record<string, unknown>);
    res.status(200).json(await listPurchaseReturns(req.ctx, page, pageSize, status));
  } catch (err) { next(err); }
});

purchaseOrderRouter.get('/purchasing/payments', validate({ query: paginationQuerySchema }), async (req, res, next) => {
  try {
    const { page, pageSize, status } = parsePagination(req.query as Record<string, unknown>);
    res.status(200).json(await listSupplierPayments(req.ctx, page, pageSize, status));
  } catch (err) { next(err); }
});

purchaseOrderRouter.get('/purchasing/expense-invoices', validate({ query: paginationQuerySchema }), async (req, res, next) => {
  try {
    const { page, pageSize, status } = parsePagination(req.query as Record<string, unknown>);
    res.status(200).json(await listExpenseInvoices(req.ctx, page, pageSize, status));
  } catch (err) { next(err); }
});

purchaseOrderRouter.get('/purchasing/reports/summary', validate({ query: purchaseSummaryQuerySchema }), async (req, res, next) => {
  try {
    const { fromDate, toDate, groupBy } = purchaseSummaryQuerySchema.parse(req.query);
    res.status(200).json(await getPurchaseSummaryReport(req.ctx, fromDate, toDate, groupBy));
  } catch (err) { next(err); }
});

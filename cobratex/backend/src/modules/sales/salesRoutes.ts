import { Router } from 'express';
import { idempotencyMiddleware } from '@/middleware/idempotencyMiddleware';
import { createPriceList, addPriceListLine, resolveUnitPrice } from '@/modules/sales/priceListService';
import { createQuotation, transitionQuotationStatus, getQuotationById, listQuotations} from '@/modules/sales/quotationService';
import { createSalesOrder, transitionSalesOrderStatus, getSalesOrderById, listSalesOrders} from '@/modules/sales/salesOrderService';
import {
  createSalesInvoice, postSalesInvoice, cancelDraftSalesInvoice, reverseSalesInvoice, getSalesInvoiceById, listSalesInvoices} from '@/modules/sales/salesInvoiceService';
import {
  createCustomerPayment, postCustomerPayment, reverseCustomerPayment, getCustomerPaymentById, getSalesInvoiceRemainingBalance,
  allocateAdvancePayment, listCustomerPayments} from '@/modules/sales/customerPaymentService';
import {
  createSalesReturn, postSalesReturn, reverseSalesReturn, getSalesReturnById, listSalesReturns} from '@/modules/sales/salesReturnService';
import { getSalesSummaryReport, salesSummaryQuerySchema } from '@/modules/accounting/reportingService';
import { validate } from '@/middleware/validate';
import { idParamSchema, createSalesInvoiceBodySchema, createCustomerPaymentBodySchema, allocateCustomerAdvanceBodySchema, createSalesReturnBodySchema, reverseDocumentBodySchema, createQuotationBodySchema, createSalesOrderBodySchema, transitionStatusBodySchema } from '@/shared/zodSchemas';
import { paginationQuerySchema, parsePagination } from '@/shared/pagination';

export const salesRouter = Router();

salesRouter.post('/sales/price-lists', async (req, res, next) => {
  try { res.status(201).json(await createPriceList(req.ctx, req.body)); } catch (err) { next(err); }
});
salesRouter.post('/sales/price-lists/lines', async (req, res, next) => {
  try { res.status(201).json(await addPriceListLine(req.ctx, req.body)); } catch (err) { next(err); }
});
salesRouter.post('/sales/price-lookup', async (req, res, next) => {
  try { res.status(200).json(await resolveUnitPrice(req.ctx, req.body)); } catch (err) { next(err); }
});

salesRouter.post('/sales/quotations', validate({ body: createQuotationBodySchema }), async (req, res, next) => {
  try { res.status(201).json(await createQuotation(req.ctx, req.body)); } catch (err) { next(err); }
});
salesRouter.get('/sales/quotations/:id', validate({ params: idParamSchema }), async (req, res, next) => {
  try { res.status(200).json(await getQuotationById(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
salesRouter.post('/sales/quotations/:id/transition', validate({ params: idParamSchema, body: transitionStatusBodySchema }), async (req, res, next) => {
  try { res.status(200).json(await transitionQuotationStatus(req.ctx, String(req.params.id), req.body.target)); } catch (err) { next(err); }
});

salesRouter.post('/sales/orders', validate({ body: createSalesOrderBodySchema }), async (req, res, next) => {
  try { res.status(201).json(await createSalesOrder(req.ctx, req.body)); } catch (err) { next(err); }
});
salesRouter.get('/sales/orders/:id', validate({ params: idParamSchema }), async (req, res, next) => {
  try { res.status(200).json(await getSalesOrderById(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
salesRouter.post('/sales/orders/:id/transition', validate({ params: idParamSchema, body: transitionStatusBodySchema }), async (req, res, next) => {
  try { res.status(200).json(await transitionSalesOrderStatus(req.ctx, String(req.params.id), req.body.target)); } catch (err) { next(err); }
});

salesRouter.post('/sales/invoices', validate({ body: createSalesInvoiceBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(201).json(await createSalesInvoice(req.ctx, req.body)); } catch (err) { next(err); }
});
salesRouter.get('/sales/invoices/:id', validate({ params: idParamSchema }), async (req, res, next) => {
  try { res.status(200).json(await getSalesInvoiceById(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
salesRouter.post('/sales/invoices/:id/post', idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(200).json(await postSalesInvoice(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
salesRouter.post('/sales/invoices/:id/cancel', validate({ params: idParamSchema, body: reverseDocumentBodySchema }), async (req, res, next) => {
  try { res.status(200).json(await cancelDraftSalesInvoice(req.ctx, String(req.params.id), req.body.reason)); } catch (err) { next(err); }
});
salesRouter.post('/sales/invoices/:id/reverse', validate({ params: idParamSchema, body: reverseDocumentBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(200).json(await reverseSalesInvoice(req.ctx, String(req.params.id), req.body.reason)); } catch (err) { next(err); }
});

salesRouter.post('/sales/payments', validate({ body: createCustomerPaymentBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(201).json(await createCustomerPayment(req.ctx, req.body)); } catch (err) { next(err); }
});
salesRouter.get('/sales/payments/:id', validate({ params: idParamSchema }), async (req, res, next) => {
  try { res.status(200).json(await getCustomerPaymentById(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
salesRouter.post('/sales/payments/:id/post', idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(200).json(await postCustomerPayment(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
salesRouter.post('/sales/payments/:id/reverse', validate({ params: idParamSchema, body: reverseDocumentBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(200).json(await reverseCustomerPayment(req.ctx, String(req.params.id), req.body.reason)); } catch (err) { next(err); }
});
salesRouter.get('/sales/invoices/:id/remaining-balance', validate({ params: idParamSchema }), async (req, res, next) => {
  try { res.status(200).json(await getSalesInvoiceRemainingBalance(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
salesRouter.post('/sales/payments/:id/allocate', validate({ params: idParamSchema, body: allocateCustomerAdvanceBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(200).json(await allocateAdvancePayment(req.ctx, String(req.params.id), req.body.allocations)); } catch (err) { next(err); }
});

salesRouter.post('/sales/returns', validate({ body: createSalesReturnBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(201).json(await createSalesReturn(req.ctx, req.body)); } catch (err) { next(err); }
});
salesRouter.get('/sales/returns/:id', validate({ params: idParamSchema }), async (req, res, next) => {
  try { res.status(200).json(await getSalesReturnById(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
salesRouter.post('/sales/returns/:id/post', idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(200).json(await postSalesReturn(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
salesRouter.post('/sales/returns/:id/reverse', validate({ params: idParamSchema, body: reverseDocumentBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(200).json(await reverseSalesReturn(req.ctx, String(req.params.id), req.body.reason)); } catch (err) { next(err); }
});

salesRouter.get('/sales/quotations', validate({ query: paginationQuerySchema }), async (req, res, next) => {
  try {
    const { page, pageSize, status } = parsePagination(req.query as Record<string, unknown>);
    res.status(200).json(await listQuotations(req.ctx, page, pageSize, status));
  } catch (err) { next(err); }
});

salesRouter.get('/sales/orders', validate({ query: paginationQuerySchema }), async (req, res, next) => {
  try {
    const { page, pageSize, status } = parsePagination(req.query as Record<string, unknown>);
    res.status(200).json(await listSalesOrders(req.ctx, page, pageSize, status));
  } catch (err) { next(err); }
});

salesRouter.get('/sales/invoices', validate({ query: paginationQuerySchema }), async (req, res, next) => {
  try {
    const { page, pageSize, status, customerId } = parsePagination(req.query as Record<string, unknown>);
    res.status(200).json(await listSalesInvoices(req.ctx, page, pageSize, status, customerId));
  } catch (err) { next(err); }
});

salesRouter.get('/sales/returns', validate({ query: paginationQuerySchema }), async (req, res, next) => {
  try {
    const { page, pageSize, status } = parsePagination(req.query as Record<string, unknown>);
    res.status(200).json(await listSalesReturns(req.ctx, page, pageSize, status));
  } catch (err) { next(err); }
});

salesRouter.get('/sales/payments', validate({ query: paginationQuerySchema }), async (req, res, next) => {
  try {
    const { page, pageSize, status } = parsePagination(req.query as Record<string, unknown>);
    res.status(200).json(await listCustomerPayments(req.ctx, page, pageSize, status));
  } catch (err) { next(err); }
});

salesRouter.get('/sales/reports/summary', validate({ query: salesSummaryQuerySchema }), async (req, res, next) => {
  try {
    const { fromDate, toDate, groupBy } = salesSummaryQuerySchema.parse(req.query);
    res.status(200).json(await getSalesSummaryReport(req.ctx, fromDate, toDate, groupBy));
  } catch (err) { next(err); }
});

import { Router } from 'express';
import { idempotencyMiddleware } from '@/middleware/idempotencyMiddleware';
import { validate } from '@/middleware/validate';
import { idParamSchema, createSafeOrBankBodySchema, createTreasuryTransactionBodySchema, createTreasuryTransferBodySchema, registerCheckBodySchema, transitionCheckBodySchema, reverseDocumentBodySchema, createReconciliationBodySchema, matchLineBodySchema } from '@/shared/zodSchemas';
import { createSafeOrBank, getSafeOrBankById, listSafeOrBanks } from '@/modules/treasury/safeOrBankService';
import {
  createTreasuryTransaction, postTreasuryTransaction, reverseTreasuryTransaction, getTreasuryTransactionById, listTreasuryTransactions} from '@/modules/treasury/treasuryTransactionService';
import {
  createTreasuryTransfer, postTreasuryTransfer, reverseTreasuryTransfer, getTreasuryTransferById, listTreasuryTransfers} from '@/modules/treasury/treasuryTransferService';
import { registerCheck, transitionCheckStatus, getCheckById, listChecks} from '@/modules/treasury/checkService';
import {
  createReconciliation, runAutoMatch, matchLine, unmatchLine, completeReconciliation, getReconciliationById, listReconciliations,
} from '@/modules/treasury/bankReconciliationService';
import { paginationQuerySchema, parsePagination } from '@/shared/pagination';

export const treasuryRouter = Router();

treasuryRouter.post('/treasury/safes', validate({ body: createSafeOrBankBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(201).json(await createSafeOrBank(req.ctx, req.body)); } catch (err) { next(err); }
});
treasuryRouter.get('/treasury/safes', validate({ query: paginationQuerySchema }), async (req, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req.query as Record<string, unknown>);
    res.status(200).json(await listSafeOrBanks(req.ctx, page, pageSize));
  } catch (err) { next(err); }
});
treasuryRouter.get('/treasury/safes/:id', validate({ params: idParamSchema }), async (req, res, next) => {
  try { res.status(200).json(await getSafeOrBankById(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});

treasuryRouter.post('/treasury/transactions', validate({ body: createTreasuryTransactionBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(201).json(await createTreasuryTransaction(req.ctx, req.body)); } catch (err) { next(err); }
});
treasuryRouter.get('/treasury/transactions/:id', validate({ params: idParamSchema }), async (req, res, next) => {
  try { res.status(200).json(await getTreasuryTransactionById(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
treasuryRouter.post('/treasury/transactions/:id/post', validate({ params: idParamSchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(200).json(await postTreasuryTransaction(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
treasuryRouter.post('/treasury/transactions/:id/reverse', validate({ params: idParamSchema, body: reverseDocumentBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(200).json(await reverseTreasuryTransaction(req.ctx, String(req.params.id), req.body.reason)); } catch (err) { next(err); }
});

treasuryRouter.post('/treasury/transfers', validate({ body: createTreasuryTransferBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(201).json(await createTreasuryTransfer(req.ctx, req.body)); } catch (err) { next(err); }
});
treasuryRouter.get('/treasury/transfers/:id', validate({ params: idParamSchema }), async (req, res, next) => {
  try { res.status(200).json(await getTreasuryTransferById(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
treasuryRouter.post('/treasury/transfers/:id/post', validate({ params: idParamSchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(200).json(await postTreasuryTransfer(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
treasuryRouter.post('/treasury/transfers/:id/reverse', validate({ params: idParamSchema, body: reverseDocumentBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(200).json(await reverseTreasuryTransfer(req.ctx, String(req.params.id), req.body.reason)); } catch (err) { next(err); }
});

treasuryRouter.post('/treasury/checks', validate({ body: registerCheckBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(201).json(await registerCheck(req.ctx, req.body)); } catch (err) { next(err); }
});
treasuryRouter.get('/treasury/checks/:id', validate({ params: idParamSchema }), async (req, res, next) => {
  try { res.status(200).json(await getCheckById(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
treasuryRouter.post('/treasury/checks/:id/transition', validate({ params: idParamSchema, body: transitionCheckBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try {
    const { target, ...options } = req.body ?? {};
    res.status(200).json(await transitionCheckStatus(req.ctx, String(req.params.id), target, options));
  } catch (err) { next(err); }
});

treasuryRouter.get('/treasury/transactions', validate({ query: paginationQuerySchema }), async (req, res, next) => {
  try {
    const { page, pageSize, status } = parsePagination(req.query as Record<string, unknown>);
    res.status(200).json(await listTreasuryTransactions(req.ctx, page, pageSize, status));
  } catch (err) { next(err); }
});

treasuryRouter.get('/treasury/transfers', validate({ query: paginationQuerySchema }), async (req, res, next) => {
  try {
    const { page, pageSize, status } = parsePagination(req.query as Record<string, unknown>);
    res.status(200).json(await listTreasuryTransfers(req.ctx, page, pageSize, status));
  } catch (err) { next(err); }
});

treasuryRouter.get('/treasury/checks', validate({ query: paginationQuerySchema }), async (req, res, next) => {
  try {
    const { page, pageSize, status } = parsePagination(req.query as Record<string, unknown>);
    res.status(200).json(await listChecks(req.ctx, page, pageSize, status));
  } catch (err) { next(err); }
});

/* ============================== التسوية البنكية ============================== */

treasuryRouter.post('/treasury/reconciliations', validate({ body: createReconciliationBodySchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(201).json(await createReconciliation(req.ctx, req.body)); } catch (err) { next(err); }
});
treasuryRouter.get('/treasury/reconciliations', validate({ query: paginationQuerySchema }), async (req, res, next) => {
  try {
    const { page, pageSize, status } = parsePagination(req.query as Record<string, unknown>);
    res.status(200).json(await listReconciliations(req.ctx, page, pageSize, status));
  } catch (err) { next(err); }
});
treasuryRouter.get('/treasury/reconciliations/:id', validate({ params: idParamSchema }), async (req, res, next) => {
  try { res.status(200).json(await getReconciliationById(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
treasuryRouter.post('/treasury/reconciliations/:id/auto-match', validate({ params: idParamSchema }), async (req, res, next) => {
  try { res.status(200).json(await runAutoMatch(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});
treasuryRouter.post('/treasury/reconciliations/:id/lines/:lineId/match', validate({ body: matchLineBodySchema }), async (req, res, next) => {
  try { res.status(200).json(await matchLine(req.ctx, String(req.params.id), String(req.params.lineId), req.body)); } catch (err) { next(err); }
});
treasuryRouter.post('/treasury/reconciliations/:id/lines/:lineId/unmatch', async (req, res, next) => {
  try { res.status(200).json(await unmatchLine(req.ctx, String(req.params.id), String(req.params.lineId))); } catch (err) { next(err); }
});
treasuryRouter.post('/treasury/reconciliations/:id/complete', validate({ params: idParamSchema }), idempotencyMiddleware(), async (req, res, next) => {
  try { res.status(200).json(await completeReconciliation(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});

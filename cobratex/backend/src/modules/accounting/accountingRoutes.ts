import { requirePermission } from '@/middleware/permissionMiddleware';
import { Router } from 'express';
import {
  createAccount,
  createFiscalPeriod,
  postJournalEntry,
  createPostingRule,
  buildJournalPreview,
  createDraftJournalEntry,
  transitionJournalEntryStatus,
  reverseJournalEntry,
  listJournalEntries,
  listFiscalPeriods,
  listAccounts,
} from '@/modules/accounting/accountingService';
import { getTrialBalance, trialBalanceQuerySchema } from '@/modules/accounting/reportingService';
import { validate } from '@/middleware/validate';
import { paginationQuerySchema, parsePagination } from '@/shared/pagination';

export const accountingRouter = Router();

accountingRouter.post('/accounting/accounts', async (req, res, next) => {
  try {
    res.status(201).json(await createAccount(req.ctx, req.body));
  } catch (err) {
    next(err);
  }
});

accountingRouter.post('/accounting/fiscal-periods', async (req, res, next) => {
  try {
    const { startDate, endDate } = req.body ?? {};
    res.status(201).json(await createFiscalPeriod(req.ctx, startDate, endDate));
  } catch (err) {
    next(err);
  }
});

/** المسار المختصر: إنشاء + ترحيل فوري عبر دورة الحياة الكاملة ضمن معاملة واحدة. */
accountingRouter.post('/accounting/journal-entries', async (req, res, next) => {
  try {
    res.status(201).json(await postJournalEntry(req.ctx, req.body));
  } catch (err) {
    next(err);
  }
});

accountingRouter.post('/accounting/journal-entries/draft', async (req, res, next) => {
  try {
    res.status(201).json(await createDraftJournalEntry(req.ctx, req.body));
  } catch (err) {
    next(err);
  }
});

accountingRouter.post('/accounting/journal-entries/:id/transition', async (req, res, next) => {
  try {
    const { target, reason } = req.body ?? {};
    res.status(200).json(await transitionJournalEntryStatus(req.ctx, req.params.id, target, reason));
  } catch (err) {
    next(err);
  }
});

accountingRouter.post('/accounting/journal-entries/:id/reverse', async (req, res, next) => {
  try {
    const { reason } = req.body ?? {};
    res.status(201).json(await reverseJournalEntry(req.ctx, req.params.id, reason));
  } catch (err) {
    next(err);
  }
});

accountingRouter.post('/accounting/posting-rules', async (req, res, next) => {
  try {
    res.status(201).json(await createPostingRule(req.ctx, req.body));
  } catch (err) {
    next(err);
  }
});

accountingRouter.post('/accounting/posting-preview', requirePermission('accounting.journal.view'), async (req, res, next) => {
  try {
    const { legs } = req.body ?? {};
    res.status(200).json(await buildJournalPreview(req.ctx, legs));
  } catch (err) {
    next(err);
  }
});

accountingRouter.get('/accounting/journal-entries', validate({ query: paginationQuerySchema }), async (req, res, next) => {
  try {
    const { page, pageSize, status } = parsePagination(req.query as Record<string, unknown>);
    res.status(200).json(await listJournalEntries(req.ctx, page, pageSize, status));
  } catch (err) { next(err); }
});

accountingRouter.get('/accounting/reports/trial-balance', validate({ query: trialBalanceQuerySchema }), async (req, res, next) => {
  try {
    const { asOfDate, fromDate, onlyWithActivity } = trialBalanceQuerySchema.parse(req.query);
    res.status(200).json(await getTrialBalance(req.ctx, asOfDate, fromDate, onlyWithActivity));
  } catch (err) { next(err); }
});

import * as fa from '@/modules/accounting/fixedAssetService';
import { idParamSchema } from '@/shared/zodSchemas';
const hh = (fn: (req: any) => Promise<unknown>, status = 200) => async (req: any, res: any, next: any) => { try { res.status(status).json(await fn(req)); } catch (e) { next(e); } }; // eslint-disable-line @typescript-eslint/no-explicit-any
accountingRouter.get('/assets', validate({ query: fa.listSchema }), hh((r) => fa.listAssets(r.ctx, r.query)));
accountingRouter.post('/assets', validate({ body: fa.assetSchema }), hh((r) => fa.createAsset(r.ctx, r.body), 201));
accountingRouter.post('/assets/depreciation/run', validate({ body: fa.runSchema }), hh((r) => fa.runDepreciation(r.ctx, r.body)));
accountingRouter.post('/assets/depreciation/reverse', validate({ body: fa.reverseSchema }), hh((r) => fa.reverseDepreciation(r.ctx, r.body)));
accountingRouter.get('/assets/:id', validate({ params: idParamSchema }), hh((r) => fa.assetCard(r.ctx, String(r.params.id))));
accountingRouter.post('/assets/:id/dispose', validate({ params: idParamSchema, body: fa.disposeSchema }), hh((r) => fa.disposeAsset(r.ctx, String(r.params.id), r.body)));
import * as lc from '@/modules/purchasing/landedCostService';
accountingRouter.get('/landed-costs/settings', hh((r) => lc.getSettings(r.ctx)));
accountingRouter.put('/landed-costs/settings', validate({ body: lc.settingsSchema }), hh((r) => lc.saveSettings(r.ctx, r.body)));
accountingRouter.post('/landed-costs/preview', validate({ body: lc.previewSchema }), hh((r) => lc.preview(r.ctx, r.body)));
accountingRouter.get('/landed-costs/report', validate({ query: lc.reportSchema }), hh((r) => lc.report(r.ctx, r.query)));
accountingRouter.post('/landed-costs/reapply', validate({ body: lc.reapplySchema }), hh((r) => lc.reapply(r.ctx, r.body)));
accountingRouter.get('/landed-costs', hh((r) => lc.list(r.ctx)));
accountingRouter.post('/landed-costs', validate({ body: lc.docSchema }), hh((r) => lc.post(r.ctx, r.body), 201));
accountingRouter.get('/landed-costs/:id', validate({ params: idParamSchema }), hh((r) => lc.getDoc(r.ctx, String(r.params.id))));
accountingRouter.post('/landed-costs/:id/reverse', validate({ params: idParamSchema, body: lc.reverseSchema }), hh((r) => lc.reverse(r.ctx, String(r.params.id), r.body)));
import * as mr from '@/modules/accounting/managementReports';
accountingRouter.get('/accounting/reports/slow-moving', validate({ query: mr.slowSchema }), hh((r) => mr.slowMoving(r.ctx, r.query)));
accountingRouter.get('/accounting/reports/cheque-schedule', validate({ query: mr.chequeSchema }), hh((r) => mr.chequeSchedule(r.ctx, r.query)));
accountingRouter.get('/accounting/reports/cash-forecast', validate({ query: mr.forecastSchema }), hh((r) => mr.cashForecast(r.ctx, r.query)));
import * as pc from '@/modules/accounting/periodClosing';
accountingRouter.get('/accounting/fiscal-periods/:id/pre-close', validate({ params: idParamSchema }), hh((r) => pc.preCloseCheck(r.ctx, String(r.params.id))));
accountingRouter.post('/accounting/fiscal-periods/:id/close', validate({ params: idParamSchema, body: pc.closeSchema }), hh((r) => pc.closePeriod(r.ctx, String(r.params.id), r.body)));
accountingRouter.post('/accounting/fiscal-periods/:id/reopen', validate({ params: idParamSchema, body: pc.reopenSchema }), hh((r) => pc.reopenPeriod(r.ctx, String(r.params.id), r.body)));
accountingRouter.post('/accounting/year-end/preview', validate({ body: pc.yearEndSchema }), hh((r) => pc.previewYearEnd(r.ctx, r.body)));
accountingRouter.post('/accounting/year-end', validate({ body: pc.yearEndSchema }), hh((r) => pc.closeYear(r.ctx, r.body), 201));
accountingRouter.get('/accounting/year-end', hh((r) => pc.listYearEnd(r.ctx)));
accountingRouter.post('/accounting/year-end/:id/reverse', validate({ params: idParamSchema, body: pc.reverseYearEndSchema }), hh((r) => pc.reverseYearEnd(r.ctx, String(r.params.id), r.body)));
import * as wt from '@/modules/accounting/withholdingTax';
accountingRouter.get('/wht/settings', hh((r) => wt.getSettings(r.ctx)));
accountingRouter.put('/wht/settings', validate({ body: wt.settingsSchema }), hh((r) => wt.saveSettings(r.ctx, r.body)));
accountingRouter.get('/wht/categories', hh((r) => wt.listCategories(r.ctx)));
accountingRouter.put('/wht/categories', validate({ body: wt.categorySchema }), hh((r) => wt.saveCategory(r.ctx, r.body)));
accountingRouter.get('/wht/preview', hh((r) => wt.preview(r.ctx, { direction: String(r.query.direction) as 'payable', invoiceId: String(r.query.invoiceId), categoryId: String(r.query.categoryId) })));
accountingRouter.post('/wht/apply', validate({ body: wt.applySchema }), hh((r) => wt.apply(r.ctx, r.body), 201));
accountingRouter.post('/wht/remit', validate({ body: wt.remitSchema }), hh((r) => wt.remit(r.ctx, r.body)));
accountingRouter.get('/wht/report', validate({ query: wt.reportSchema }), hh((r) => wt.report(r.ctx, r.query)));
accountingRouter.post('/wht/:id/reverse', validate({ params: idParamSchema, body: wt.reverseSchema }), hh((r) => wt.reverse(r.ctx, String(r.params.id), r.body)));
import * as cf from '@/modules/accounting/carryForward';
accountingRouter.get('/accounting/carry-forward', hh((r) => cf.list(r.ctx)));
accountingRouter.post('/accounting/carry-forward/preview', validate({ body: cf.previewSchema }), hh((r) => cf.preview(r.ctx, r.body)));
accountingRouter.post('/accounting/carry-forward', validate({ body: cf.createSchema }), hh((r) => cf.create(r.ctx, r.body), 201));
accountingRouter.get('/accounting/carry-forward/:id', validate({ params: idParamSchema }), hh((r) => cf.get(r.ctx, String(r.params.id))));
accountingRouter.get('/accounting/carry-forward/:id/verify', validate({ params: idParamSchema }), hh((r) => cf.verify(r.ctx, String(r.params.id))));
accountingRouter.post('/accounting/carry-forward/:id/reverse', validate({ params: idParamSchema, body: cf.reverseSchema }), hh((r) => cf.reverse(r.ctx, String(r.params.id), r.body)));
import * as fr from '@/modules/accounting/financialReports';
accountingRouter.get('/accounting/reports/aging', validate({ query: fr.agingSchema }), async (req, res, next) => { try { res.status(200).json(await fr.agedBalances(req.ctx, req.query as never)); } catch (err) { next(err); } });
accountingRouter.get('/accounting/reports/income-statement', validate({ query: fr.periodSchema }), async (req, res, next) => { try { res.status(200).json(await fr.incomeStatement(req.ctx, req.query as never)); } catch (err) { next(err); } });
accountingRouter.get('/accounting/reports/balance-sheet', validate({ query: fr.asOfSchema }), async (req, res, next) => { try { res.status(200).json(await fr.balanceSheet(req.ctx, req.query as never)); } catch (err) { next(err); } });
accountingRouter.get('/accounting/reports/vat-return', validate({ query: fr.vatSchema }), async (req, res, next) => { try { res.status(200).json(await fr.vatReturn(req.ctx, req.query as never)); } catch (err) { next(err); } });
accountingRouter.get('/accounting/reports/reorder', validate({ query: fr.reorderSchema }), async (req, res, next) => { try { res.status(200).json(await fr.reorderSuggestions(req.ctx, req.query as never)); } catch (err) { next(err); } });

accountingRouter.get('/accounting/fiscal-periods', async (req, res, next) => {
  try { res.status(200).json(await listFiscalPeriods(req.ctx)); } catch (err) { next(err); }
});

accountingRouter.get('/accounting/accounts', async (req, res, next) => {
  try { res.status(200).json(await listAccounts(req.ctx)); } catch (err) { next(err); }
});

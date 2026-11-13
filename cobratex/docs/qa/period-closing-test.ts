import * as pc from '@/modules/accounting/periodClosing';
import * as fr from '@/modules/accounting/financialReports';
import { postBaseEntry } from '@/modules/accounting/postingHelper';
import { pool, withTransaction } from '@/db/pool';
const Z = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`;
const V = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`;
const denied = new Set<string>();
const ctx: any = { companyId: Z('0000000000c1'), tenantId: Z('0000000000a1'), userId: Z('000000000f00'), assertPermission(c: string) { if (denied.has(c)) throw new Error('DENIED:' + c); }, visibleBranchIds: () => null };
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const near = (a: any, b: number, m: string, t = 0.01) => ok(a !== null && a !== undefined && Math.abs(Number(a) - b) <= t, `${m}: expected ${b} got ${a}`);
const rej = async (fn: () => Promise<unknown>, re: RegExp, m: string) => { try { await fn(); ok(false, m + ' (no error)'); } catch (e: any) { ok(re.test(e.message), m + ' → ' + e.message); } };
const BR = Z('0000000000b1'), FP = Z('000000000003'), WH = Z('000000000001'), C1 = Z('000000000009');
const q = (s: string, p: any[] = []) => pool.query(s, p);
const net = async (a: string) => Number((await q(`SELECT COALESCE(SUM(jl.debit - jl.credit),0) AS b FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id WHERE jl.account_id=$1 AND je.status='posted'`, [a])).rows[0].b);
(async () => {
  const ac = (id: string, code: string, t: string) => q(`INSERT INTO accounts(id,company_id,code,name_ar,name_en,account_type) VALUES ($1,$2,$3,$3,$3,$4)`, [id, ctx.companyId, code, t]);
  const REV = V('71'), REV2 = V('72'), EXP = V('73'), EXP2 = V('74'), RE = V('75'), CASH = V('76');
  await ac(REV, '4100', 'revenue'); await ac(REV2, '4200', 'revenue'); await ac(EXP, '5100', 'expense'); await ac(EXP2, '5200', 'expense'); await ac(RE, '3200', 'equity'); await ac(CASH, '1100', 'asset');
  const post = (date: string, dr: string, cr: string, amt: number) => withTransaction(async (c: any) => postBaseEntry(ctx, c, { branchId: BR, date, sourceType: 'test', lines: [{ accountId: dr, debit: String(amt), credit: '0', description: 't' }, { accountId: cr, debit: '0', credit: String(amt), description: 't' }] }));
  await post('2026-03-10', CASH, REV, 5000); await post('2026-06-10', CASH, REV2, 1000); await post('2026-04-10', EXP, CASH, 2000); await post('2026-05-10', EXP2, CASH, 500);

  // ===== فحص ما قبل الإقفال =====
  const draftJe = (await q(`INSERT INTO journal_entries(company_id,branch_id,fiscal_period_id,entry_date,currency_code,status) VALUES ($1,$2,$3,'2026-07-01','EGP','draft') RETURNING id`, [ctx.companyId, BR, FP])).rows[0].id;
  await q(`INSERT INTO sales_invoices(company_id,branch_id,warehouse_id,customer_id,fiscal_period_id,document_number,currency_code,invoice_date,status) VALUES ($1,$2,$3,$4,$5,'DRAFT-1','EGP','2026-08-01','draft')`, [ctx.companyId, BR, WH, C1, FP]);
  const chk = await pc.preCloseCheck(ctx, FP);
  ok(!chk.canClose && chk.blockers.length === 1 && /draft/.test(chk.blockers[0]), 'draft journal entry blocks closing'); ok(chk.warnings.some((w: string) => /فواتير بيع مسودة/.test(w)), 'draft sales invoice is a warning');
  await rej(() => pc.closePeriod(ctx, FP), /لا يمكن الإقفال/, 'close refused while blockers exist');
  await q(`UPDATE journal_entries SET status='cancelled' WHERE id=$1`, [draftJe]); ok((await pc.preCloseCheck(ctx, FP)).canClose, 'cancelled entry no longer blocks');
  denied.add('accounting.period.close'); await rej(() => pc.preCloseCheck(ctx, FP), /DENIED/, 'pre-close perm'); denied.clear();
  await rej(() => pc.preCloseCheck(ctx, V('99')), /غير موجودة/, 'unknown period');

  // ===== قيد إقفال السنة =====
  const pv = await pc.previewYearEnd(ctx, { fromDate: '2026-01-01', toDate: '2026-12-31', retainedAccountId: RE });
  near(pv.revenue, 6000, 'preview revenue 6000'); near(pv.expense, 2500, 'preview expense 2500'); near(pv.netIncome, 3500, 'preview net income 3500'); ok(pv.accounts.length === 4, '4 accounts to close');
  await rej(() => pc.closeYear(ctx, { fromDate: '2026-01-01', toDate: '2026-12-31', retainedAccountId: CASH }), /حقوق الملكية/, 'retained account must be equity');
  await rej(() => pc.closeYear(ctx, { fromDate: '2026-01-01', toDate: '2026-12-31', closingDate: '2027-01-01', retainedAccountId: RE }), /داخل الفترة/, 'closing date inside range');
  await rej(() => pc.closeYear(ctx, { fromDate: '2026-01-01', toDate: '2026-12-31', retainedAccountId: V('98') }), /غير موجود/, 'unknown retained account');
  denied.add('accounting.yearend.close'); await rej(() => pc.closeYear(ctx, { fromDate: '2026-01-01', toDate: '2026-12-31', retainedAccountId: RE }), /DENIED/, 'year-end perm'); denied.clear();
  const y = await pc.closeYear(ctx, { fromDate: '2026-01-01', toDate: '2026-12-31', retainedAccountId: RE });
  near(y.net_income, 3500, 'closing net income 3500'); ok(y.accounts_closed === 4, '4 accounts closed');
  near(await net(REV), 0, 'REV zeroed'); near(await net(REV2), 0, 'REV2 zeroed'); near(await net(EXP), 0, 'EXP zeroed'); near(await net(EXP2), 0, 'EXP2 zeroed'); near(await net(RE), -3500, 'retained earnings credited 3500'); near(await net(CASH), 3500, 'cash unchanged 3500');
  await rej(() => pc.closeYear(ctx, { fromDate: '2026-06-01', toDate: '2026-12-31', retainedAccountId: RE }), /يتداخل/, 'overlapping closing refused');
  const is = await fr.incomeStatement(ctx, { from: '2026-01-01', to: '2026-12-31' }); near(is.totalRevenue, 6000, 'income statement still shows revenue 6000 (closing excluded)'); near(is.netIncome, 3500, 'income statement net 3500');
  const bs = await fr.balanceSheet(ctx, { asOf: '2026-12-31' }); ok(bs.balanced, 'balance sheet balanced after closing'); near(bs.currentEarnings, 0, 'no unclosed earnings after closing'); near(bs.totalEquity, 3500, 'equity holds 3500');
  ok((await pc.listYearEnd(ctx)).length === 1, 'list shows 1 closing');
  await rej(() => pc.reverseYearEnd(ctx, y.id, { reason: 'x' }), /3/, 'reverse reason too short');
  await pc.reverseYearEnd(ctx, y.id, { reason: 'تعديل قيود قبل الإقفال' });
  near(await net(REV), -5000, 'REV restored after reversal'); near(await net(EXP), 2000, 'EXP restored'); near(await net(RE), 0, 'retained earnings back to 0');
  await rej(() => pc.reverseYearEnd(ctx, y.id, { reason: 'مرة أخرى' }), /بالفعل/, 'double reverse refused');
  near((await fr.incomeStatement(ctx, { from: '2026-01-01', to: '2026-12-31' })).netIncome, 3500, 'income statement unaffected by closing + reversal');
  // خسارة
  await post('2026-11-01', EXP, CASH, 10000);
  const pl = await pc.previewYearEnd(ctx, { fromDate: '2026-01-01', toDate: '2026-12-31', retainedAccountId: RE }); near(pl.netIncome, -6500, 'loss year net −6500');
  const yl = await pc.closeYear(ctx, { fromDate: '2026-01-01', toDate: '2026-12-31', retainedAccountId: RE }); near(await net(RE), 6500, 'retained earnings DEBITED 6500 for a loss'); ok((await fr.balanceSheet(ctx, { asOf: '2026-12-31' })).balanced, 'balanced with loss');

  // ===== إقفال الفترة (المشغّل على مستوى قاعدة البيانات) =====
  const cl = await pc.closePeriod(ctx, FP, { note: 'إقفال 2026' }); ok(cl.status === 'closed', 'period closed');
  await rej(() => pc.closePeriod(ctx, FP), /بالفعل/, 'double close');
  await rej(() => post('2026-12-20', CASH, REV, 100), /مغلقة/, 'helper refuses closed period');
  const late = (await q(`INSERT INTO journal_entries(company_id,branch_id,fiscal_period_id,entry_date,currency_code,status) VALUES ($1,$2,$3,'2026-12-20','EGP','draft') RETURNING id`, [ctx.companyId, BR, FP])).rows[0].id;
  await q(`INSERT INTO journal_lines(journal_entry_id,company_id,account_id,debit,credit) VALUES ($1,$2,$3,100,0),($1,$2,$4,0,100)`, [late, ctx.companyId, CASH, REV]);
  await rej(() => q(`UPDATE journal_entries SET status='posted' WHERE id=$1`, [late]), /مقفلة/, 'DB trigger blocks posting into a closed period (any code path)');
  await rej(() => q(`INSERT INTO journal_entries(company_id,branch_id,fiscal_period_id,entry_date,currency_code,status) VALUES ($1,$2,$3,'2026-12-21','EGP','posted')`, [ctx.companyId, BR, FP]), /مقفلة/, 'DB trigger blocks direct insert as posted');
  ok((await q(`SELECT status FROM journal_entries WHERE id=$1`, [late])).rows[0].status === 'draft', 'entry stayed draft');
  // إعادة الفتح
  await rej(() => pc.reopenPeriod(ctx, FP, { reason: 'x' }), /3/, 'reopen needs a reason'); denied.add('accounting.period.reopen'); await rej(() => pc.reopenPeriod(ctx, FP, { reason: 'تعديل مطلوب' }), /DENIED/, 'reopen perm'); denied.clear();
  const ro = await pc.reopenPeriod(ctx, FP, { reason: 'تصحيح عكس إقفال السنة' }); ok(ro.status === 'open' && ro.warnings.length === 1, 'reopened with warning about the existing year-end entry');
  await rej(() => pc.reopenPeriod(ctx, FP, { reason: 'مرة أخرى' }), /مفتوحة/, 'reopening an open period refused');
  await pc.reverseYearEnd(ctx, yl.id, { reason: 'إعادة إصدار بعد التعديل' }); near(await net(RE), 0, 'year-end reversed after reopening');
  await q(`UPDATE journal_entries SET status='posted' WHERE id=$1`, [late]); ok(true, 'posting allowed again once reopened');
  console.log(`PASS ${pass} FAIL ${fail}`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR', e.message || e); process.exit(1); });

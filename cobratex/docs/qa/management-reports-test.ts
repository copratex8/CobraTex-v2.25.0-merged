import * as mr from '@/modules/accounting/managementReports';
import * as fx from '@/modules/accounting/fxRatesService';
import { pool, withTransaction } from '@/db/pool';
const Z = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`;
const V = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`;
const denied = new Set<string>();
const ctx: any = { companyId: Z('0000000000c1'), tenantId: Z('0000000000a1'), userId: Z('000000000f00'), assertPermission(c: string) { if (denied.has(c)) throw new Error('DENIED:' + c); }, visibleBranchIds: () => null };
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const near = (a: any, b: number, m: string, t = 0.01) => ok(a !== null && a !== undefined && Math.abs(Number(a) - b) <= t, `${m}: expected ${b} got ${a}`);
const rej = async (fn: () => Promise<unknown>, re: RegExp, m: string) => { try { await fn(); ok(false, m + ' (no error)'); } catch (e: any) { ok(re.test(e.message), m + ' → ' + e.message); } };
const BR = Z('0000000000b1'), WH = Z('000000000001'), FP = Z('000000000003'), YARN = Z('000000000101'), FAB = Z('000000000102'), UOM = Z('0000000000d0'), C1 = Z('000000000009'), S1 = Z('00000000000a'), GEN = Z('000000000203');
const q = (s: string, p: any[] = []) => pool.query(s, p);
(async () => {
  ok(mr.ageBucket(90) === 'd0_90' && mr.ageBucket(91) === 'd91_180' && mr.ageBucket(366) === 'd365p', 'age bucket boundaries');
  // ===== مخزون راكد =====
  await q(`INSERT INTO items(id,company_id,item_kind,code,name_ar,name_en,base_uom_id) VALUES ($1,$2,'generic','GEN','عام','g',$3)`, [GEN, ctx.companyId, UOM]);
  const bal = (it: string, qty: number, w: number, wh = WH) => q(`INSERT INTO stock_balances(company_id,warehouse_id,item_id,quantity_on_hand,weighted_average_cost) VALUES ($1,$2,$3,$4,$5)`, [ctx.companyId, wh, it, qty, w]);
  await bal(YARN, 100, 10); await bal(FAB, 50, 40); await bal(GEN, 20, 5);
  const mv = (it: string, t: string, qty: number, d: string, st = 'posted') => q(`INSERT INTO stock_movements(company_id,branch_id,warehouse_id,item_id,movement_type,quantity,unit_cost,movement_date,effective_date,source_document_type,status) VALUES ($1,$2,$3,$4,$5,$6,10,$7,$7,'t',$8)`, [ctx.companyId, BR, WH, it, t, qty, d, st]);
  await mv(YARN, 'in', 200, '2026-01-05'); await mv(YARN, 'out', 100, '2026-06-01'); await mv(YARN, 'out', 5, '2026-10-30', 'reversed'); // الصرف المعكوس لا يُحتسب
  await mv(FAB, 'in', 50, '2026-01-10'); await mv(GEN, 'in', 20, '2026-09-01'); await mv(GEN, 'out', 1, '2026-10-20');
  const sm = await mr.slowMoving(ctx, { asOf: '2026-11-02' });
  ok(sm.items.length === 2 && sm.items[0].code === 'FAB', 'FAB (value 2000) first, GEN excluded under 90 days');
  const yarn = sm.items.find((x: any) => x.code === 'YARN'), fab = sm.items.find((x: any) => x.code === 'FAB');
  ok(yarn.daysIdle === 154 && yarn.bucket === 'd91_180' && yarn.lastIssueDate === '2026-06-01', 'YARN idle 154 days since last issue (reversed out ignored)');
  ok(fab.neverIssued && fab.daysIdle === 296 && fab.bucket === 'd181_365', 'FAB never issued → aged from first receipt (296d)');
  near(sm.totals.d91_180, 1000, 'bucket 91-180 = 1000'); near(sm.totals.d181_365, 2000, 'bucket 181-365 = 2000'); near(sm.totals.total, 3000, 'idle total 3000'); near(sm.stockValue, 3100, 'stock value 3100'); near(sm.idleShare, 96.77, 'idle share 96.77%');
  ok((await mr.slowMoving(ctx, { asOf: '2026-11-02', thresholdDays: 10 })).items.length === 3, 'threshold 10d includes GEN');
  ok((await mr.slowMoving(ctx, { asOf: '2026-11-02', warehouseId: '11111111-1111-4111-8111-111111111111' })).items.length === 0, 'other warehouse empty');
  denied.add('inventory.balance.view'); await rej(() => mr.slowMoving(ctx, { asOf: '2026-11-02' }), /DENIED/, 'slow perm'); denied.clear();
  await q(`DELETE FROM stock_balances`);

  // ===== شيكات =====
  await q(`DELETE FROM sales_invoice_lines`); await q(`DELETE FROM sales_invoices`);
  const ac = (id: string, code: string, t: string) => q(`INSERT INTO accounts(id,company_id,code,name_ar,name_en,account_type) VALUES ($1,$2,$3,$3,$3,$4)`, [id, ctx.companyId, code, t]);
  const BANKA = V('51'), CAPA = V('52'), SUPA = V('98'); await ac(BANKA, '1200', 'asset'); await ac(CAPA, '3000', 'equity'); await ac(SUPA, '9998', 'liability');
  await q(`INSERT INTO safe_or_banks(id,company_id,branch_id,code,name_ar,name_en,kind,linked_account_id,currency_code,bank_name,account_number) VALUES ($1,$2,$3,'B1','بنك','b','bank',$4,'EGP','بنك','123')`, [V('61'), ctx.companyId, BR, BANKA]);
  await q(`UPDATE customers SET payment_term_days=30 WHERE id=$1`, [C1]);
  await q(`INSERT INTO suppliers(id,company_id,code,name_ar,name_en,currency_code,linked_account_id,payment_term_days) VALUES ($1,$2,'S1','مورد','s','EGP',$3,15)`, [S1, ctx.companyId, SUPA]);
  await fx.setRate(ctx, { currencyCode: 'USD', rateDate: '2026-11-01', rate: 50 });
  let n = 0; const chk = (type: string, due: string, amt: number, status = 'pending', cur = 'EGP') => q(`INSERT INTO checks(company_id,branch_id,safe_or_bank_id,check_type,check_number,check_date,due_date,amount,currency_code,counterparty_customer_id,counterparty_supplier_id,status) VALUES ($1,$2,$3,$4,$5,'2026-10-01',$6,$7,$8,$9,$10,$11)`, [ctx.companyId, BR, V('61'), type, 'CH' + ++n, due, amt, cur, type === 'incoming' ? C1 : null, type === 'outgoing' ? S1 : null, status]);
  await chk('incoming', '2026-10-30', 1000); await chk('incoming', '2026-11-05', 2000, 'deposited'); await chk('incoming', '2026-12-10', 10, 'pending', 'USD'); await chk('outgoing', '2026-11-12', 4000);
  await chk('incoming', '2026-11-03', 9999, 'cleared'); await chk('outgoing', '2026-11-03', 9999, 'bounced');
  const cs = await mr.chequeSchedule(ctx, { asOf: '2026-11-02' });
  near(cs.incoming.overdue, 1000, 'incoming overdue 1000'); near(cs.incoming.w1, 2000, 'incoming ≤7d 2000'); near(cs.incoming.d60, 500, 'USD 10×50 = 500 at 38d'); near(cs.incoming.total, 3500, 'incoming total 3500 (cleared excluded)');
  near(cs.outgoing.w2, 4000, 'outgoing 8–14d 4000'); near(cs.outgoing.total, 4000, 'bounced excluded'); near(cs.net, -500, 'net −500'); ok(cs.cheques.length === 4 && cs.cheques[0].due === '2026-10-30' && cs.cheques[0].daysToDue === -3, 'sorted by due date, days to due −3');
  denied.add('treasury.check.view'); await rej(() => mr.chequeSchedule(ctx, { asOf: '2026-11-02' }), /DENIED/, 'cheque perm'); denied.clear();
  await q(`DELETE FROM exchange_rates`); const cs2 = await mr.chequeSchedule(ctx, { asOf: '2026-11-02' }); ok(cs2.cheques.length === 3 && cs2.warnings.some((w: string) => /لا سعر صرف/.test(w)), 'missing FX rate → cheque excluded with warning'); await fx.setRate(ctx, { currencyCode: 'USD', rateDate: '2026-11-01', rate: 50 });

  // ===== توقّع السيولة =====
  const sinv = async (no: string, date: string, amount: number) => {
    const GR = (await q(`INSERT INTO goods_receipts(company_id,branch_id,warehouse_id,supplier_id,document_number,receipt_date,status) VALUES ($1,$2,$3,$4,$5,'2026-06-01','posted') RETURNING id`, [ctx.companyId, BR, WH, S1, 'GR' + no])).rows[0].id;
    const GRL = (await q(`INSERT INTO goods_receipt_lines(goods_receipt_id,company_id,item_id,uom_id,quantity,unit_cost) VALUES ($1,$2,$3,$4,1,1) RETURNING id`, [GR, ctx.companyId, YARN, UOM])).rows[0].id;
    const id = (await q(`INSERT INTO supplier_invoices(company_id,branch_id,supplier_id,fiscal_period_id,document_number,currency_code,invoice_date,status) VALUES ($1,$2,$3,$4,$5,'EGP',$6,'posted') RETURNING id`, [ctx.companyId, BR, S1, FP, no, date])).rows[0].id;
    await q(`INSERT INTO supplier_invoice_lines(supplier_invoice_id,company_id,goods_receipt_line_id,item_id,quantity,unit_cost,subtotal,line_total) VALUES ($1,$2,$3,$4,1,$5,$5,$5)`, [id, ctx.companyId, GRL, YARN, amount]);
  };
  const sid = (await q(`INSERT INTO sales_invoices(company_id,branch_id,warehouse_id,customer_id,fiscal_period_id,document_number,currency_code,invoice_date,status) VALUES ($1,$2,$3,$4,$5,'X1','EGP','2026-10-20','posted') RETURNING id`, [ctx.companyId, BR, WH, C1, FP])).rows[0].id;
  await q(`INSERT INTO sales_invoice_lines(sales_invoice_id,company_id,item_id,uom_id,quantity,unit_price,subtotal,line_total) VALUES ($1,$2,$3,$4,1,3000,3000,3000)`, [sid, ctx.companyId, YARN, UOM]);
  const sid2 = (await q(`INSERT INTO sales_invoices(company_id,branch_id,warehouse_id,customer_id,fiscal_period_id,document_number,currency_code,invoice_date,status) VALUES ($1,$2,$3,$4,$5,'X2','EGP','2026-10-30','posted') RETURNING id`, [ctx.companyId, BR, WH, C1, FP])).rows[0].id;
  await q(`INSERT INTO sales_invoice_lines(sales_invoice_id,company_id,item_id,uom_id,quantity,unit_price,subtotal,line_total) VALUES ($1,$2,$3,$4,1,5000,5000,5000)`, [sid2, ctx.companyId, YARN, UOM]);
  await sinv('PI1', '2026-10-01', 6000);
  await withTransaction(async (c: any) => { const id = (await c.query(`INSERT INTO journal_entries(company_id,branch_id,fiscal_period_id,entry_date,currency_code,status) VALUES ($1,$2,$3,'2026-10-01','EGP','posted') RETURNING id`, [ctx.companyId, BR, FP])).rows[0].id; await c.query(`INSERT INTO journal_lines(journal_entry_id,company_id,account_id,debit,credit) VALUES ($1,$2,$3,10000,0),($1,$2,$4,0,10000)`, [id, ctx.companyId, BANKA, CAPA]); });
  const f = await mr.cashForecast(ctx, { asOf: '2026-11-02', weeks: 13 });
  near(f.opening, 10000, 'opening = bank GL balance 10000');
  // X1 3000 (due 11-19, week 3) مُخصَّم بالكامل بشيكات العميل (3500 base) ثم X2 5000 (due 11-29, week 4) يُخصَم منها الباقي 500 ⇒ 4500
  near(f.weeks[0].inflow, 3000, 'week 1 inflow: overdue cheque 1000 + cheque 2000'); near(f.weeks[0].overdueInflow, 1000, 'overdue cheque in week 1');
  near(f.weeks[2].inflow, 0, 'X1 fully covered by cheques → nothing in week 3'); near(f.weeks[3].inflow, 4500, 'X2 5000 − 500 leftover cheque netting = 4500 (due 11-29 week 4)');
  near(f.weeks[5].inflow, 500, 'USD cheque 500 due 12-10 → week 6');
  near(f.weeks[0].outflow, 2000, 'week 1 outflow: PI1 6000 − outgoing cheque 4000 = 2000 overdue'); near(f.weeks[1].outflow, 4000, 'week 2 outflow: outgoing cheque 4000 on 11-12');
  near(f.weeks[0].closing, 11000, 'week 1 closing 11000'); near(f.weeks[1].closing, 7000, 'week 2 closing 7000'); near(f.closing, 7000 + 4500 + 500, 'final closing 12000'); ok(f.lowest.week === 2 && f.lowest.closing === 7000, 'lowest point week 2 = 7000'); ok(f.warnings.length === 0, 'no warnings in healthy forecast');
  near(f.totals.inflow, 8000, 'total inflow 3000+4500+500'); near(f.totals.outflow, 6000, 'total outflow 2000+4000');
  await sinv('PI2', '2026-10-30', 20000); const f2 = await mr.cashForecast(ctx, { asOf: '2026-11-02', weeks: 4 });
  ok(f2.lowest.closing < 0 && f2.warnings.some((w: string) => /عجز سيولة/.test(w)), 'big overdue payable → deficit warning'); near(f2.totals.beyondHorizonInflow, 500, 'USD cheque beyond 4-week horizon reported separately');
  denied.add('accounting.journal.view'); await rej(() => mr.cashForecast(ctx, { asOf: '2026-11-02' }), /DENIED/, 'forecast perm'); denied.clear();
  await rej(() => mr.cashForecast(ctx, { asOf: '2026-11-02', weeks: 99 } as any), /Too big|26|<=/i, 'weeks capped at 26');
  console.log(`PASS ${pass} FAIL ${fail}`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR', e.message || e); process.exit(1); });

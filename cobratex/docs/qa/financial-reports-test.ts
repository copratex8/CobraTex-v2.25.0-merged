import * as fr from '@/modules/accounting/financialReports';
import { pool, withTransaction } from '@/db/pool';
const Z = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`;
const denied = new Set<string>();
const ctx: any = { companyId: Z('0000000000c1'), tenantId: Z('0000000000a1'), userId: Z('000000000f00'), assertPermission(c: string) { if (denied.has(c)) throw new Error('DENIED:' + c); }, visibleBranchIds: () => null };
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const near = (a: any, b: number, m: string, t = 0.01) => ok(a !== null && a !== undefined && Math.abs(Number(a) - b) <= t, `${m}: expected ${b} got ${a}`);
const rej = async (fn: () => Promise<unknown>, re: RegExp, m: string) => { try { await fn(); ok(false, m + ' (no error)'); } catch (e: any) { ok(re.test(e.message), m + ' → ' + e.message); } };
const BR = Z('0000000000b1'), WH = Z('000000000001'), FP = Z('000000000003'), YARN = Z('000000000101'), FAB = Z('000000000102'), UOM = Z('0000000000d0'), C1 = Z('000000000009'), S1 = Z('00000000000a');
const q = (s: string, p: any[] = []) => pool.query(s, p);
(async () => {
  for (const [n, c] of [['97', '9997'], ['98', '9998']]) await q(`INSERT INTO accounts(id,company_id,code,name_ar,name_en,account_type) VALUES ($1,$2,$3,$3,$3,'asset')`, [Z(n), ctx.companyId, c]);
  await q(`DELETE FROM sales_invoice_lines`); await q(`DELETE FROM sales_invoices`); // تنظيف فواتير بذرة الاختبار
  await q(`UPDATE customers SET payment_term_days=30 WHERE id=$1`, [C1]);
  await q(`INSERT INTO suppliers(id,company_id,code,name_ar,name_en,currency_code,linked_account_id,payment_term_days) VALUES ($1,$2,'S1','مورد','s','EGP',$3,15)`, [S1, ctx.companyId, Z('000000000098')]);
  // ===== مدينون =====
  const inv = async (no: string, date: string, amount: number, cur = 'EGP', rate = 1) => {
    const id = (await q(`INSERT INTO sales_invoices(company_id,branch_id,warehouse_id,customer_id,fiscal_period_id,document_number,currency_code,exchange_rate,invoice_date,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'posted') RETURNING id`, [ctx.companyId, BR, WH, C1, FP, no, cur, rate, date])).rows[0].id;
    await q(`INSERT INTO sales_invoice_lines(sales_invoice_id,company_id,item_id,uom_id,quantity,unit_price,subtotal,line_total) VALUES ($1,$2,$3,$4,1,$5,$5,$5)`, [id, ctx.companyId, YARN, UOM, amount]); return id;
  };
  const pay = async (no: string, date: string, amount: number, alloc: Array<[string, number]>, status = 'posted') => {
    const id = (await q(`INSERT INTO customer_payments(company_id,branch_id,customer_id,fiscal_period_id,document_number,currency_code,payment_date,amount,receipt_account_id,status) VALUES ($1,$2,$3,$4,$5,'EGP',$6,$7,$8,$9) RETURNING id`, [ctx.companyId, BR, C1, FP, no, date, amount, Z('000000000097'), status])).rows[0].id;
    for (const [i, a] of alloc) await q(`INSERT INTO customer_payment_allocations(company_id,customer_payment_id,sales_invoice_id,allocated_amount) VALUES ($1,$2,$3,$4)`, [ctx.companyId, id, i, a]);
  };
  const A = await inv('A', '2026-10-25', 1000), B = await inv('B', '2026-09-20', 2000), Cc = await inv('C', '2026-06-01', 500), U = await inv('U', '2026-10-01', 100, 'USD', 50);
  await q(`INSERT INTO sales_invoices(company_id,branch_id,warehouse_id,customer_id,fiscal_period_id,document_number,currency_code,invoice_date,status) VALUES ($1,$2,$3,$4,$5,'DRAFT','EGP','2026-10-01','draft')`, [ctx.companyId, BR, WH, C1, FP]);
  await pay('P1', '2026-10-20', 800, [[B, 800]]);            // B متبقي 1200
  await pay('P2', '2026-10-21', 300, [[A, 300]], 'draft');   // مسودة: لا تُخصم
  await pay('P3', '2026-10-28', 700, [[Cc, 200]]);           // C متبقي 300 + دفعة مقدمة 500
  await pay('P4', '2026-12-01', 100, [[A, 100]]);            // بعد تاريخ التقرير: لا تُخصم
  const r = await fr.agedBalances(ctx, { kind: 'receivable', asOf: '2026-11-01', detail: 'true' as any });
  ok(r.parties.length === 1, 'one customer'); const p = r.parties[0];
  near(p.d0_30, 1000, 'A in 0–30 (draft payment & later payment ignored)'); near(p.d31_60, 1200 + 5000, 'B 1200 + U USD 100×50 = 5000'); near(p.d61_90, 0, '61–90 empty'); near(p.d120p, 300, 'C 300 after posted P3 alloc 200');
  near(p.total, 7500, 'total 7500'); near(p.overdue, 6500, 'overdue past 30-day term = B+C+U'); near(p.unallocatedAdvance, 500, 'advance 500 from P3 (700−200)');
  near(r.totals.total, 7500, 'grand total'); near(r.netExposure, 7000, 'net exposure = 7500 − 500');
  ok(p.invoices.length === 4 && !p.invoices.some((x: any) => x.documentNumber === 'DRAFT'), 'draft invoice excluded, 4 invoices in detail');
  const ib = p.invoices.find((x: any) => x.documentNumber === 'B'); ok(ib.days === 42 && ib.bucket === 'd31_60' && ib.daysOverdue === 12, 'B age 42 / overdue 12');
  // مرتجع مرحَّل يخفّض المتبقي
  const rid = (await q(`INSERT INTO sales_returns(company_id,branch_id,warehouse_id,customer_id,sales_invoice_id,fiscal_period_id,document_number,currency_code,return_date,status) VALUES ($1,$2,$3,$4,$5,$6,'R1','EGP','2026-10-30','posted') RETURNING id`, [ctx.companyId, BR, WH, C1, A, FP])).rows[0].id;
  const al = (await q(`SELECT id FROM sales_invoice_lines WHERE sales_invoice_id=$1`, [A])).rows[0].id;
  await q(`INSERT INTO sales_return_lines(sales_return_id,company_id,sales_invoice_line_id,item_id,quantity,subtotal,line_total,cost_of_goods) VALUES ($1,$2,$3,$4,1,200,200,0)`, [rid, ctx.companyId, al, YARN]);
  near((await fr.agedBalances(ctx, { kind: 'receivable', asOf: '2026-11-01' })).totals.d0_30, 800, 'posted return reduces A to 800');
  near((await fr.agedBalances(ctx, { kind: 'receivable', asOf: '2026-10-29' })).totals.d0_30, 6000, 'as-of 10-29: return dated 10-30 ignored (A 1000 + U 5000)');
  const h = await fr.agedBalances(ctx, { kind: 'receivable', asOf: '2026-10-15' });
  near(h.totals.total, 2000 + 500 + 5000, 'as-of 10-15: B 2000 + C 500 + U 5000 (A issued later, P1/P3 paid later)'); ok(!h.parties[0].invoices.length, 'no detail unless requested');
  ok((await fr.agedBalances(ctx, { kind: 'receivable', asOf: '2026-11-01', partyId: '11111111-1111-4111-8111-111111111111' })).parties.length === 0, 'other party empty');

  // ===== دائنون =====
  const GR = (await q(`INSERT INTO goods_receipts(company_id,branch_id,warehouse_id,supplier_id,document_number,receipt_date,status) VALUES ($1,$2,$3,$4,'GR-1','2026-06-01','posted') RETURNING id`, [ctx.companyId, BR, WH, S1])).rows[0].id;
  const GRL = (await q(`INSERT INTO goods_receipt_lines(goods_receipt_id,company_id,item_id,uom_id,quantity,unit_cost) VALUES ($1,$2,$3,$4,1,1) RETURNING id`, [GR, ctx.companyId, YARN, UOM])).rows[0].id;
  const sinv = async (no: string, date: string, amount: number) => {
    const id = (await q(`INSERT INTO supplier_invoices(company_id,branch_id,supplier_id,fiscal_period_id,document_number,currency_code,invoice_date,status) VALUES ($1,$2,$3,$4,$5,'EGP',$6,'posted') RETURNING id`, [ctx.companyId, BR, S1, FP, no, date])).rows[0].id;
    await q(`INSERT INTO supplier_invoice_lines(supplier_invoice_id,company_id,goods_receipt_line_id,item_id,quantity,unit_cost,subtotal,line_total) VALUES ($1,$2,$3,$4,1,$5,$5,$5)`, [id, ctx.companyId, GRL, YARN, amount]); return id;
  };
  const SA = await sinv('SA', '2026-10-10', 4000), SB = await sinv('SB', '2026-07-01', 1000);
  const sp = (await q(`INSERT INTO supplier_payments(company_id,branch_id,supplier_id,fiscal_period_id,document_number,currency_code,payment_date,amount,payment_account_id,status) VALUES ($1,$2,$3,$4,'SP1','EGP','2026-10-20',1500,$5,'posted') RETURNING id`, [ctx.companyId, BR, S1, FP, Z('000000000097')])).rows[0].id;
  await q(`INSERT INTO supplier_payment_allocations(company_id,supplier_payment_id,supplier_invoice_id,allocated_amount) VALUES ($1,$2,$3,1500)`, [ctx.companyId, sp, SA]);
  const ap = await fr.agedBalances(ctx, { kind: 'payable', asOf: '2026-11-01' });
  near(ap.parties[0].d0_30, 2500, 'SA age 22 → 0–30, outstanding 2500');
  near(ap.totals.d120p, 1000, 'SB 123 days → >120'); near(ap.totals.total, 3500, 'payable total'); near(ap.totals.overdue, 3500 - 0, 'both past 15-day term (SA 22d, SB 123d)');
  denied.add('purchasing.invoice.view'); await rej(() => fr.agedBalances(ctx, { kind: 'payable', asOf: '2026-11-01' }), /DENIED/, 'payable perm'); denied.clear();
  denied.add('sales.invoice.view'); await rej(() => fr.agedBalances(ctx, { kind: 'receivable', asOf: '2026-11-01' }), /DENIED/, 'receivable perm'); denied.clear();
  await rej(() => fr.agedBalances(ctx, { kind: 'receivable', asOf: '01/11/2026' }), /YYYY/, 'bad date');
  ok(fr.bucketOf(0) === 'd0_30' && fr.bucketOf(30) === 'd0_30' && fr.bucketOf(31) === 'd31_60' && fr.bucketOf(121) === 'd120p', 'bucket boundaries');

  // ===== قائمة الدخل والمركز المالي =====
  const ac = async (n: string, code: string, t: string) => { await q(`INSERT INTO accounts(id,company_id,code,name_ar,name_en,account_type) VALUES ($1,$2,$3,$3,$3,$4)`, [Z(n), ctx.companyId, code, t]); };
  await ac('1', '1000', 'asset'); await ac('2', '2000', 'liability'); await ac('3', '3000', 'equity'); await ac('4', '4000', 'revenue'); await ac('5', '5000', 'expense');
  const je = (date: string, status: string, dr: string, cr: string, amt: number) => withTransaction(async (c: any) => {
    const id = (await c.query(`INSERT INTO journal_entries(company_id,branch_id,fiscal_period_id,entry_date,currency_code,status) VALUES ($1,$2,$3,$4,'EGP',$5) RETURNING id`, [ctx.companyId, BR, FP, date, status])).rows[0].id;
    await c.query(`INSERT INTO journal_lines(journal_entry_id,company_id,account_id,debit,credit) VALUES ($1,$2,$3,$4,0),($1,$2,$5,0,$4)`, [id, ctx.companyId, Z(dr), amt, Z(cr)]);
  });
  await je('2026-01-05', 'posted', '1', '3', 10000); await je('2026-10-10', 'posted', '1', '4', 3000); await je('2026-09-10', 'posted', '1', '4', 1000);
  await je('2026-10-15', 'posted', '5', '1', 1200); await je('2026-10-20', 'posted', '5', '2', 800); await je('2026-10-21', 'draft', '1', '4', 9999);
  const is = await fr.incomeStatement(ctx, { from: '2026-10-01', to: '2026-10-31' });
  near(is.totalRevenue, 3000, 'Oct revenue (Sep sale + draft excluded)'); near(is.totalExpense, 2000, 'Oct expenses 1200+800'); near(is.netIncome, 1000, 'net income 1000'); near(is.margin, 33.33, 'margin 33.33%');
  ok(is.revenue.length === 1 && is.expenses.length === 1, 'accounts listed with non-zero amounts only');
  near((await fr.incomeStatement(ctx, { from: '2026-01-01', to: '2026-12-31' })).netIncome, 2000, 'year net 4000 − 2000');
  await rej(() => fr.incomeStatement(ctx, { from: '2026-11-01', to: '2026-10-01' }), /يسبق/, 'from after to');
  const bs = await fr.balanceSheet(ctx, { asOf: '2026-11-01' });
  near(bs.totalAssets, 12800, 'assets 12800'); near(bs.totalLiabilities, 800, 'liabilities 800'); near(bs.totalEquity, 10000, 'equity 10000'); near(bs.currentEarnings, 2000, 'current earnings 2000');
  near(bs.totalLiabilitiesAndEquity, 12800, 'L+E+earnings = 12800'); ok(bs.balanced, 'balance sheet balances');
  const bs0 = await fr.balanceSheet(ctx, { asOf: '2026-02-01' }); near(bs0.totalAssets, 10000, 'early date assets 10000'); ok(bs0.balanced && bs0.currentEarnings === 0, 'early date balanced, no earnings');
  denied.add('accounting.journal.view'); await rej(() => fr.balanceSheet(ctx, { asOf: '2026-11-01' }), /DENIED/, 'bs perm'); denied.clear();

  // ===== إعادة الطلب =====
  const GEN = Z('000000000203');
  await q(`INSERT INTO items(id,company_id,item_kind,code,name_ar,name_en,base_uom_id,reorder_point,reorder_qty) VALUES ($1,$2,'generic','GEN','عام','g',$3,10,5)`, [GEN, ctx.companyId, UOM]);
  await q(`UPDATE items SET reorder_point=100, reorder_qty=50 WHERE id=$1`, [YARN]); await q(`UPDATE items SET reorder_point=20, reorder_qty=0 WHERE id=$1`, [FAB]);
  const sb = (it: string, oh: number, rs: number) => q(`INSERT INTO stock_balances(company_id,warehouse_id,item_id,quantity_on_hand,quantity_reserved) VALUES ($1,$2,$3,$4,$5)`, [ctx.companyId, WH, it, oh, rs]);
  await sb(YARN, 60, 10); await sb(GEN, 100, 0);
  const po = (await q(`INSERT INTO purchase_orders(company_id,branch_id,supplier_id,document_number,currency_code,order_date,status) VALUES ($1,$2,$3,'PO-X','EGP','2026-10-20','confirmed') RETURNING id`, [ctx.companyId, BR, S1])).rows[0].id;
  await q(`INSERT INTO purchase_order_lines(purchase_order_id,company_id,item_id,uom_id,quantity,unit_price,received_quantity) VALUES ($1,$2,$3,$4,40,1,10)`, [po, ctx.companyId, YARN, UOM]);
  const ro = await fr.reorderSuggestions(ctx, {});
  ok(ro.count === 2 && !ro.items.some((x: any) => x.code === 'GEN'), 'GEN (stock 100 > point 10) not suggested');
  ok(ro.items[0].code === 'FAB' && ro.items[0].urgency === 'out_of_stock', 'out-of-stock first'); near(ro.items[0].suggestedQty, 40, 'FAB suggest 2×20 − 0 = 40');
  const y = ro.items.find((x: any) => x.code === 'YARN'); near(y.available, 50, 'YARN available 60−10'); near(y.incoming, 30, 'incoming 40−10'); near(y.position, 80, 'position 80'); near(y.suggestedQty, 120, 'max(50, 200−80)=120'); ok(y.urgency === 'below_point', 'YARN below point');
  await q(`UPDATE purchase_order_lines SET received_quantity=0, quantity=100 WHERE purchase_order_id=$1`, [po]);
  ok((await fr.reorderSuggestions(ctx, {})).count === 1, 'big incoming PO (position 150 > 100) removes YARN');
  await q(`UPDATE purchase_orders SET status='draft' WHERE id=$1`, [po]); ok((await fr.reorderSuggestions(ctx, {})).count === 2, 'draft PO not counted as incoming');
  const rw = await fr.reorderSuggestions(ctx, { warehouseId: '11111111-1111-4111-8111-111111111111' }); ok(rw.count === 3 && rw.items.every((x: any) => x.urgency === 'out_of_stock'), 'other warehouse: nothing on hand → all out of stock');
  denied.add('inventory.balance.view'); await rej(() => fr.reorderSuggestions(ctx, {}), /DENIED/, 'reorder perm'); denied.clear();
  console.log(`PASS ${pass} FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });

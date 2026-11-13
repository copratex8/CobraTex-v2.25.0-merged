import * as lt from '@/modules/manufacturing/textileLots';
import * as fx from '@/modules/accounting/fxRatesService';
import { pool } from '@/db/pool';
const Z = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`;
const denied = new Set<string>();
const ctx: any = { companyId: Z('0000000000c1'), tenantId: Z('0000000000a1'), userId: Z('000000000f00'), assertPermission(c: string) { if (denied.has(c)) throw new Error('DENIED:' + c); }, visibleBranchIds: () => null };
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const near = (a: any, b: number, m: string, t = 0.0001) => ok(a !== null && a !== undefined && Math.abs(Number(a) - b) <= t, `${m}: expected ${b} got ${a}`);
const rej = async (fn: () => Promise<unknown>, re: RegExp, m: string) => { try { await fn(); ok(false, m + ' (no error)'); } catch (e: any) { ok(re.test(e.message), m + ' → ' + e.message); } };
const BR = Z('0000000000b1'), WH = Z('000000000001'), FP = Z('000000000003'), YARN = Z('000000000101'), FAB = Z('000000000102'), COT = Z('000000000201'), UOM = Z('0000000000d0'), C1 = Z('000000000009');
const q = (s: string, p: any[] = []) => pool.query(s, p);
(async () => {
  // مساعد الرصيد الجاري
  const l0 = lt.runLedger([{ type: 'in', qty: 100, unitCost: 10 }, { type: 'in', qty: 100, unitCost: 20 }, { type: 'out', qty: 50, unitCost: 15 }, { type: 'out', qty: 150, unitCost: 15 }]);
  near(l0[1].avgCost, 15, 'avg after 2 receipts'); near(l0[2].balance, 150, 'balance after issue'); near(l0[2].value, 2250, 'issue at avg 15'); ok(l0[3].balance === 0 && l0[3].value === 0, 'fully issued → zero value');

  await q(`INSERT INTO items(id,company_id,item_kind,code,name_ar,name_en,base_uom_id) VALUES ($1,$2,'generic','COT','قطن','COT',$3) ON CONFLICT DO NOTHING`, [COT, ctx.companyId, UOM]);
  const bt = async (no: string) => (await q(`INSERT INTO batches(company_id,item_id,batch_no) VALUES ($1,$2,$3) RETURNING id`, [ctx.companyId, YARN, no])).rows[0].id;
  const L1 = await bt('L1'), L2 = await bt('L2');
  const mv = (b: string, t: string, qty: number, cost: number | null, d: string, st = 'posted') => q(`INSERT INTO stock_movements(company_id,branch_id,warehouse_id,item_id,batch_id,movement_type,quantity,unit_cost,movement_date,effective_date,source_document_type,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,'test',$10)`, [ctx.companyId, BR, WH, YARN, b, t, qty, cost, d, st]);
  await mv(L1, 'opening', 100, 10, '2026-10-01'); await mv(L1, 'in', 100, 20, '2026-10-05'); await mv(L1, 'out', 50, 15, '2026-10-10'); await mv(L1, 'adjustment_out', 10, 15, '2026-10-12'); await mv(L1, 'loss', 5, 15, '2026-10-13'); await mv(L1, 'in', 999, 1, '2026-10-14', 'reversed');
  await mv(L2, 'in', 40, 5, '2026-10-02'); await mv(L2, 'out', 40, 5, '2026-10-03');

  const c = await lt.lotCard(ctx, { itemId: YARN, batchNo: 'L1' });
  ok(c.movements.length === 5 && c.movements[0].label === 'رصيد افتتاحي', 'card: 5 posted movements (reversed excluded)');
  near(c.movements[1].balance, 200, 'running balance 200'); near(c.movements[1].avgCost, 15, 'avg cost 15'); near(c.movements[2].balance, 150, 'after issue 150'); near(c.movements[2].unitCost, 15, 'issue cost as recorded (15)');
  near(c.totals.received, 200, 'received 200'); near(c.totals.issued, 65, 'issued 65 (out+adjustment+loss)'); near(c.totals.balance, 135, 'final balance 135'); near(c.totals.value, 2025, 'final value 2025'); near(c.totals.avgCost, 15, 'final avg 15');
  await rej(() => lt.lotCard(ctx, { itemId: YARN, batchNo: 'NOPE' }), /غير موجود/, 'unknown lot');
  const c2 = await lt.lotCard(ctx, { itemId: YARN, batchNo: 'L2' }); ok(c2.totals.balance === 0 && c2.totals.value === 0, 'L2 fully issued');
  const s = await lt.lotsSummary(ctx, {}); ok(s.lots.length === 1 && s.lots[0].batchNo === 'L1', 'summary hides zero lots'); near(s.totals.value, 2025, 'summary value'); near(s.totals.quantity, 135, 'summary qty');
  ok((await lt.lotsSummary(ctx, { includeZero: 'true' })).lots.length === 2, 'includeZero shows L2'); ok((await lt.lotsSummary(ctx, { warehouseId: Z('0000000000ee') })).lots.length === 0, 'other warehouse empty');
  denied.add('textile.log.view'); await rej(() => lt.lotCard(ctx, { itemId: YARN, batchNo: 'L1' }), /DENIED/, 'permission'); denied.clear();

  // ===== انحراف الأسعار =====
  const PL = (await q(`INSERT INTO price_lists(company_id,name,currency_code,is_default,effective_from) VALUES ($1,'عام','EGP',true,'2026-01-01') RETURNING id`, [ctx.companyId])).rows[0].id;
  for (const [it, min, p] of [[YARN, 0, 10], [YARN, 100, 9], [FAB, 0, 100]] as const) await q(`INSERT INTO price_list_lines(price_list_id,company_id,item_id,min_quantity,unit_price) VALUES ($1,$2,$3,$4,$5)`, [PL, ctx.companyId, it, min, p]);
  await fx.setRate(ctx, { currencyCode: 'USD', rateDate: '2026-11-01', rate: 50 });
  const inv = async (no: string, cur: string, rate: number, lines: Array<[string, number, number]>) => {
    const id = (await q(`INSERT INTO sales_invoices(company_id,branch_id,warehouse_id,customer_id,fiscal_period_id,document_number,currency_code,exchange_rate,invoice_date,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'2026-11-05','posted') RETURNING id`, [ctx.companyId, BR, WH, C1, FP, no, cur, rate])).rows[0].id;
    for (const [it, qty, p] of lines) await q(`INSERT INTO sales_invoice_lines(sales_invoice_id,company_id,item_id,uom_id,quantity,unit_price,subtotal,line_total) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`, [id, ctx.companyId, it, UOM, qty, p, qty * p]);
  };
  await inv('PD-A', 'EGP', 1, [[YARN, 50, 8], [FAB, 2, 100]]); await inv('PD-B', 'EGP', 1, [[YARN, 200, 9.5]]); await inv('PD-C', 'USD', 50, [[YARN, 10, 0.18]]); await inv('PD-D', 'EGP', 1, [[COT, 5, 7]]);
  const r = await lt.priceDeviation(ctx, { from: '2026-11-01', to: '2026-11-30' });
  ok(r.lines.length === 3, 'three deviating lines (matching FAB line skipped)');
  const a = r.lines.find((x: any) => x.invoiceNo === 'PD-A'), b = r.lines.find((x: any) => x.invoiceNo === 'PD-B'), cc = r.lines.find((x: any) => x.invoiceNo === 'PD-C');
  near(a.listPrice, 10, 'A list 10'); near(a.diffPercent, -20, 'A −20%'); near(a.impactBase, -100, 'A impact −100');
  near(b.listPrice, 9, 'B uses qty-break price 9 (≥100)'); near(b.diffPercent, 5.56, 'B +5.56%', 0.01); near(b.impactBase, 100, 'B impact +100');
  near(cc.listPrice, 0.2, 'C: EGP list converted to USD at 50'); near(cc.impactBase, -10, 'C impact −10 EGP (USD diff × qty × invoice rate)', 0.001);
  ok(r.lines[0].invoiceNo === 'PD-A' && r.lines[2].invoiceNo === 'PD-B', 'sorted by impact ascending');
  near(r.totals.discounts, -110, 'discounts −110'); near(r.totals.premiums, 100, 'premiums +100'); near(r.totals.net, -10, 'net −10'); ok(r.byCustomer.length === 1 && r.byItem.length === 1, 'grouped by customer / item');
  ok(r.warnings.some((w: string) => /1 سطر بلا سعر/.test(w)), 'COT line without list price flagged');
  ok((await lt.priceDeviation(ctx, { from: '2026-11-01', to: '2026-11-30', minPercent: 12 })).lines.length === 1, 'minPercent filter');
  await q(`UPDATE customers SET price_list_id=$2 WHERE id=$1`, [C1, (await q(`INSERT INTO price_lists(company_id,name,currency_code,effective_from,effective_to) VALUES ($1,'منتهية','EGP','2025-01-01','2025-12-31') RETURNING id`, [ctx.companyId])).rows[0].id]);
  ok((await lt.priceDeviation(ctx, { from: '2026-11-01', to: '2026-11-30' })).lines.length === 3, 'expired customer list falls back to default list');
  // ===== البيع حسب نوع الدفع =====
  await q(`UPDATE sales_invoices SET payment_type='cash' WHERE document_number='PD-A'`); await q(`UPDATE sales_invoices SET payment_type='credit' WHERE document_number IN ('PD-B','PD-C')`);
  const pt = await lt.salesByPaymentType(ctx, { from: '2026-11-01', to: '2026-11-30' });
  const t = (k: string) => pt.types.find((x: any) => x.type === k);
  near(t('cash').revenue, 600, 'cash = PD-A (50×8 + 2×100)'); near(t('credit').revenue, 200 * 9.5 + 10 * 0.18 * 50, 'credit = PD-B 1900 + PD-C 90 EGP'); near(t('unspecified').revenue, 35, 'unspecified = PD-D 5×7');
  ok(t('cash').invoices === 1 && t('credit').invoices === 2 && t('unspecified').invoices === 1, 'invoice counts per type'); near(pt.totals.revenue, 600 + 1990 + 35, 'total revenue'); near(t('credit').percent, Math.round((1990 / 2625) * 1000) / 10, 'credit share %');
  ok(pt.types[0].type === 'cash' && pt.types.at(-1).type === 'unspecified', 'types ordered cash→…→unspecified'); ok(pt.customers.length === 1 && pt.customers[0].cash === 600 && !!pt.note, 'customer breakdown + unspecified note');
  ok((await lt.salesByPaymentType(ctx, { from: '2026-12-01' })).types.length === 0, 'empty period');
  console.log(`LOTS: ${pass} passed, ${fail} failed`); await pool.end(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });

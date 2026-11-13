import * as pf from '@/modules/manufacturing/textileProfitability';
import * as dl from '@/modules/manufacturing/textileDeliveryService';
import { pool } from '@/db/pool';
const Z = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`;
const ctx: any = { companyId: Z('0000000000c1'), tenantId: Z('0000000000a1'), userId: Z('000000000f00'), assertPermission() {}, visibleBranchIds: () => null };
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const near = (a: any, b: number, m: string, t = 0.01) => ok(a !== null && a !== undefined && Math.abs(Number(a) - b) <= t, `${m}: expected ${b} got ${a}`);
const BR = Z('0000000000b1'), WH = Z('000000000001'), BOM = Z('000000000002'), FP = Z('000000000003'), FAB = Z('000000000102'), YARN = Z('000000000101'), UOM = Z('0000000000d0'), C1 = Z('000000000009'), C2 = Z('000000000019'), COT = Z('000000000201');
const q = (s: string, p: any[] = []) => pool.query(s, p);
(async () => {
  ok(pf.pct(500, 1500) === 33.33 && pf.pct(1, 0) === null && pf.pct(-100, 1000) === -10, 'pct helper (incl. zero revenue & loss)');
  await q(`SET session_replication_role=replica; INSERT INTO customers(id,company_id,code,name_ar,name_en,currency_code,linked_account_id) SELECT '${C2}',company_id,'C2','عميل 2','c2',currency_code,linked_account_id FROM customers WHERE id='${C1}'; SET session_replication_role=origin;`);
  await q(`INSERT INTO items(id,company_id,item_kind,code,name_ar,name_en,base_uom_id) VALUES ($1,$2,'generic','COT','COT','COT',$3) ON CONFLICT DO NOTHING`, [COT, ctx.companyId, UOM]);
  await q(`UPDATE sales_invoices SET status='posted', invoice_date='2026-10-20' WHERE document_number='INV-1'`); await q(`UPDATE sales_invoice_lines SET cost_of_goods=1000 WHERE sales_invoice_id=$1`, [Z('0000000008a1')]);
  await q(`UPDATE sales_invoices SET status='cancelled', invoice_date='2026-10-20' WHERE document_number='INV-CANC'`);
  await q(`INSERT INTO sales_invoice_lines(sales_invoice_id,company_id,item_id,uom_id,quantity,unit_price,subtotal,line_total,cost_of_goods) VALUES ($1,$2,$3,$4,10,99.9,999,999,1)`, [Z('0000000008a2'), ctx.companyId, YARN, UOM]);
  const inv2 = (await q(`INSERT INTO sales_invoices(company_id,branch_id,warehouse_id,customer_id,fiscal_period_id,document_number,currency_code,invoice_date,status) VALUES ($1,$2,$3,$4,$5,'INV-2','EGP','2026-10-20','posted') RETURNING id`, [ctx.companyId, BR, WH, C2, FP])).rows[0].id;
  await q(`INSERT INTO sales_invoice_lines(sales_invoice_id,company_id,item_id,uom_id,quantity,unit_price,subtotal,line_total,cost_of_goods) VALUES ($1,$2,$3,$4,2,1000,2000,2000,1500),($1,$2,$5,$4,1,1000,1000,1000,NULL)`, [inv2, ctx.companyId, YARN, UOM, FAB]);
  // أمر مصدر: تكلفة الكجم = 1000/100 = 10
  const O = (await q(`INSERT INTO production_orders(company_id,branch_id,warehouse_id,bom_id,output_item_id,document_number,fiscal_period_id,order_date,currency_code,planned_output_quantity,actual_output_quantity,status,recovered_value_total,abnormal_loss_total) VALUES ($1,$2,$3,$4,$5,'P-O',$6,'2026-10-05','EGP',100,100,'posted',0,0) RETURNING id`, [ctx.companyId, BR, WH, BOM, FAB, FP])).rows[0].id;
  await q(`INSERT INTO production_order_lines(production_order_id,company_id,component_item_id,planned_quantity,consumed_quantity,line_cost) VALUES ($1,$2,$3,100,100,1000)`, [O, ctx.companyId, COT]);
  const pu = (await q(`INSERT INTO packing_units(company_id,branch_id,packing_no,unit_type,item_id,production_order_id,packages_count,gross_kg,tare_kg) VALUES ($1,$2,'PU-P','bale',$3,$4,1,61,1) RETURNING id`, [ctx.companyId, BR, FAB, O])).rows[0].id;
  const r1 = (await dl.createRollWithDefects(ctx, { rollNo: 'PR1', productionOrderId: O, itemId: FAB, lengthM: 100, widthCm: 150, weightKg: 40, defects: [] })).id;
  const r2 = (await dl.createRollWithDefects(ctx, { rollNo: 'PR2', itemId: FAB, lengthM: 50, widthCm: 150, weightKg: 20, defects: [] })).id; // بلا أمر → غير مسعَّر
  const n1 = await dl.createDeliveryNote(ctx, { branchId: BR, customerId: C1, noteDate: '2026-10-21', packingUnitIds: [pu], fabricRollIds: [r1, r2] });
  await dl.linkInvoice(ctx, n1.id, Z('0000000008a1'));
  await q(`INSERT INTO quality_claims(company_id,branch_id,claim_no,customer_id,claim_date,category,description,status,root_cause,resolution,settled_value,closed_at) VALUES ($1,$2,'CL-T',$3,'2026-10-25','shade','x','settled','سبب','credit_note',200,now())`, [ctx.companyId, BR, C1]);

  const p = await pf.profitability(ctx, { from: '2026-10-01', to: '2026-10-31' });
  const c1 = p.customers.find((c: any) => c.customerId === C1), c2 = p.customers.find((c: any) => c.customerId === C2);
  near(c1.revenue, 1500, 'C1 revenue (cancelled invoice excluded)'); near(c1.bookCogs, 1000, 'C1 COGS'); near(c1.bookMargin, 500, 'C1 margin'); near(c1.bookMarginPercent, 33.33, 'C1 margin %');
  near(c1.analyticalCost, 1000, 'C1 analytical cost = 100 kg × 10'); near(c1.analyticalMargin, 500, 'C1 analytical margin'); near(c1.analyticalCoveragePercent, 83.3, 'C1 coverage 100/120 kg', 0.1);
  near(c1.claimsSettled, 200, 'C1 settled claims'); near(c1.netMarginAfterClaims, 300, 'C1 net after claims'); near(c1.netMarginPercent, 20, 'C1 net %'); ok(c1.invoices === 1, 'C1 one invoice');
  near(c2.revenue, 3000, 'C2 revenue'); near(c2.bookCogs, 1500, 'C2 COGS (missing line = 0)'); near(c2.bookMargin, 1500, 'C2 margin'); ok(c2.analyticalCost === null && c2.analyticalCoveragePercent === null, 'C2 no delivery link → analytical null (not guessed)');
  ok(p.customers[0].customerId === C2, 'sorted by net margin desc (C2 1500 > C1 300)');
  ok(p.warnings.some((w: string) => /بلا تكلفة بضاعة/.test(w)) && p.warnings.some((w: string) => /بلا تسعير/.test(w)), 'warnings: missing COGS + unpriced deliveries');
  const yi = p.items.find((i: any) => i.itemId === YARN), fi = p.items.find((i: any) => i.itemId === FAB);
  near(yi.revenue, 3500, 'item YARN revenue 1500+2000'); near(yi.quantity, 152, 'item YARN qty 150+2'); near(yi.margin, 1000, 'item YARN margin (1500+2000)-(1000+1500)');
  near(fi.revenue, 1000, 'item FAB revenue'); near(fi.avgPrice, 1000, 'FAB avg price'); ok(p.items[0].margin >= p.items[1].margin, 'items sorted by margin');
  near(p.totals.revenue, 4500, 'totals revenue'); near(p.totals.bookMargin, 2000, 'totals margin'); near(p.totals.claimsSettled, 200, 'totals claims');
  const onlyC1 = await pf.profitability(ctx, { customerId: C1 }); ok(onlyC1.customers.length === 1, 'customer filter');
  const none = await pf.profitability(ctx, { from: '2026-11-01' }); ok(none.customers.length === 0 && none.totals.revenue === 0 && none.totals.bookMarginPercent === null, 'empty period → zeros, no NaN');
  console.log(`\nPROF RESULT: ${pass} passed, ${fail} failed`); (await import('/tmp/final/stubs/pool.js') as any).__closeAll(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e); process.exit(2); });

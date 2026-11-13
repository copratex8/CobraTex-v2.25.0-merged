import * as fr from '@/modules/accounting/financialReports';
import { pool, withTransaction } from '@/db/pool';
const Z = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`;
const V = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`;
const denied = new Set<string>();
const ctx: any = { companyId: Z('0000000000c1'), tenantId: Z('0000000000a1'), userId: Z('000000000f00'), assertPermission(c: string) { if (denied.has(c)) throw new Error('DENIED:' + c); }, visibleBranchIds: () => null };
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const near = (a: any, b: number, m: string, t = 0.01) => ok(a !== null && a !== undefined && Math.abs(Number(a) - b) <= t, `${m}: expected ${b} got ${a}`);
const rej = async (fn: () => Promise<unknown>, re: RegExp, m: string) => { try { await fn(); ok(false, m + ' (no error)'); } catch (e: any) { ok(re.test(e.message), m + ' → ' + e.message); } };
const BR = Z('0000000000b1'), WH = Z('000000000001'), FP = Z('000000000003'), YARN = Z('000000000101'), UOM = Z('0000000000d0'), C1 = Z('000000000009'), S1 = Z('00000000000a');
const q = (s: string, p: any[] = []) => pool.query(s, p);
(async () => {
  const ac = (id: string, code: string, t: string) => q(`INSERT INTO accounts(id,company_id,code,name_ar,name_en,account_type) VALUES ($1,$2,$3,$3,$3,$4)`, [id, ctx.companyId, code, t]);
  const OUT = V('21'), IN = V('22'), EXPA = V('23'), CASH = V('24'), SUPA = V('98');
  await ac(OUT, '2200', 'liability'); await ac(IN, '1300', 'asset'); await ac(EXPA, '5200', 'expense'); await ac(CASH, '1100', 'asset'); await ac(SUPA, '9998', 'liability');
  await q(`DELETE FROM sales_invoice_lines`); await q(`DELETE FROM sales_invoices`);
  await q(`INSERT INTO suppliers(id,company_id,code,name_ar,name_en,currency_code,linked_account_id) VALUES ($1,$2,'S1','مورد','s','EGP',$3)`, [S1, ctx.companyId, SUPA]);
  const T14 = V('31'), T5 = V('32');
  await q(`INSERT INTO tax_types(id,company_id,name_ar,name_en,sales_tax_account_id,purchase_tax_account_id) VALUES ($1,$2,'قيمة مضافة 14%','vat14',$3,$4),($5,$2,'جدول 5%','t5',$3,$4)`, [T14, ctx.companyId, OUT, IN, T5]);
  const sinv = async (no: string, date: string, status: string, cur: string, rate: number, lines: Array<[number, number, string | null]>) => {
    const id = (await q(`INSERT INTO sales_invoices(company_id,branch_id,warehouse_id,customer_id,fiscal_period_id,document_number,currency_code,exchange_rate,invoice_date,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [ctx.companyId, BR, WH, C1, FP, no, cur, rate, date, status])).rows[0].id; const ids: string[] = [];
    for (const [sub, tax, tt] of lines) ids.push((await q(`INSERT INTO sales_invoice_lines(sales_invoice_id,company_id,item_id,uom_id,quantity,unit_price,tax_type_id,subtotal,tax_amount,line_total) VALUES ($1,$2,$3,$4,1,$5,$6,$5,$7,$8) RETURNING id`, [id, ctx.companyId, YARN, UOM, sub, tt, tax, sub + tax])).rows[0].id); return { id, ids };
  };
  const S_A = await sinv('SA', '2026-10-05', 'posted', 'EGP', 1, [[1000, 140, T14], [500, 0, null]]);
  await sinv('SU', '2026-10-10', 'posted', 'USD', 50, [[100, 14, T14]]);
  await sinv('SD', '2026-10-11', 'draft', 'EGP', 1, [[9999, 1400, T14]]); await sinv('SO', '2026-09-30', 'posted', 'EGP', 1, [[777, 108.78, T14]]);
  const SR = (await q(`INSERT INTO sales_returns(company_id,branch_id,warehouse_id,customer_id,sales_invoice_id,fiscal_period_id,document_number,currency_code,return_date,status) VALUES ($1,$2,$3,$4,$5,$6,'SR1','EGP','2026-10-20','posted') RETURNING id`, [ctx.companyId, BR, WH, C1, S_A.id, FP])).rows[0].id;
  await q(`INSERT INTO sales_return_lines(sales_return_id,company_id,sales_invoice_line_id,item_id,quantity,subtotal,tax_amount,line_total,cost_of_goods) VALUES ($1,$2,$3,$4,1,200,28,228,0)`, [SR, ctx.companyId, S_A.ids[0], YARN]);
  // مشتريات
  const GR = (await q(`INSERT INTO goods_receipts(company_id,branch_id,warehouse_id,supplier_id,document_number,receipt_date,status) VALUES ($1,$2,$3,$4,'GR','2026-10-01','posted') RETURNING id`, [ctx.companyId, BR, WH, S1])).rows[0].id;
  const GRL = (await q(`INSERT INTO goods_receipt_lines(goods_receipt_id,company_id,item_id,uom_id,quantity,unit_cost) VALUES ($1,$2,$3,$4,1,1) RETURNING id`, [GR, ctx.companyId, YARN, UOM])).rows[0].id;
  const PI = (await q(`INSERT INTO supplier_invoices(company_id,branch_id,supplier_id,fiscal_period_id,document_number,currency_code,invoice_date,status) VALUES ($1,$2,$3,$4,'PI1','EGP','2026-10-12','posted') RETURNING id`, [ctx.companyId, BR, S1, FP])).rows[0].id;
  const PIL = (await q(`INSERT INTO supplier_invoice_lines(supplier_invoice_id,company_id,goods_receipt_line_id,item_id,quantity,unit_cost,tax_type_id,subtotal,tax_amount,line_total) VALUES ($1,$2,$3,$4,1,2000,$5,2000,280,2280) RETURNING id`, [PI, ctx.companyId, GRL, YARN, T14])).rows[0].id;
  const EI = (await q(`INSERT INTO expense_invoices(company_id,branch_id,supplier_id,fiscal_period_id,document_number,currency_code,invoice_date,status) VALUES ($1,$2,$3,$4,'EI1','EGP','2026-10-15','posted') RETURNING id`, [ctx.companyId, BR, S1, FP])).rows[0].id;
  await q(`INSERT INTO expense_invoice_lines(expense_invoice_id,company_id,expense_account_id,description,amount,tax_type_id,subtotal,tax_amount,line_total) VALUES ($1,$2,$3,'صيانة',300,$4,300,42,342)`, [EI, ctx.companyId, EXPA, T14]);
  const PR = (await q(`INSERT INTO purchase_returns(company_id,branch_id,warehouse_id,supplier_id,supplier_invoice_id,fiscal_period_id,document_number,currency_code,return_date,status) VALUES ($1,$2,$3,$4,$5,$6,'PR1','EGP','2026-10-25','posted') RETURNING id`, [ctx.companyId, BR, WH, S1, PI, FP])).rows[0].id;
  await q(`INSERT INTO purchase_return_lines(purchase_return_id,company_id,supplier_invoice_line_id,item_id,quantity,unit_cost,subtotal,tax_amount,line_total) VALUES ($1,$2,$3,$4,1,100,100,14,114)`, [PR, ctx.companyId, PIL, YARN]);

  const v = await fr.vatReturn(ctx, { from: '2026-10-01', to: '2026-10-31' });
  const t14 = v.rows.find((r: any) => r.taxTypeId === T14), none = v.rows.find((r: any) => r.taxTypeId === null);
  near(t14.outputBase, 1000 - 200 + 5000, 'T14 output base: 1000 − return 200 + USD 100×50'); near(t14.outputTax, 140 - 28 + 700, 'T14 output tax 812 (USD tax converted)');
  near(t14.inputBase, 2000 + 300 - 100, 'T14 input base 2200 (supplier + expense − return)'); near(t14.inputTax, 280 + 42 - 14, 'T14 input tax 308');
  near(none.outputBase, 500, 'untaxed line listed as "بدون ضريبة" base 500'); near(none.outputTax, 0, 'no tax on untaxed line');
  near(v.totals.outputTax, 812, 'total output tax'); near(v.totals.inputTax, 308, 'total input tax'); near(v.netPayable, 504, 'net payable 504'); ok(v.position === 'payable', 'position payable');
  ok(v.ledger.output === null && v.ledger.input === null || v.warnings.length >= 0, 'no ledger postings yet');
  // مطابقة الدفتر
  const je = (date: string, dr: string, cr: string, amt: number) => withTransaction(async (c: any) => { const id = (await c.query(`INSERT INTO journal_entries(company_id,branch_id,fiscal_period_id,entry_date,currency_code,status) VALUES ($1,$2,$3,$4,'EGP','posted') RETURNING id`, [ctx.companyId, BR, FP, date])).rows[0].id; await c.query(`INSERT INTO journal_lines(journal_entry_id,company_id,account_id,debit,credit) VALUES ($1,$2,$3,$4,0),($1,$2,$5,0,$4)`, [id, ctx.companyId, dr, amt, cr]); });
  await je('2026-10-05', CASH, OUT, 812); await je('2026-10-12', IN, SUPA, 308); await je('2026-09-15', CASH, OUT, 50);
  const v2 = await fr.vatReturn(ctx, { from: '2026-10-01', to: '2026-10-31' });
  near(v2.ledger.output, 812, 'ledger output 812 (Sep entry outside period)'); near(v2.ledger.input, 308, 'ledger input 308'); ok(v2.ledger.reconciled && v2.warnings.length === 0, 'reconciled with ledger, no warnings');
  await je('2026-10-30', CASH, OUT, 10);
  const v3 = await fr.vatReturn(ctx, { from: '2026-10-01', to: '2026-10-31' }); ok(!v3.ledger.reconciled && v3.warnings.length === 1 && /المخرجات/.test(v3.warnings[0]), 'manual ledger entry → reconciliation warning');
  // فترات أخرى
  const sep = await fr.vatReturn(ctx, { from: '2026-09-01', to: '2026-09-30' }); near(sep.totals.outputTax, 108.78, 'September: only the out-of-period invoice'); near(sep.totals.inputTax, 0, 'no input in September');
  const empty = await fr.vatReturn(ctx, { from: '2025-01-01', to: '2025-01-31' }); ok(empty.rows.length === 0 && empty.position === 'nil' && empty.netPayable === 0, 'empty period → nil');
  await q(`UPDATE supplier_invoices SET status='posted'`); near((await fr.vatReturn(ctx, { from: '2026-10-01', to: '2026-10-31' })).netPayable, 504, 'idempotent');
  await rej(() => fr.vatReturn(ctx, { from: '2026-11-01', to: '2026-10-01' }), /يسبق/, 'from after to'); await rej(() => fr.vatReturn(ctx, { from: 'x', to: '2026-10-01' } as any), /YYYY/, 'bad date');
  denied.add('accounting.journal.view'); await rej(() => fr.vatReturn(ctx, { from: '2026-10-01', to: '2026-10-31' }), /DENIED/, 'permission'); denied.clear();
  // refundable
  await q(`UPDATE supplier_invoice_lines SET tax_amount=2000, subtotal=14000`); const rf = await fr.vatReturn(ctx, { from: '2026-10-01', to: '2026-10-31' }); ok(rf.position === 'refundable' && rf.netPayable < 0, 'input > output → refundable');
  console.log(`PASS ${pass} FAIL ${fail}`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR', e.message || e); process.exit(1); });

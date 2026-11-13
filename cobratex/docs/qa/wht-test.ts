import * as wt from '@/modules/accounting/withholdingTax';
import { pool } from '@/db/pool';
const Z = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`;
const denied = new Set<string>();
const ctx: any = { companyId: Z('0000000000c1'), tenantId: Z('0000000000a1'), userId: Z('000000000f00'), assertPermission(c: string) { if (denied.has(c)) throw new Error('DENIED:' + c); }, visibleBranchIds: () => null };
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const near = (a: any, b: number, m: string) => ok(a !== null && a !== undefined && Math.abs(Number(a) - b) < 0.0001, `${m}: expected ${b} got ${a}`);
const rej = async (fn: () => Promise<unknown>, re: RegExp, m: string) => { try { await fn(); ok(false, m + ' (no error)'); } catch (e: any) { ok(re.test(e.message), m + ' → ' + e.message); } };
const BR = Z('0000000000b1'), WH = Z('000000000001'), FP = Z('000000000003'), YARN = Z('000000000101'), C1 = Z('000000000009'), S1 = Z('0000000000e1');
const V = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`;
const AR = V('99'), AP = V('9a'), WP = V('b7'), WR = V('b8'), BANK = V('b9'), EXP = V('ba');
const q = (s: string, p: any[] = []) => pool.query(s, p);
const gl = async (acc: string) => Number((await q(`SELECT COALESCE(SUM(l.debit-l.credit),0) AS n FROM journal_lines l JOIN journal_entries e ON e.id=l.journal_entry_id WHERE l.account_id=$1 AND e.status IN ('posted','reversed')`, [acc])).rows[0].n);
(async () => {
  await q(`INSERT INTO accounts(id,company_id,code,name_ar,name_en,account_type) VALUES ($1,$2,'1100','ذمم','ar','asset'),($3,$2,'2100','موردون','ap','liability'),($4,$2,'2250','ضريبة خصم مستحقة','wp','liability'),($5,$2,'1250','ضريبة خصم مدينة','wr','asset'),($6,$2,'1010','بنك','bank','asset'),($7,$2,'5000','مصروف','ex','expense') ON CONFLICT DO NOTHING`, [AR, ctx.companyId, AP, WP, WR, BANK, EXP]);
  await q(`SET session_replication_role=replica`);
  await q(`INSERT INTO suppliers(id,company_id,code,name_ar,name_en,currency_code,linked_account_id,tax_number) VALUES ($1,$2,'S1','مورد 1','s1','EGP',$3,'123456789') ON CONFLICT DO NOTHING`, [S1, ctx.companyId, AP]);
  await q(`UPDATE customers SET linked_account_id=$1 WHERE id=$2`, [AR, C1]);
  await q(`DELETE FROM sales_invoices WHERE document_number='INV-1'`).catch(() => 0);
  const si = (await q(`INSERT INTO sales_invoices(company_id,branch_id,warehouse_id,customer_id,fiscal_period_id,document_number,currency_code,invoice_date,status) VALUES ($1,$2,$3,$4,$5,'W-S1','EGP','2026-10-01','posted') RETURNING id`, [ctx.companyId, BR, WH, C1, FP])).rows[0].id;
  await q(`INSERT INTO sales_invoice_lines(sales_invoice_id,company_id,item_id,uom_id,quantity,unit_price,subtotal,line_total,cost_of_goods) VALUES ($1,$2,$3,$4,20,100,2000,2280,0)`, [si, ctx.companyId, YARN, Z('0000000000d0')]);
  const pi = (await q(`INSERT INTO supplier_invoices(company_id,branch_id,supplier_id,fiscal_period_id,document_number,currency_code,invoice_date,status) VALUES ($1,$2,$3,$4,'W-P1','EGP','2026-10-02','posted') RETURNING id`, [ctx.companyId, BR, S1, FP])).rows[0].id;
  await q(`INSERT INTO supplier_invoice_lines(supplier_invoice_id,company_id,goods_receipt_line_id,item_id,quantity,unit_cost,subtotal,line_total) VALUES ($1,$2,gen_random_uuid(),$3,10,100,1000,1140)`, [pi, ctx.companyId, YARN]);
  await q(`SET session_replication_role=origin`);

  // إعدادات وفئات
  const cats = await wt.listCategories(ctx); ok(cats.length === 5, '5 default categories seeded'); ok((await wt.listCategories(ctx)).length === 5, 'seed once');
  const svc = cats.find((c: any) => c.code === 'SERVICE'), sup = cats.find((c: any) => c.code === 'SUPPLY'); near(svc.rate_percent, 3, 'service 3%'); near(sup.rate_percent, 1, 'supply 1%');
  await rej(() => wt.saveSettings(ctx, { payableAccountId: AR }), /نوع الحساب/, 'payable account must be liability');
  await rej(() => wt.saveSettings(ctx, { receivableAccountId: AP }), /نوع الحساب/, 'receivable account must be asset');
  await rej(() => wt.apply(ctx, { direction: 'payable', invoiceId: pi, categoryId: svc.id, deductionDate: '2026-10-10' }), /غير مفعّلة/, 'disabled refused');
  await wt.saveSettings(ctx, { isEnabled: true, payableAccountId: WP, receivableAccountId: WR });
  denied.add('wht.apply'); await rej(() => wt.apply(ctx, { direction: 'payable', invoiceId: pi, categoryId: svc.id, deductionDate: '2026-10-10' }), /DENIED/, 'needs wht.apply'); denied.clear();

  // معاينة: الوعاء بدون ضريبة القيمة المضافة
  const pv = await wt.preview(ctx, { direction: 'payable', invoiceId: pi, categoryId: svc.id });
  near(pv.base, 1000, 'base excludes VAT'); near(pv.wht, 30, 'wht 3% = 30'); near(pv.remaining, 1140, 'remaining 1140'); near(pv.netToSettle, 1110, 'net 1110'); ok(!pv.exempt, 'not exempt');
  await wt.saveSettings(ctx, { baseIncludesVat: true }); near((await wt.preview(ctx, { direction: 'payable', invoiceId: pi, categoryId: svc.id })).wht, 34.2, 'base incl. VAT → 34.2'); await wt.saveSettings(ctx, { baseIncludesVat: false });
  await wt.saveSettings(ctx, { exemptThreshold: '5000' }); await rej(() => wt.apply(ctx, { direction: 'payable', invoiceId: pi, categoryId: svc.id, deductionDate: '2026-10-10' }), /حد الإعفاء/, 'below threshold exempt'); await wt.saveSettings(ctx, { exemptThreshold: '0' });
  await rej(() => wt.preview(ctx, { direction: 'payable', invoiceId: V('ee'), categoryId: svc.id }), /./, 'unknown invoice');

  // خصم من مورد
  const apB = await gl(AP), wpB = await gl(WP);
  const d1 = await wt.apply(ctx, { direction: 'payable', invoiceId: pi, categoryId: svc.id, deductionDate: '2026-10-10', certificateNo: 'WHT-001' });
  near(d1.wht_amount, 30, 'deduction 30'); near(d1.netToSettle, 1110, 'net to pay 1110'); ok(d1.status === 'posted', 'posted');
  near(await gl(AP) - apB, 30, 'supplier account debited 30'); near(await gl(WP) - wpB, -30, 'WHT payable credited 30');
  const pay = (await q(`SELECT status FROM supplier_payments WHERE id=$1`, [d1.payment_id])).rows[0]; ok(pay.status === 'posted', 'core payment posted');
  await rej(() => wt.apply(ctx, { direction: 'payable', invoiceId: pi, categoryId: svc.id, deductionDate: '2026-10-10' }), /بالفعل|يتجاوز/, 'second deduction refused');
  const rem = Number((await q(`SELECT COALESCE(SUM(allocated_amount),0) AS n FROM supplier_payment_allocations WHERE supplier_invoice_id=$1`, [pi])).rows[0].n); near(rem, 30, 'allocation 30 on invoice');

  // عكس
  await rej(() => wt.reverse(ctx, d1.id, { reason: 'x' }), /./, 'reason min length');
  denied.add('wht.reverse'); await rej(() => wt.reverse(ctx, d1.id, { reason: 'خطأ في الفئة' }), /DENIED/, 'needs wht.reverse'); denied.clear();
  const rv = await wt.reverse(ctx, d1.id, { reason: 'خطأ في الفئة' }); ok(rv.status === 'reversed', 'reversed');
  near(await gl(AP) - apB, 0, 'AP back to start'); near(await gl(WP) - wpB, 0, 'WHT payable back to start');
  await rej(() => wt.reverse(ctx, d1.id, { reason: 'مرة ثانية' }), /معكوس/, 'double reverse refused');
  const d2 = await wt.apply(ctx, { direction: 'payable', invoiceId: pi, categoryId: svc.id, deductionDate: '2026-10-12', certificateNo: 'WHT-002' }); ok(d2.status === 'posted', 're-apply after reverse OK');

  // خصم عميل (إضافة)
  const arB = await gl(AR), wrB = await gl(WR);
  const d3 = await wt.apply(ctx, { direction: 'receivable', invoiceId: si, categoryId: sup.id, deductionDate: '2026-10-15' });
  near(d3.wht_amount, 20, 'customer deduction 1% of 2000 = 20'); near(await gl(WR) - wrB, 20, 'WHT receivable debited 20'); near(await gl(AR) - arB, -20, 'customer account credited 20');

  // الفترة غير المغطاة
  await rej(() => wt.apply(ctx, { direction: 'payable', invoiceId: pi, categoryId: svc.id, deductionDate: '2027-06-01' }), /./, 'duplicate/uncovered date refused');

  // تقرير
  const rp = await wt.report(ctx, { from: '2026-10-01', to: '2026-10-31', direction: 'payable' });
  ok(rp.items.length === 1 && rp.items[0].certificateNo === 'WHT-002' && rp.items[0].taxNumber === '123456789', 'report lists active deduction with tax no.');
  near(rp.totals.wht, 30, 'report total 30'); near(rp.totals.unremitted, 30, 'unremitted 30'); ok(rp.byCategory[0].name === 'SERVICE' && rp.missingCertificates === 0, 'by category / certificates');
  const rr = await wt.report(ctx, { from: '2026-10-01', to: '2026-10-31', direction: 'receivable' }); near(rr.totals.wht, 20, 'receivable report 20');

  // سداد للمصلحة
  await rej(() => wt.remit(ctx, { from: '2026-11-01', to: '2026-11-30', bankAccountId: BANK, remitDate: '2026-11-05' }), /لا خصومات/, 'nothing to remit');
  await rej(() => wt.remit(ctx, { from: '2026-10-01', to: '2026-10-31', bankAccountId: WP, remitDate: '2026-10-31' }), /غير صالح/, 'bank must be asset');
  denied.add('wht.remit'); await rej(() => wt.remit(ctx, { from: '2026-10-01', to: '2026-10-31', bankAccountId: BANK, remitDate: '2026-10-31' }), /DENIED/, 'needs wht.remit'); denied.clear();
  const wpB2 = await gl(WP), bkB = await gl(BANK);
  const rm = await wt.remit(ctx, { from: '2026-10-01', to: '2026-10-31', bankAccountId: BANK, remitDate: '2026-10-31' });
  near(rm.total, 30, 'remitted 30'); near(await gl(WP) - wpB2, 30, 'WHT payable cleared'); near(await gl(BANK) - bkB, -30, 'bank credited');
  await rej(() => wt.remit(ctx, { from: '2026-10-01', to: '2026-10-31', bankAccountId: BANK, remitDate: '2026-10-31' }), /لا خصومات/, 'no double remit');
  await rej(() => wt.reverse(ctx, d2.id, { reason: 'بعد السداد' }), /سُدِّد/, 'remitted deduction not reversible');
  near((await wt.report(ctx, { from: '2026-10-01', to: '2026-10-31', direction: 'payable' })).totals.unremitted, 0, 'unremitted 0');

  console.log(`PASS ${pass} FAIL ${fail}`); await pool.end?.(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

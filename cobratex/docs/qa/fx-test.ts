import * as fx from '@/modules/accounting/fxRatesService';
import * as pf from '@/modules/manufacturing/textileProfitability';
import { pool } from '@/db/pool';
const Z = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`;
const ctx: any = { companyId: Z('0000000000c1'), tenantId: Z('0000000000a1'), userId: Z('000000000f00'), assertPermission() {}, visibleBranchIds: () => null };
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const near = (a: any, b: number, m: string, t = 0.0001) => ok(a !== null && a !== undefined && Math.abs(Number(a) - b) <= t, `${m}: expected ${b} got ${a}`);
const rej = async (f: () => Promise<any>, re: RegExp, m: string) => { try { await f(); ok(false, m + ' (should reject)'); } catch (e: any) { ok(re.test(String(e.message)), m + ' msg=' + e.message); } };
const BR = Z('0000000000b1'), WH = Z('000000000001'), FP = Z('000000000003'), YARN = Z('000000000101'), UOM = Z('0000000000d0'), C1 = Z('000000000009'), S1 = Z('0000000000e1');
const q = (s: string, p: any[] = []) => pool.query(s, p);
(async () => {
  const cur = await fx.listCurrencies(ctx);
  ok(cur[0].code === 'EGP' && cur[0].isBase, 'base currency first'); ok(['USD', 'EUR', 'SAR', 'AED', 'GBP', 'CNY', 'TRY', 'KWD'].every((c) => cur.some((x: any) => x.code === c)), 'extended currency list seeded');
  await rej(() => fx.upsertCurrency(ctx, { code: 'EGP', name: 'x', isActive: false }), /الأساس/, 'cannot deactivate base');
  await fx.upsertCurrency(ctx, { code: 'XAU', name: 'Gold', nameAr: 'ذهب', decimals: 4 }); ok((await fx.listCurrencies(ctx)).some((c: any) => c.code === 'XAU' && c.decimals === 4), 'custom currency added');
  await rej(() => fx.setRate(ctx, { currencyCode: 'EGP', rateDate: '2026-10-01', rate: 1 }), /الأساس/, 'no rate for base');
  await rej(() => fx.setRate(ctx, { currencyCode: 'ZZZ', rateDate: '2026-10-01', rate: 1 }), /غير معرَّفة/, 'unknown currency');
  await fx.upsertCurrency(ctx, { code: 'XAU', name: 'Gold', isActive: false }); await rej(() => fx.setRate(ctx, { currencyCode: 'XAU', rateDate: '2026-10-01', rate: 5 }), /معطَّلة/, 'inactive currency rejected');

  await fx.setRate(ctx, { currencyCode: 'USD', rateDate: '2026-10-01', rate: 50 });
  const w = await fx.setRate(ctx, { currencyCode: 'USD', rateDate: '2026-10-10', rate: 52 }); ok(w.warning === null, 'small move no warning');
  const w2 = await fx.setRate(ctx, { currencyCode: 'USD', rateDate: '2026-10-20', rate: 60 }); ok(/%/.test(w2.warning), 'large jump warns (15%)');
  await fx.setRate(ctx, { currencyCode: 'USD', rateDate: '2026-10-10', rateType: 'sell', rate: 52.5 }); await fx.setRate(ctx, { currencyCode: 'USD', rateDate: '2026-10-10', rateType: 'buy', rate: 51.5 });
  await fx.setRate(ctx, { currencyCode: 'USD', rateDate: '2026-10-10', rate: 52.2 }); ok((await fx.listRates(ctx, { currency: 'USD', from: '2026-10-10', to: '2026-10-10' })).length === 3, 'upsert same day/type replaces (3 rows: mid/buy/sell)');
  const bulk = await fx.setRates(ctx, { rates: [{ currencyCode: 'EUR', rateDate: '2026-10-10', rate: 57 }, { currencyCode: 'SAR', rateDate: '2026-10-10', rate: 13.9 }] }); ok(bulk.saved === 2, 'bulk save');
  await rej(() => fx.setRates(ctx, { rates: [{ currencyCode: 'GBP', rateDate: '2026-10-10', rate: 65 }, { currencyCode: 'EGP', rateDate: '2026-10-10', rate: 1 }] }), /الأساس/, 'bulk atomic failure');
  ok((await fx.listRates(ctx, { currency: 'GBP' })).length === 0, 'bulk rolled back (no GBP row)');

  // البحث: الأحدث ≤ التاريخ، والنوع ثم mid
  near((await fx.getRate(ctx, { currency: 'USD', date: '2026-10-15', type: 'sell' })).rate, 52.5, 'sell on 15th = 52.5');
  near((await fx.getRate(ctx, { currency: 'USD', date: '2026-10-15', type: 'buy' })).rate, 51.5, 'buy on 15th = 51.5');
  near((await fx.getRate(ctx, { currency: 'USD', date: '2026-10-15' })).rate, 52.2, 'mid on 15th = 52.2');
  near((await fx.getRate(ctx, { currency: 'USD', date: '2026-10-25', type: 'sell' })).rate, 60, 'sell falls back to newer mid (60 on 20th)');
  const old = await fx.getRate(ctx, { currency: 'USD', date: '2026-10-30' }); ok(old.stale && old.ageDays === 10, 'stale flag after 10 days');
  const bs = await fx.getRate(ctx, { currency: 'EGP', date: '2026-10-30' }); ok(bs.rate === 1 && !bs.stale, 'base = 1');
  await rej(() => fx.getRate(ctx, { currency: 'USD', date: '2026-09-01' }), /لا سعر/, 'no rate before first date');
  // تحويل مركّب
  const cv = await fx.convert(ctx, { amount: 100, from: 'USD', to: 'EUR', date: '2026-10-10' }); near(cv.rate, 52.2 / 57, 'cross USD→EUR', 1e-5); near(cv.result, 100 * 52.2 / 57, 'cross result', 1e-3);
  near((await fx.convert(ctx, { amount: 100, from: 'USD', to: 'EGP', date: '2026-10-10' })).result, 5220, 'USD→EGP'); near((await fx.convert(ctx, { amount: 5220, from: 'EGP', to: 'USD', date: '2026-10-10' })).result, 100, 'EGP→USD');

  // resolveDocumentRate
  ok(await fx.resolveDocumentRate(ctx, 'EGP', '2026-10-10', undefined, 'sell') === '1', 'base → 1');
  ok(await fx.resolveDocumentRate(ctx, 'USD', '2026-10-10', undefined, 'sell') === '52.5', 'omitted → sell table');
  ok(await fx.resolveDocumentRate(ctx, 'USD', '2026-10-10', undefined, 'buy') === '51.5', 'omitted → buy table');
  ok(await fx.resolveDocumentRate(ctx, 'USD', '2026-10-10', '53', 'sell') === '53', 'explicit within 30% accepted');
  ok(await fx.resolveDocumentRate(ctx, 'USD', '2026-10-10', '1', 'sell') === '1', "explicit '1' kept (legacy)");
  await rej(() => fx.resolveDocumentRate(ctx, 'USD', '2026-10-10', '5', 'sell'), /30%/, 'absurd manual rate rejected');
  await rej(() => fx.resolveDocumentRate(ctx, 'USD', '2026-10-10', '-3', 'sell'), /موجبًا/, 'negative rejected');
  await rej(() => fx.resolveDocumentRate(ctx, 'CNY', '2026-10-10', undefined, 'sell'), /لا يوجد سعر/, 'omitted + no table → explicit error, not silent 1');
  ok(await fx.resolveDocumentRate(ctx, 'CNY', '2026-10-10', '7.2', 'sell') === '7.2', 'explicit accepted when no table rate');

  // الربط بإنشاء مستند حقيقي (فاتورة مبيعات/مدفوعات) عبر SQL مكافئ: نتحقق من أن الخدمة المعدّلة تقرأ الجدول
  // التقييم: فاتورة مدينة 100$ بسعر 50 ؛ سداد جزئي 40$ ؛ دائنة 200$ بسعر 51
  const base0 = await pf.profitability(ctx, { from: '2026-10-01', to: '2026-10-31' }); const b0 = base0.customers.find((x: any) => x.customerId === C1) ?? { revenue: 0, bookCogs: 0, bookMargin: 0 };
  const inv = (await q(`INSERT INTO sales_invoices(company_id,branch_id,warehouse_id,customer_id,fiscal_period_id,document_number,currency_code,exchange_rate,invoice_date,status) VALUES ($1,$2,$3,$4,$5,'USD-1','USD',50,'2026-10-01','posted') RETURNING id`, [ctx.companyId, BR, WH, C1, FP])).rows[0].id;
  await q(`INSERT INTO sales_invoice_lines(sales_invoice_id,company_id,item_id,uom_id,quantity,unit_price,subtotal,line_total,cost_of_goods) VALUES ($1,$2,$3,$4,10,10,100,100,300)`, [inv, ctx.companyId, YARN, UOM]);
  await q(`SET session_replication_role=replica`);
  await q(`INSERT INTO suppliers(id,company_id,code,name_ar,name_en,currency_code,linked_account_id) VALUES ($1,$2,'S1','مورد 1','s1','USD',$3)`, [S1, ctx.companyId, Z('000000000099')]);
  await q(`INSERT INTO customer_payments(id,company_id,branch_id,customer_id,fiscal_period_id,document_number,currency_code,exchange_rate,payment_date,amount,receipt_account_id,status) VALUES ($1,$2,$3,$4,$5,'RCT-X','USD',50,'2026-10-05',40,$6,'posted')`, [Z('0000000000f1'), ctx.companyId, BR, C1, FP, Z('000000000099')]).catch((e: any) => console.log('PAY_ERR', e.message));
  await q(`INSERT INTO customer_payment_allocations(id,company_id,customer_payment_id,sales_invoice_id,allocated_amount) VALUES (gen_random_uuid(),$1,$3,$2,40)`, [ctx.companyId, inv, Z('0000000000f1')]).catch(async (e: any) => { console.log('ALLOC_INSERT_ERR', e.message); });
  const si = (await q(`INSERT INTO supplier_invoices(company_id,branch_id,supplier_id,fiscal_period_id,document_number,currency_code,exchange_rate,invoice_date,status) VALUES ($1,$2,$3,$4,'SUP-USD','USD',51,'2026-10-02','posted') RETURNING id`, [ctx.companyId, BR, S1, FP])).rows[0].id;
  await q(`INSERT INTO supplier_invoice_lines(supplier_invoice_id,company_id,goods_receipt_line_id,item_id,quantity,unit_cost,subtotal,line_total) VALUES ($1,$2,gen_random_uuid(),$3,20,10,200,200)`, [si, ctx.companyId, YARN]);
  await q(`SET session_replication_role=origin`);
  const rv = await fx.revaluation(ctx, { asOf: '2026-10-25' });
  const r1 = rv.documents.find((d: any) => d.documentNumber === 'USD-1'), r2 = rv.documents.find((d: any) => d.documentNumber === 'SUP-USD');
  ok(!!r1 && !!r2, 'both foreign docs in reval');
  if (r1) { near(r1.outstanding, 60, 'receivable outstanding 100-40'); near(r1.bookBase, 3000, 'book base 60×50'); near(r1.revaluedBase, 3600, 'reval base 60×60'); near(r1.unrealizedGainLoss, 600, 'receivable unrealized gain +600'); }
  if (r2) { near(r2.outstanding, 200, 'payable outstanding'); near(r2.bookBase, 10200, 'payable book 200×51'); near(r2.revaluedBase, 12000, 'payable reval 200×60'); near(r2.unrealizedGainLoss, -1800, 'payable loss −1800 (rate rose)'); }
  near(rv.netUnrealized, -1200, 'net unrealized −1200'); ok(rv.byCurrency.length === 1 && rv.byCurrency[0].currency === 'USD', 'grouped by currency');
  ok(rv.warnings.some((x: string) => /قديم/.test(x)), 'rate of 20th is stale at 25th (5 days > 3)');
  const rv2 = await fx.revaluation(ctx, { asOf: '2026-10-01' }); ok(!rv2.documents.some((d: any) => d.documentNumber === 'SUP-USD'), 'invoice dated after as-of excluded');
  const rv3 = await fx.revaluation(ctx, { asOf: '2026-12-30' }); ok(rv3.warnings.some((x: string) => /قديم/.test(x)), 'stale warning in Dec');

  // الربحية: فاتورة 100$ بسعر 50 → إيراد 5000 ج.م (لا 100)
  const p = await pf.profitability(ctx, { from: '2026-10-01', to: '2026-10-31' });
  const c = p.customers.find((x: any) => x.customerId === C1); near(c.revenue - b0.revenue, 5000, 'profitability converts USD revenue at invoice rate'); near(c.bookCogs - b0.bookCogs, 300, 'COGS stays base'); near(c.bookMargin - b0.bookMargin, 4700, 'margin in base');
  console.log(`FX: ${pass} passed, ${fail} failed`); await pool.end(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });

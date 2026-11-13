import * as cn from '@/modules/manufacturing/textileCreditNote';
import * as fp from '@/modules/accounting/fxRevalPosting';
import * as fx from '@/modules/accounting/fxRatesService';
import { pool } from '@/db/pool';
const Z = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`;
const denied = new Set<string>();
const ctx: any = { companyId: Z('0000000000c1'), tenantId: Z('0000000000a1'), userId: Z('000000000f00'), assertPermission(c: string) { if (denied.has(c)) throw new Error('DENIED:' + c); }, visibleBranchIds: () => null };
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const near = (a: any, b: number, m: string) => ok(a !== null && a !== undefined && Math.abs(Number(a) - b) < 0.0001, `${m}: expected ${b} got ${a}`);
const rej = async (fn: () => Promise<unknown>, re: RegExp, m: string) => { try { await fn(); ok(false, m + ' (no error)'); } catch (e: any) { ok(re.test(e.message), m + ' → ' + e.message); } };
const BR = Z('0000000000b1'), WH = Z('000000000001'), FP = Z('000000000003'), YARN = Z('000000000101'), UOM = Z('0000000000d0'), C1 = Z('000000000009'), C2 = Z('000000000019'), S1 = Z('0000000000e1');
const AR = Z('000000000099'), AP = Z('00000000009a'), ALLOW = Z('0000000000a7'), FXU = Z('0000000000a8');
const q = (s: string, p: any[] = []) => pool.query(s, p);
const gl = async (acc: string) => { const r = (await q(`SELECT COALESCE(SUM(l.debit-l.credit),0) AS n FROM journal_lines l JOIN journal_entries e ON e.id=l.journal_entry_id WHERE l.account_id=$1 AND e.status IN ('posted','reversed')`, [acc])).rows[0]; return Number(r.n); };
(async () => {
  await q(`INSERT INTO accounts(id,company_id,code,name_ar,name_en,account_type) VALUES ($1,$2,'1100','ذمم','ar','asset'),($3,$2,'2100','موردون','ap','liability'),($4,$2,'4900','مسموحات','allow','revenue'),($5,$2,'7900','فروق تقييم','fxu','expense') ON CONFLICT DO NOTHING`, [AR, ctx.companyId, AP, ALLOW, FXU]);
  const claim = async (no: string, status: string, res: string | null, val: number | null, cust = C1) => (await q(`INSERT INTO quality_claims(company_id,branch_id,claim_no,customer_id,claim_date,category,description,status,resolution,settled_value,root_cause,closed_at) VALUES ($1,$2,$3,$4,'2026-10-25','shade','x',$5,$6,$7,$8,${status === 'settled' ? 'now()' : 'NULL'}) RETURNING id`, [ctx.companyId, BR, no, cust, status, res, val, status === 'settled' ? 'سبب' : null])).rows[0].id;
  const cOpen = await claim('CL-O', 'open', null, null), cCred = await claim('CL-C', 'settled', 'credit_note', 200), cDisc = await claim('CL-D', 'settled', 'discount', 50), cCred2 = await claim('CL-C2', 'settled', 'credit_note', 75);
  await rej(() => cn.issueCreditNote(ctx, cOpen, {}), /مسوّاة/, 'open claim cannot get credit note');
  await rej(() => cn.issueCreditNote(ctx, cDisc, {}), /ليس «إشعار دائن»/, 'discount resolution rejected');
  await rej(() => cn.issueCreditNote(ctx, cCred, { noteDate: '2026-10-26' }), /حساب مسموحات/, 'no allowance account → clear error');
  await rej(() => fp.setAccounts(ctx, { salesAllowanceAccountId: Z('0000000000ff') }), /غير موجود/, 'unknown account rejected');
  await fp.setAccounts(ctx, { salesAllowanceAccountId: ALLOW, fxUnrealizedAccountId: FXU }); ok((await fp.getAccounts(ctx)).sales_allowance_account_id === ALLOW, 'accounts saved');
  denied.add('textile.claims.credit'); await rej(() => cn.issueCreditNote(ctx, cCred, {}), /DENIED/, 'needs claims.credit'); denied.clear();
  await rej(() => cn.issueCreditNote(ctx, cCred, { noteDate: '2027-05-01' }), /فترة مالية/, 'date outside any fiscal period');
  ok((await q(`SELECT 1 FROM claim_credit_notes`)).rows.length === 0, 'failed issue left no note (rolled back)');

  const n1 = await cn.issueCreditNote(ctx, cCred, { noteDate: '2026-10-26', reason: 'لون' });
  ok(/^CN-/.test(n1.note_no) && n1.status === 'posted' && Number(n1.amount) === 200, 'note issued CN-… 200');
  const je = (await q(`SELECT e.status, e.source_document_type, e.entry_date FROM journal_entries e WHERE e.id=$1`, [n1.journal_entry_id])).rows[0]; ok(je.status === 'posted' && je.source_document_type === 'claim_credit_note', 'journal posted');
  near(await gl(ALLOW), 200, 'allowance debited 200'); near(await gl(AR), -200, 'customer account credited 200');
  await rej(() => cn.issueCreditNote(ctx, cCred, {}), /صدر إشعار دائن/, 'second active note refused');
  // فاتورة مرجعية
  const inv = (await q(`INSERT INTO sales_invoices(company_id,branch_id,warehouse_id,customer_id,fiscal_period_id,document_number,currency_code,invoice_date,status) VALUES ($1,$2,$3,$4,$5,'REF-1','EGP','2026-10-01','posted') RETURNING id`, [ctx.companyId, BR, WH, C1, FP])).rows[0].id;
  await q(`SET session_replication_role=replica; INSERT INTO customers(id,company_id,code,name_ar,name_en,currency_code,linked_account_id) VALUES ('${C2}','${ctx.companyId}','C2','عميل 2','c2','EGP','${AR}'); SET session_replication_role=origin;`);
  const invOther = (await q(`INSERT INTO sales_invoices(company_id,branch_id,warehouse_id,customer_id,fiscal_period_id,document_number,currency_code,invoice_date,status) VALUES ($1,$2,$3,$4,$5,'REF-2','EGP','2026-10-01','posted') RETURNING id`, [ctx.companyId, BR, WH, C2, FP])).rows[0].id;
  await rej(() => cn.issueCreditNote(ctx, cCred2, { salesInvoiceId: invOther }), /لعميل آخر/, 'invoice of another customer rejected');
  const n2 = await cn.issueCreditNote(ctx, cCred2, { salesInvoiceId: inv, noteDate: '2026-10-27' }); ok(n2.sales_invoice_id === inv && n2.note_no !== n1.note_no, 'second note references invoice, new number');
  ok((await cn.listCreditNotes(ctx, { customerId: C1 })).length === 2 && (await cn.listCreditNotes(ctx, { claimId: cCred })).length === 1, 'list filters');
  near(await gl(ALLOW), 275, 'allowance total 275');
  // عكس
  const rv = await cn.reverseCreditNote(ctx, n1.id, { reason: 'خطأ في القيمة' }); ok(rv.status === 'reversed' && !!rv.reversal_entry_id, 'note reversed');
  near(await gl(ALLOW), 75, 'allowance after reversal 75'); await rej(() => cn.reverseCreditNote(ctx, n1.id, { reason: 'مرة ثانية' }), /معكوس/, 'double reverse refused');
  const n3 = await cn.issueCreditNote(ctx, cCred, { noteDate: '2026-10-28' }); ok(n3.status === 'posted' && n3.note_no !== n1.note_no, 're-issue allowed after reversal');

  // ===== ترحيل تقييم العملات =====
  await fx.setRate(ctx, { currencyCode: 'USD', rateDate: '2026-10-01', rate: 50 }); await fx.setRate(ctx, { currencyCode: 'USD', rateDate: '2026-10-20', rate: 60 });
  const si = (await q(`INSERT INTO sales_invoices(company_id,branch_id,warehouse_id,customer_id,fiscal_period_id,document_number,currency_code,exchange_rate,invoice_date,status) VALUES ($1,$2,$3,$4,$5,'USD-1','USD',50,'2026-10-01','posted') RETURNING id`, [ctx.companyId, BR, WH, C1, FP])).rows[0].id;
  await q(`INSERT INTO sales_invoice_lines(sales_invoice_id,company_id,item_id,uom_id,quantity,unit_price,subtotal,line_total,cost_of_goods) VALUES ($1,$2,$3,$4,10,10,100,100,300)`, [si, ctx.companyId, YARN, UOM]);
  await q(`SET session_replication_role=replica`);
  await q(`INSERT INTO suppliers(id,company_id,code,name_ar,name_en,currency_code,linked_account_id) VALUES ($1,$2,'S1','مورد 1','s1','USD',$3)`, [S1, ctx.companyId, AP]);
  await q(`INSERT INTO customer_payments(id,company_id,branch_id,customer_id,fiscal_period_id,document_number,currency_code,exchange_rate,payment_date,amount,receipt_account_id,status) VALUES ($1,$2,$3,$4,$5,'RCT-X','USD',50,'2026-10-05',40,$6,'posted')`, [Z('0000000000f1'), ctx.companyId, BR, C1, FP, AR]);
  await q(`INSERT INTO customer_payment_allocations(id,company_id,customer_payment_id,sales_invoice_id,allocated_amount) VALUES (gen_random_uuid(),$1,$2,$3,40)`, [ctx.companyId, Z('0000000000f1'), si]);
  const sp = (await q(`INSERT INTO supplier_invoices(company_id,branch_id,supplier_id,fiscal_period_id,document_number,currency_code,exchange_rate,invoice_date,status) VALUES ($1,$2,$3,$4,'SUP-USD','USD',51,'2026-10-02','posted') RETURNING id`, [ctx.companyId, BR, S1, FP])).rows[0].id;
  await q(`INSERT INTO supplier_invoice_lines(supplier_invoice_id,company_id,goods_receipt_line_id,item_id,quantity,unit_cost,subtotal,line_total) VALUES ($1,$2,gen_random_uuid(),$3,20,10,200,200)`, [sp, ctx.companyId, YARN]);
  await q(`SET session_replication_role=origin`);
  const arBefore = await gl(AR), apBefore = await gl(AP), fxBefore = await gl(FXU);

  await q(`UPDATE companies SET fx_unrealized_account_id=NULL WHERE id=$1`, [ctx.companyId]); await rej(() => fp.postRevaluation(ctx, { asOf: '2026-10-25' }), /حساب فروق التقييم/, 'needs unrealized account');
  await fp.setAccounts(ctx, { fxUnrealizedAccountId: FXU });
  denied.add('fx.reval.post'); await rej(() => fp.postRevaluation(ctx, { asOf: '2026-10-25' }), /DENIED/, 'needs fx.reval.post'); denied.clear();
  await rej(() => fp.postRevaluation(ctx, { asOf: '2026-10-25', reversalDate: '2026-10-25' }), /يلي/, 'reversal date must follow as-of');
  await rej(() => fp.postRevaluation(ctx, { asOf: '2026-10-25', reversalDate: '2027-02-01' }), /فترة مالية/, 'reversal outside periods → whole post rolled back');
  ok((await q(`SELECT 1 FROM fx_revaluations`)).rows.length === 0 && (await q(`SELECT 1 FROM journal_entries WHERE source_document_type LIKE 'fx_revaluation%'`)).rows.length === 0, 'rollback left nothing');
  const p1 = await fp.postRevaluation(ctx, { asOf: '2026-10-25' });
  near(p1.net_amount, -1200, 'net −1200'); ok(p1.status === 'posted' && p1.lines === 3, '3 lines (AR, AP, unrealized)');
  near(await gl(AR) - arBefore, 600, 'AR +600 (receivable gain)'); near(await gl(AP) - apBefore, -1800, 'AP credited 1800 (payable loss)'); near(await gl(FXU) - fxBefore, 1200, 'unrealized account debited 1200 (net loss)');
  await rej(() => fp.postRevaluation(ctx, { asOf: '2026-10-26' }), /لم يُعكس/, 'only one active revaluation');
  await rej(() => fp.reverseRevaluation(ctx, p1.id, { reversalDate: '2026-10-25' }), /يلي/, 'reverse date must follow');
  const r1 = await fp.reverseRevaluation(ctx, p1.id, { reversalDate: '2026-11-01' }); ok(r1.status === 'reversed' && !!r1.reversal_entry_id, 'reversed');
  near(await gl(AR) - arBefore, 0, 'AR back to zero effect'); near(await gl(AP) - apBefore, 0, 'AP back'); near(await gl(FXU) - fxBefore, 0, 'unrealized back');
  await rej(() => fp.reverseRevaluation(ctx, p1.id, { reversalDate: '2026-11-02' }), /معكوس/, 'double reverse refused');
  const p2 = await fp.postRevaluation(ctx, { asOf: '2026-10-30', reversalDate: '2026-11-01' }); ok(p2.status === 'reversed' && p2.reversal_date !== null, 'post with auto-reversal date → both entries in one go');
  near(await gl(AR) - arBefore, 0, 'auto-reversed: net zero'); ok((await fp.listRevaluations(ctx)).length === 2, 'history lists both');
  const eb = (await q(`SELECT e.id, SUM(l.debit)-SUM(l.credit) AS d FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id=e.id WHERE e.source_document_type LIKE 'fx_revaluation%' GROUP BY e.id`)).rows; ok(eb.length === 4 && eb.every((x: any) => Math.abs(Number(x.d)) < 0.00001), 'all 4 FX entries balanced');
  // لا فروق
  await q(`UPDATE sales_invoices SET status='cancelled' WHERE id=$1`, [si]); await q(`UPDATE supplier_invoices SET status='cancelled' WHERE id=$1`, [sp]);
  await rej(() => fp.postRevaluation(ctx, { asOf: '2026-10-30' }), /لا فروق/, 'nothing to revalue');
  console.log(`CREDITFX: ${pass} passed, ${fail} failed`); await pool.end(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });

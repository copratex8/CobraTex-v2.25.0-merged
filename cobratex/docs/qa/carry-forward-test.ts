import * as cf from '@/modules/accounting/carryForward';
import * as pc from '@/modules/accounting/periodClosing';
import { postBaseEntry } from '@/modules/accounting/postingHelper';
import { pool, withTransaction } from '@/db/pool';
const Z = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`;
const V = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`;
const denied = new Set<string>();
const ctx: any = { companyId: Z('0000000000c1'), tenantId: Z('0000000000a1'), userId: Z('000000000f00'), assertPermission(c: string) { if (denied.has(c)) throw new Error('DENIED:' + c); }, visibleBranchIds: () => null };
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const near = (a: any, b: number, m: string, t = 0.01) => ok(a !== null && a !== undefined && Math.abs(Number(a) - b) <= t, `${m}: expected ${b} got ${a}`);
const rej = async (fn: () => Promise<unknown>, re: RegExp, m: string) => { try { await fn(); ok(false, m + ' (no error)'); } catch (e: any) { ok(re.test(e.message), m + ' → ' + e.message); } };
const BR = Z('0000000000b1'), FP = Z('000000000003'), WH = Z('000000000001'), C1 = Z('000000000009'), YARN = Z('000000000101'), UOM = Z('0000000000d0'), S1 = V('e1');
const q = (s: string, p: any[] = []) => pool.query(s, p);
(async () => {
  const ac = (id: string, code: string, t: string) => q(`INSERT INTO accounts(id,company_id,code,name_ar,name_en,account_type) VALUES ($1,$2,$3,$3,$3,$4)`, [id, ctx.companyId, code, t]);
  const REV = V('71'), EXP = V('73'), RE = V('75'), CASH = V('76'), AR = V('77'), AP = V('78');
  await ac(REV, '4100', 'revenue'); await ac(EXP, '5100', 'expense'); await ac(RE, '3200', 'equity'); await ac(CASH, '1100', 'asset'); await ac(AR, '1200', 'asset'); await ac(AP, '2100', 'liability');
  const post = (date: string, dr: string, cr: string, amt: number) => withTransaction(async (c: any) => postBaseEntry(ctx, c, { branchId: BR, date, sourceType: 'test', lines: [{ accountId: dr, debit: String(amt), credit: '0', description: 't' }, { accountId: cr, debit: '0', credit: String(amt), description: 't' }] }));
  await q(`SET session_replication_role=replica`);
  await q(`UPDATE customers SET linked_account_id=$1 WHERE id=$2`, [AR, C1]); await q(`DELETE FROM sales_invoices WHERE document_number='INV-1'`);
  await q(`INSERT INTO suppliers(id,company_id,code,name_ar,name_en,currency_code,linked_account_id) VALUES ($1,$2,'S1','مورد 1','s1','EGP',$3)`, [S1, ctx.companyId, AP]);
  const si = (await q(`INSERT INTO sales_invoices(company_id,branch_id,warehouse_id,customer_id,fiscal_period_id,document_number,currency_code,invoice_date,status) VALUES ($1,$2,$3,$4,$5,'CF-S1','EGP','2026-09-01','posted') RETURNING id`, [ctx.companyId, BR, WH, C1, FP])).rows[0].id;
  await q(`INSERT INTO sales_invoice_lines(sales_invoice_id,company_id,item_id,uom_id,quantity,unit_price,subtotal,line_total,cost_of_goods) VALUES ($1,$2,$3,$4,15,100,1500,1500,0)`, [si, ctx.companyId, YARN, UOM]);
  const pi = (await q(`INSERT INTO supplier_invoices(company_id,branch_id,supplier_id,fiscal_period_id,document_number,currency_code,invoice_date,status) VALUES ($1,$2,$3,$4,'CF-P1','EGP','2026-09-05','posted') RETURNING id`, [ctx.companyId, BR, S1, FP])).rows[0].id;
  await q(`INSERT INTO supplier_invoice_lines(supplier_invoice_id,company_id,goods_receipt_line_id,item_id,quantity,unit_cost,subtotal,line_total) VALUES ($1,$2,gen_random_uuid(),$3,8,100,800,800)`, [pi, ctx.companyId, YARN]);
  // مخزون: وارد 100 بتكلفة 10، صادر 30
  const mv = async (type: string, qty: number, date: string) => (await q(`INSERT INTO stock_movements(company_id,branch_id,warehouse_id,item_id,movement_type,quantity,unit_cost,movement_date,effective_date,source_document_type) VALUES ($1,$2,$3,$4,$5,$6,10,$7,$7,'test') RETURNING id`, [ctx.companyId, BR, WH, YARN, type, qty, date])).rows[0].id;
  await mv('in', 100, '2026-03-01');
  await mv('out', 30, '2026-04-01');
  await q(`SET session_replication_role=origin`);
  await post('2026-03-10', CASH, REV, 5000); await post('2026-04-10', EXP, CASH, 2000); await post('2026-09-01', AR, REV, 1500); await post('2026-09-05', EXP, AP, 800);

  // قبل إقفال السنة
  let p = await cf.preview(ctx, { toDate: '2026-12-31' });
  ok(!p.canCreate && p.blockers.some((b: string) => /قيد إقفال سنة/.test(b)) && p.blockers.some((b: string) => /إيراد\/مصروف/.test(b)), 'blocked: no year-end and P&L accounts not zero');
  await rej(() => cf.create(ctx, { toDate: '2026-12-31' }), /قيد إقفال سنة/, 'create refused before year-end');
  denied.add('carryforward.view'); await rej(() => cf.preview(ctx, { toDate: '2026-12-31' }), /DENIED/, 'view perm'); denied.clear();

  await pc.closeYear(ctx, { fromDate: '2026-01-01', toDate: '2026-12-31', retainedAccountId: RE });
  p = await cf.preview(ctx, { toDate: '2026-12-31' });
  ok(p.canCreate && p.blockers.length === 0, 'can create after year-end: ' + p.blockers.join('|'));
  const byCode = (c: string) => p.accounts.find((a: any) => a.code === c);
  near(byCode('1100')?.debit, 3000, 'cash 3000 carried'); near(byCode('1200')?.debit, 1500, 'receivable 1500'); near(byCode('2100')?.credit, 800, 'payable 800'); near(byCode('3200')?.credit, 3700, 'retained earnings 3700 (profit carried, not expenses)');
  ok(!p.accounts.some((a: any) => a.type === 'revenue' || a.type === 'expense'), 'no revenue/expense accounts carried'); near(p.accountTotals.debit, p.accountTotals.credit, 'balance sheet balanced');
  ok(p.customers.rows.length === 1 && p.customers.rows[0].code && Math.abs(p.customers.rows[0].net - 1500) < 0.01 && p.customers.rows[0].invoices.length === 1 && p.customers.rows[0].invoices[0].documentNumber === 'CF-S1' && Math.abs(p.customers.rows[0].invoices[0].outstanding - 1500) < 0.01, 'customer open invoice carried with details');
  ok(p.suppliers.rows.length === 1 && Math.abs(p.suppliers.rows[0].net - 800) < 0.01, 'supplier 800 carried');
  ok(p.inventory.length === 1 && Math.abs(p.inventory[0].quantity - 70) < 0.001 && Math.abs(p.inventory[0].value - 700) < 0.01 && Math.abs(p.inventory[0].unitCost - 10) < 0.01, 'inventory 70 units / 700 value');
  ok(p.nextPeriod.exists === false && p.nextPeriod.start === '2027-01-01' && p.nextPeriod.end === '2027-12-31', 'next period planned 2027'); ok(p.excluded.revenueExpenseAccounts === 0, 'P&L zero after close');
  ok(p.warnings.every((w: string) => !/العملاء|الموردون/.test(w)), 'subledger matches GL: ' + p.warnings.join('|'));

  denied.add('carryforward.create'); await rej(() => cf.create(ctx, { toDate: '2026-12-31' }), /DENIED/, 'create perm'); denied.clear();
  const s = await cf.create(ctx, { toDate: '2026-12-31' });
  ok(s.status === 'posted' && s.nextPeriodCreated === true && s.opening_date.toString().slice(0, 10) === '2027-01-01', 'snapshot created, next period created');
  ok((await q(`SELECT 1 FROM fiscal_periods WHERE company_id=$1 AND start_date='2027-01-01' AND end_date='2027-12-31' AND status='open'`, [ctx.companyId])).rows.length === 1, 'fiscal period 2027 exists open');
  await rej(() => cf.create(ctx, { toDate: '2026-12-31' }), /بالفعل/, 'duplicate snapshot refused');
  const g = await cf.get(ctx, s.id);
  ok(g.accounts.length === 4 && g.customers.length === 1 && g.suppliers.length === 1 && g.inventory.length === 1, 'lines stored: 4 accounts, 1 customer, 1 supplier, 1 inventory'); near(g.inventory[0].quantity, 70, 'stored qty'); ok(g.customers[0].detail.invoices[0].documentNumber === 'CF-S1', 'invoice detail stored');
  ok((await cf.list(ctx)).length === 1, 'list');
  ok((await q(`SELECT 1 FROM journal_entries WHERE source_document_type LIKE 'carry%'`)).rows.length === 0, 'no extra journal entries (ledger is cumulative)');
  const v1 = await cf.verify(ctx, s.id); ok(v1.matches, 'verify matches right after');
  // ترحيل بأثر رجعي يغيّر أرصدة السنة → verify يكشفه
  await post('2026-12-05', CASH, AR, 400);
  const v2 = await cf.verify(ctx, s.id); ok(!v2.matches && v2.differences.length >= 1, 'verify flags backdated posting: ' + v2.differences.join('|'));
  // عكس وإعادة الترحيل
  await rej(() => cf.reverse(ctx, s.id, { reason: 'x' }), /./, 'reason min length');
  denied.add('carryforward.reverse'); await rej(() => cf.reverse(ctx, s.id, { reason: 'تصحيح' }), /DENIED/, 'reverse perm'); denied.clear();
  await cf.reverse(ctx, s.id, { reason: 'ترحيل بأثر رجعي' }); await rej(() => cf.reverse(ctx, s.id, { reason: 'مرة ثانية' }), /معكوسة/, 'double reverse refused');
  const s2 = await cf.create(ctx, { toDate: '2026-12-31' }); ok(s2.status === 'posted' && s2.nextPeriodCreated === false, 're-create after reverse; period reused');
  near((await cf.get(ctx, s2.id)).accounts.find((a: any) => a.code === '1200').amount, 1100, 'new snapshot reflects backdated receipt (1500-400)');
  ok((await cf.verify(ctx, s2.id)).matches, 'new snapshot verifies');
  console.log(`PASS ${pass} FAIL ${fail}`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

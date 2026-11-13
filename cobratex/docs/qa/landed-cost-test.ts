import * as lc from '@/modules/purchasing/landedCostService';
import * as fx from '@/modules/accounting/fxRatesService';
import { pool } from '@/db/pool';
const Z = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`;
const V = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`;
const denied = new Set<string>();
const ctx: any = { companyId: Z('0000000000c1'), tenantId: Z('0000000000a1'), userId: Z('000000000f00'), assertPermission(c: string) { if (denied.has(c)) throw new Error('DENIED:' + c); }, visibleBranchIds: () => null };
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const near = (a: any, b: number, m: string, t = 0.001) => ok(a !== null && a !== undefined && Math.abs(Number(a) - b) <= t, `${m}: expected ${b} got ${a}`);
const rej = async (fn: () => Promise<unknown>, re: RegExp, m: string) => { try { await fn(); ok(false, m + ' (no error)'); } catch (e: any) { ok(re.test(e.message), m + ' → ' + e.message); } };
const BR = Z('0000000000b1'), WH = Z('000000000001'), FP = Z('000000000003'), YARN = Z('000000000101'), FAB = Z('000000000102'), UOM = Z('0000000000d0'), S1 = Z('00000000000a');
const q = (s: string, p: any[] = []) => pool.query(s, p);
const bal = async (a: string) => Number((await q(`SELECT COALESCE(SUM(jl.debit - jl.credit),0) AS b FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id WHERE jl.account_id=$1 AND je.status='posted'`, [a])).rows[0].b);
const wac = async (item: string) => Number((await q(`SELECT weighted_average_cost AS w FROM stock_balances WHERE item_id=$1 AND warehouse_id=$2`, [item, WH])).rows[0].w);
(async () => {
  // ===== دوال صرفة =====
  const a3 = lc.allocate(100, [1, 1, 1]); near(a3.reduce((s, v) => s + v, 0), 100, 'allocation sums exactly to 100'); ok(a3[0] === 33.3333 && a3[2] === 33.3334 || a3.some((v) => v === 33.3334), 'remainder goes to a line');
  near(lc.allocate(300, [1000, 2000])[1], 200, 'value split 1:2'); await rej(async () => lc.allocate(10, [0, 0]), /صفر/, 'zero basis rejected');
  await rej(async () => lc.basisFor('weight', { value: 1, qty: 1, weight: null, volume: null, manualPercent: null }), /وزن/, 'weight basis needs weight');
  // ===== بيانات =====
  const ac = (id: string, code: string, t: string) => q(`INSERT INTO accounts(id,company_id,code,name_ar,name_en,account_type) VALUES ($1,$2,$3,$3,$3,$4)`, [id, ctx.companyId, code, t]);
  const INV = V('41'), VAR = V('42'), PAY = V('43'), CUS = V('44'), SUPA = V('98');
  await ac(INV, '1400', 'asset'); await ac(VAR, '5400', 'expense'); await ac(PAY, '2400', 'liability'); await ac(CUS, '2410', 'liability'); await ac(SUPA, '9998', 'liability');
  await q(`INSERT INTO suppliers(id,company_id,code,name_ar,name_en,currency_code,linked_account_id) VALUES ($1,$2,'S1','مورد','s','EGP',$3)`, [S1, ctx.companyId, SUPA]);
  const GR = (await q(`INSERT INTO goods_receipts(company_id,branch_id,warehouse_id,supplier_id,document_number,receipt_date,status) VALUES ($1,$2,$3,$4,'GR1','2026-10-01','posted') RETURNING id`, [ctx.companyId, BR, WH, S1])).rows[0].id;
  const rl = async (item: string, qty: number, cost: number, onHand: number, status = 'posted') => {
    const mv = (await q(`INSERT INTO stock_movements(company_id,branch_id,warehouse_id,item_id,movement_type,quantity,unit_cost,movement_date,effective_date,source_document_type,status) VALUES ($1,$2,$3,$4,'in',$5,$6,'2026-10-01','2026-10-01','goods_receipt',$7) RETURNING id`, [ctx.companyId, BR, WH, item, qty, cost, status])).rows[0].id;
    await q(`INSERT INTO stock_balances(company_id,warehouse_id,item_id,quantity_on_hand,weighted_average_cost) VALUES ($1,$2,$3,$4,$5)`, [ctx.companyId, WH, item, onHand, cost]);
    return (await q(`INSERT INTO goods_receipt_lines(goods_receipt_id,company_id,item_id,uom_id,quantity,unit_cost,stock_movement_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [GR, ctx.companyId, item, UOM, qty, cost, mv])).rows[0].id;
  };
  const L1 = await rl(YARN, 100, 10, 60), L2 = await rl(FAB, 50, 40, 50); // YARN: 40 مستهلَك
  const base = { docDate: '2026-11-01', components: [{ name: 'شحن', amount: '300', creditAccountId: PAY }], lines: [{ goodsReceiptLineId: L1, weight: '100', volume: '1', manualPercent: '30' }, { goodsReceiptLineId: L2, weight: '300', volume: '3', manualPercent: '70' }] };
  const P = (m: string, extra: any = {}) => lc.preview(ctx, { ...base, method: m, ...extra } as any);
  // ===== الإعدادات =====
  ok((await lc.getSettings(ctx)).default_method === 'value', 'default settings: value');
  await rej(() => lc.saveSettings(ctx, { defaultMethod: 'weight', allowedMethods: ['value'] }), /ضمن المسموحة/, 'default must be allowed');
  await rej(() => lc.saveSettings(ctx, { inventoryAccountId: V('77') }), /غير موجود/, 'unknown account');
  denied.add('landed.settings'); await rej(() => lc.saveSettings(ctx, { defaultMethod: 'value' }), /DENIED/, 'settings perm'); denied.clear();
  await lc.saveSettings(ctx, { allowedMethods: ['value', 'quantity'], defaultMethod: 'value' });
  await rej(() => P('weight'), /غير مسموحة/, 'weight not allowed for this company'); await rej(() => P('value', { components: [{ name: 'x', amount: '10', method: 'volume', creditAccountId: PAY }] }), /غير مسموحة/, 'component method override must be allowed too');
  await lc.saveSettings(ctx, { allowedMethods: ['value', 'quantity', 'weight', 'volume', 'equal', 'manual'], inventoryAccountId: INV, varianceAccountId: VAR });
  // ===== المعاينة بكل الطرق =====
  const pv = await P('value'); near(pv.total, 300, 'total 300'); near(pv.lines[0].allocated, 100, 'value: YARN 100'); near(pv.lines[1].allocated, 200, 'value: FAB 200');
  near(pv.lines[0].capitalized, 60, 'YARN: 60% still on hand → 60 capitalized'); near(pv.lines[0].expensed, 40, 'YARN: 40 consumed share expensed'); near(pv.lines[1].capitalized, 200, 'FAB fully on hand'); near(pv.lines[0].wacAfter, 11, 'YARN WAC 10 → 11'); near(pv.lines[1].wacAfter, 44, 'FAB WAC 40 → 44'); near(pv.lines[0].unitLanded, 1, 'landed/unit 1');
  const pq = await P('quantity'); near(pq.lines[0].allocated, 200, 'quantity 100:50 → 200'); near(pq.lines[1].allocated, 100, 'quantity → 100');
  const pw = await P('weight'); near(pw.lines[0].allocated, 75, 'weight 100:300 → 75'); near(pw.lines[1].allocated, 225, 'weight → 225');
  const pvo = await P('volume'); near(pvo.lines[0].allocated, 75, 'volume 1:3 → 75');
  const pe = await P('equal'); near(pe.lines[0].allocated, 150, 'equal → 150'); near(pe.lines[1].allocated, 150, 'equal → 150');
  const pm = await P('manual'); near(pm.lines[0].allocated, 90, 'manual 30% → 90'); near(pm.lines[1].allocated, 210, 'manual 70% → 210');
  await rej(() => lc.preview(ctx, { ...base, method: 'manual', lines: [{ goodsReceiptLineId: L1, manualPercent: '30' }, { goodsReceiptLineId: L2, manualPercent: '60' }] } as any), /100/, 'manual percents must sum to 100');
  await rej(() => lc.preview(ctx, { ...base, method: 'weight', lines: [{ goodsReceiptLineId: L1 }, { goodsReceiptLineId: L2 }] } as any), /وزن/, 'weight method requires weights');
  // مكوّنات بطرق مختلفة وعملة أجنبية
  await fx.setRate(ctx, { currencyCode: 'USD', rateDate: '2026-11-01', rate: 50 });
  const mix = await lc.preview(ctx, { ...base, method: 'value', components: [{ name: 'شحن', amount: '300', method: 'weight', creditAccountId: PAY }, { name: 'جمارك', amount: '10', currency: 'USD', method: 'value', creditAccountId: CUS }] } as any);
  near(mix.total, 800, 'total 300 EGP + 10 USD×50 = 800'); near(mix.components[1].base, 500, 'USD component converted'); near(mix.lines[0].allocated, 75 + 500 / 3, 'YARN: freight by weight 75 + customs by value 166.6667'); near(mix.lines[1].allocated, 225 + 1000 / 3, 'FAB share');
  near(mix.lines[0].allocated + mix.lines[1].allocated, 800, 'allocations sum to total');
  // سياسة capitalize_remaining
  await lc.saveSettings(ctx, { consumedPolicy: 'capitalize_remaining' }); const pc = await P('value'); near(pc.lines[0].capitalized, 100, 'capitalize_remaining: all 100 on remaining 60'); near(pc.lines[0].expensed, 0, 'nothing expensed'); near(pc.lines[0].wacAfter, 11.6667, 'WAC (600+100)/60', 0.001);
  await lc.saveSettings(ctx, { consumedPolicy: 'expense_consumed' });
  // أخطاء المدخلات
  await rej(() => lc.preview(ctx, { ...base, lines: [{ goodsReceiptLineId: L1 }, { goodsReceiptLineId: L1 }] } as any), /مكرر/, 'duplicate line');
  await rej(() => lc.preview(ctx, { ...base, lines: [{ goodsReceiptLineId: V('55') }] } as any), /غير موجود/, 'unknown receipt line');
  await q(`UPDATE goods_receipts SET status='draft'`); await rej(() => P('value'), /مرحَّل/, 'unposted receipt rejected'); await q(`UPDATE goods_receipts SET status='posted'`);
  denied.add('landed.view'); await rej(() => P('value'), /DENIED/, 'view perm'); denied.clear();
  // ===== الترحيل =====
  await lc.saveSettings(ctx, { inventoryAccountId: null }); await rej(() => lc.post(ctx, { ...base, method: 'value' } as any), /حساب المخزون/, 'inventory account required');
  await lc.saveSettings(ctx, { inventoryAccountId: INV, varianceAccountId: null }); await rej(() => lc.post(ctx, { ...base, method: 'value' } as any), /الفروق/, 'variance account required when consumed share exists');
  await lc.saveSettings(ctx, { varianceAccountId: VAR });
  denied.add('landed.post'); await rej(() => lc.post(ctx, { ...base, method: 'value' } as any), /DENIED/, 'post perm'); denied.clear();
  ok((await q(`SELECT count(*)::int AS n FROM landed_cost_docs`)).rows[0].n === 0, 'failed posts left nothing');
  const d = await lc.post(ctx, { ...base, method: 'value', docNo: 'LC-1', notes: 'شحن شهر 11' } as any);
  near(d.capitalized_total, 260, 'doc capitalized 260'); near(d.expensed_total, 40, 'doc expensed 40');
  near(await bal(INV), 260, 'inventory debited 260'); near(await bal(VAR), 40, 'variance debited 40'); near(await bal(PAY), -300, 'freight payable credited 300');
  near(await wac(YARN), 11, 'stock WAC YARN → 11'); near(await wac(FAB), 44, 'stock WAC FAB → 44');
  await rej(() => lc.post(ctx, { ...base, method: 'value', docNo: 'LC-1' } as any), /مستخدم/, 'duplicate doc number');
  const doc = await lc.getDoc(ctx, d.id); ok(doc.lines.length === 2 && doc.components.length === 1, 'doc card has lines and components'); ok((await lc.list(ctx)).length === 1, 'list shows 1');
  const rp = await lc.report(ctx, { from: '2026-11-01', to: '2026-11-30' }); const y = rp.byItem.find((x: any) => x.code === 'YARN'); near(y.upliftPercent, 10, 'YARN uplift 10%'); near(y.landedPerUnit, 1, 'YARN landed/unit 1'); near(rp.totals.landed, 300, 'report landed 300'); ok(rp.byComponent[0].name === 'شحن' && rp.byComponent[0].total === 300, 'by component');
  ok((await lc.report(ctx, { from: '2026-12-01', to: '2026-12-31' })).byItem.length === 0, 'other period empty');
  // ===== العكس =====
  await rej(() => lc.reverse(ctx, d.id, { reason: 'x' }), /3/, 'reason too short');
  denied.add('landed.reverse'); await rej(() => lc.reverse(ctx, d.id, { reason: 'خطأ توزيع' }), /DENIED/, 'reverse perm'); denied.clear();
  await lc.reverse(ctx, d.id, { reason: 'خطأ في التوزيع' });
  near(await bal(INV), 0, 'inventory back to 0'); near(await bal(VAR), 0, 'variance back to 0'); near(await bal(PAY), 0, 'payable back to 0'); near(await wac(YARN), 10, 'YARN WAC restored 10'); near(await wac(FAB), 40, 'FAB WAC restored 40');
  await rej(() => lc.reverse(ctx, d.id, { reason: 'مرة أخرى' }), /بالفعل/, 'double reverse'); ok((await lc.report(ctx, { from: '2026-11-01', to: '2026-11-30' })).byItem.length === 0, 'reversed doc excluded from report');
  // ===== ترحيل مختلط بطريقتين وعملة أجنبية =====
  const d2 = await lc.post(ctx, { ...base, method: 'value', components: [{ name: 'شحن', amount: '300', method: 'weight', creditAccountId: PAY }, { name: 'جمارك', amount: '10', currency: 'USD', method: 'value', creditAccountId: CUS }] } as any);
  near(d2.total_amount, 800, 'mixed doc total 800'); near(await bal(CUS), -500, 'customs payable 500 base'); near(await bal(INV) + await bal(VAR), 800, 'debits total 800 = credits');
  // ===== إعادة التطبيق بعد «إعادة بناء» الرصيد =====
  await q(`INSERT INTO stock_movements(company_id,branch_id,warehouse_id,item_id,movement_type,quantity,unit_cost,movement_date,effective_date,source_document_type,status) VALUES ($1,$2,$3,$4,'out',40,10,'2026-10-20','2026-10-20','sale','posted')`, [ctx.companyId, BR, WH, YARN]);
  near(await wac(YARN), 11, 'before rebuild: YARN WAC 11 (doc d2 posted: capitalized share)', 5);
  await q(`UPDATE stock_balances SET weighted_average_cost=10 WHERE item_id=$1`, [YARN]); await q(`UPDATE stock_balances SET weighted_average_cost=40 WHERE item_id=$1`, [FAB]); // محاكاة rebuild
  denied.add('landed.settings'); await rej(() => lc.reapply(ctx, {}), /DENIED/, 'reapply perm'); denied.clear();
  const ra = await lc.reapply(ctx, {}); ok(ra.checked === 2 && ra.changed === 2, 'reapply fixed both balances');
  const cYarn = Number((await q(`SELECT SUM(capitalized_amount) AS c FROM landed_cost_lines WHERE item_id=$1 AND doc_id=$2`, [YARN, d2.id])).rows[0].c);
  near(await wac(YARN), 10 + cYarn / 60, 'YARN WAC = ledger 10 + capitalized/onhand 60', 0.001);
  const ra2 = await lc.reapply(ctx, {}); ok(ra2.changed === 0, 'idempotent: second reapply changes nothing');
  await lc.reverse(ctx, d2.id, { reason: 'إلغاء المستند الثاني' }); const ra3 = await lc.reapply(ctx, {}); ok(ra3.checked === 0, 'reversed docs are not reapplied');
  console.log(`PASS ${pass} FAIL ${fail}`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR', e.message || e); process.exit(1); });

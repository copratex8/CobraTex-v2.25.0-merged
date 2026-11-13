import * as yl from '@/modules/manufacturing/yarnLedger';
import { pool } from '@/db/pool';
const Z = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`;
const denied = new Set<string>();
const ctx: any = { companyId: Z('0000000000c1'), tenantId: Z('0000000000a1'), userId: Z('000000000f00'), assertPermission(c: string) { if (denied.has(c)) throw new Error('DENIED:' + c); }, visibleBranchIds: () => null };
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const near = (a: any, b: number, m: string, t = 0.001) => ok(a !== null && a !== undefined && Math.abs(Number(a) - b) <= t, `${m}: expected ${b} got ${a}`);
const rej = async (fn: () => Promise<unknown>, re: RegExp, m: string) => { try { await fn(); ok(false, m + ' (no error)'); } catch (e: any) { ok(re.test(e.message), m + ' → ' + e.message); } };
const q = (s: string, p: any[] = []) => pool.query(s, p);
(async () => {
  // نفس بيانات المثال في الشيت (النسب بالمئة)
  const R = (d: string, no: string, lot: string, item: string, qty: number) => yl.createReceipt(ctx, { receiptDate: d, receiptNo: no, lotNo: lot, itemName: item, quantity: qty });
  await R('2026-10-01', 'IN-001', 'L-1001', 'قطن مسرح 30/1', 2000); await R('2026-10-03', 'IN-002', 'L-1002', 'بوليستر 150/48', 1200); await R('2026-10-05', 'IN-003', 'L-1003', 'فيسكوز 30/1', 800); await R('2026-10-07', 'IN-004', 'L-1004', 'ليكرا 40D', 150); await R('2026-10-10', 'IN-005', 'L-1001', 'قطن مسرح 30/1', 1000);
  const run = (d: string, m: string, fab: number, wp: number, lines: Array<[string, number]>) => yl.createRun(ctx, { runDate: d, machineCode: m, fabricKg: fab, wastePercent: wp, lines: lines.map(([lotNo, blendPercent]) => ({ lotNo, blendPercent })) });
  const r1 = await run('2026-10-05', 'M-01', 500, 2, [['L-1001', 70], ['L-1002', 25], ['L-1004', 5]]);
  near(r1.net, 500, 'run1 net 500'); near(r1.waste, 10, 'run1 waste 10 (2% of 500)'); near(r1.withdrawn, 510, 'run1 withdrawn 510'); near(r1.lines[0].netKg, 350, 'L-1001 net 350'); near(r1.lines[0].wasteKg, 7, 'L-1001 waste 7');
  await run('2026-10-06', 'M-02', 400, 3, [['L-1001', 60], ['L-1003', 40]]); await run('2026-10-08', 'M-03', 300, 1, [['L-1002', 100]]);
  const L = await yl.ledger(ctx, {});
  near(L.totals.received, 5150, 'dashboard: total received 5150'); near(L.totals.net, 1200, 'total net 1200'); near(L.totals.waste, 25, 'total waste 25'); near(L.totals.balance, 3925, 'remaining 3925 (matches sheet)'); ok(L.check === 'مطابق', 'check reconciles'); near(L.totals.wastePercentOfNet, 2.083, 'waste % of net 2.083%');
  const l1 = L.lots.find((x: any) => x.lotNo === 'L-1001'); near(l1.received, 3000, 'L-1001 received 3000 (two receipts)'); near(l1.net, 590, 'L-1001 net 590'); near(l1.waste, 14.2, 'L-1001 waste 14.2'); near(l1.balance, 2395.8, 'L-1001 balance 2395.8'); near(l1.consumptionPercent, 20.140, 'consumption %', 0.01);
  ok(L.lots.length === 4 && L.byItem.length === 4 && L.byMachine.length === 3, '4 lots, 4 yarn types, 3 machines'); const m1 = L.byMachine.find((m: any) => m.machine === 'M-01'); near(m1.waste, 10, 'machine M-01 waste'); near(m1.wastePercent, 2, 'machine waste % 2');
  ok(L.highWasteRuns.every((x: any) => x.wastePercent > L.wasteLimit), 'high-waste filter consistent'); ok((await yl.ledger(ctx, { wasteLimit: 2.5 })).highWasteRuns.length === 1, 'run with 3% flagged above 2.5% limit');
  near((await yl.ledger(ctx, { asOf: '2026-10-05' })).totals.received, 4000, 'as-of 10-05 excludes later receipts (as-of filter)');

  // التحقق
  await rej(() => run('2026-10-09', 'M-01', 100, 1, [['L-1001', 60], ['L-1003', 30]]), /100%/, 'blend must sum to 100%');
  await rej(() => run('2026-10-09', 'M-01', 100, 1, [['L-9999', 100]]), /غير مسجَّل/, 'unknown lot refused');
  await rej(() => run('2026-10-09', 'M-01', 100, 1, [['L-1001', 50], ['L-1001', 50]]), /مكرر/, 'duplicate lot in run refused');
  await rej(() => run('2026-10-09', 'M-01', 1000, 0, [['L-1004', 100]]), /لا يكفي/, 'insufficient balance refused'); near((await yl.lotCard(ctx, { lotNo: 'L-1004' })).balance, 150 - 25 - 0.5, 'L-1004 unchanged after refusal (124.5)');
  await rej(() => R('2026-10-11', 'IN-006', 'L-1001', 'ليكرا 40D', 10), /مسجَّل بصنف/, 'same lot different item refused');
  await rej(() => R('2026-10-11', 'IN-001', 'L-1001', 'قطن مسرح 30/1', 10), /مسجَّل لنفس اللوط/, 'duplicate receipt no refused');
  denied.add('yarnlot.manage'); await rej(() => R('2026-10-12', 'IN-9', 'L-1001', 'قطن مسرح 30/1', 1), /DENIED/, 'manage perm'); denied.clear();
  denied.add('yarnlot.view'); await rej(() => yl.ledger(ctx, {}), /DENIED/, 'view perm'); denied.clear();

  // هالك فعلي موزّع + رصيد سالب مصرّح
  const ro = await yl.createRun(ctx, { runDate: '2026-10-12', machineCode: 'M-01', fabricKg: 200, wastePercent: 0, wasteOverrideKg: 8, lines: [{ lotNo: 'L-1001', blendPercent: 50 }, { lotNo: 'L-1003', blendPercent: 50 }] }); near(ro.waste, 8, 'actual waste override 8 kg distributed'); near(ro.lines[0].wasteKg, 4, 'split by blend 4/4');
  const neg = await yl.createRun(ctx, { runDate: '2026-10-13', fabricKg: 200, wastePercent: 0, lines: [{ lotNo: 'L-1004', blendPercent: 100 }], allowNegative: true }); ok(!!neg.id, 'allowNegative lets stock go below zero');
  ok((await yl.ledger(ctx, {})).alerts.some((a: string) => /سالب/.test(a) && /L-1004/.test(a)), 'negative balance alert');
  denied.add('yarnlot.cancel'); await rej(() => yl.cancelRun(ctx, neg.id, { reason: 'خطأ إدخال' }), /DENIED/, 'cancel perm'); denied.clear();
  await rej(() => yl.cancelRun(ctx, neg.id, { reason: 'x' }), /./, 'reason min length'); await yl.cancelRun(ctx, neg.id, { reason: 'خطأ إدخال' }); await rej(() => yl.cancelRun(ctx, neg.id, { reason: 'مرة ثانية' }), /ملغاة/, 'double cancel refused');
  ok(!(await yl.ledger(ctx, {})).alerts.some((a: string) => /L-1004/.test(a)), 'alert cleared after cancel'); near((await yl.lotCard(ctx, { lotNo: 'L-1004' })).balance, 124.5, 'L-1004 back to 124.5');
  const rcp = (await yl.listReceipts(ctx, { lotNo: 'L-1004' }))[0]; await run('2026-10-14', 'M-01', 100, 0, [['L-1004', 100]]);
  await rej(() => yl.cancelReceipt(ctx, rcp.id, { reason: 'خطأ' }), /سالبًا/, 'cannot cancel receipt that backs withdrawals');

  // كارت اللوط
  const card = await yl.lotCard(ctx, { lotNo: 'L-1001' }); ok(card.movements[0].type === 'وارد' && card.movements.length === 5, 'lot card: 2 receipts + 3 runs'); near(card.movements[card.movements.length - 1].balance, card.balance, 'running balance ends at balance');
  ok((await yl.listRuns(ctx, {})).length === 5 && (await yl.listRuns(ctx, { machineCode: 'M-03' })).length === 1 && (await yl.listRuns(ctx, { lotNo: 'L-1003' })).length === 2, 'list filters'); ok((await yl.listRuns(ctx, { includeCancelled: 'true' })).length === 6, 'cancelled included on request');

  // الاستيراد
  const imp = { receipts: [{ date: '2026-11-01', receiptNo: 'IN-101', lotNo: 'L-2001', itemName: 'قطن كارد 20/1', quantity: 500 }, { date: '2026-10-01', receiptNo: 'IN-001', lotNo: 'L-1001', itemName: 'قطن مسرح 30/1', quantity: 2000 }], runs: [{ date: '2026-11-02', machineCode: 'M-05', fabricKg: 100, wastePercent: 2, lines: [{ lotNo: 'L-2001', blendPercent: 100 }] }, { date: '2026-10-05', machineCode: 'M-01', fabricKg: 500, wastePercent: 2, lines: [{ lotNo: 'L-1001', blendPercent: 70 }, { lotNo: 'L-1002', blendPercent: 25 }, { lotNo: 'L-1004', blendPercent: 5 }] }] };
  const d = await yl.importData(ctx, { dryRun: true, ...imp }); ok(d.errors.length === 0 && d.receipts === 1 && d.runs === 1 && d.skippedDuplicates === 2 && !d.imported, 'dry-run: 1 receipt + 1 run new, 2 duplicates skipped, nothing written'); ok((await yl.ledger(ctx, {})).lots.length === 4, 'dry-run wrote nothing');
  const bad = await yl.importData(ctx, { dryRun: false, receipts: [], runs: [{ date: '2026-11-03', fabricKg: 100, wastePercent: 1, lines: [{ lotNo: 'L-1001', blendPercent: 60 }, { lotNo: 'L-1002', blendPercent: 30 }] }, { date: '2026-11-03', fabricKg: 100, wastePercent: 1, lines: [{ lotNo: 'L-7777', blendPercent: 100 }] }] });
  ok(!bad.imported && bad.errors.length === 2 && bad.errors.some((e: string) => /90%/.test(e)) && bad.errors.some((e: string) => /بلا وارد/.test(e)), 'bad rows reported, nothing imported: ' + bad.errors.join('|'));
  denied.add('yarnlot.import'); await rej(() => yl.importData(ctx, { dryRun: true, ...imp }), /DENIED/, 'import perm'); denied.clear();
  const real = await yl.importData(ctx, { dryRun: false, ...imp }); ok(real.imported && real.receipts === 1 && real.runs === 1, 'imported'); near((await yl.lotCard(ctx, { lotNo: 'L-2001' })).balance, 500 - 100 - 2, 'imported lot balance 398');
  const again = await yl.importData(ctx, { dryRun: false, ...imp }); ok(again.receipts === 0 && again.runs === 0 && again.skippedDuplicates === 4, 're-import is idempotent (4 duplicates skipped)');
  const ovr = await yl.importData(ctx, { dryRun: false, receipts: [], runs: [{ date: '2026-11-05', fabricKg: 9999, wastePercent: 0, lines: [{ lotNo: 'L-2001', blendPercent: 100 }] }] }); ok(!ovr.imported && /سالب/.test(ovr.errors[0]), 'import refuses to drive a lot negative');

  // ===== التكلفة وأمر التصنيع =====
  const V = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`; const PO = V('c0'), PO2 = V('c1');
  await q(`SET session_replication_role=replica`);
  for (const [id, no] of [[PO, 'PO-Y1'], [PO2, 'PO-Y2']]) await q(`INSERT INTO production_orders(id,company_id,branch_id,warehouse_id,bom_id,output_item_id,document_number,fiscal_period_id,order_date,currency_code,planned_output_quantity,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'2026-10-01','EGP',100,'draft')`, [id, ctx.companyId, Z('0000000000b1'), Z('000000000001'), Z('000000000002'), Z('000000000102'), no, Z('000000000003')]);
  await q(`SET session_replication_role=origin`);
  await yl.createReceipt(ctx, { receiptDate: '2026-11-10', receiptNo: 'IN-P1', lotNo: 'L-3001', itemName: 'قطن كارد 20/1', quantity: 1000, unitPrice: 60 });
  await yl.createReceipt(ctx, { receiptDate: '2026-11-11', receiptNo: 'IN-P2', lotNo: 'L-3001', itemName: 'قطن كارد 20/1', quantity: 1000, unitPrice: 80 });
  await yl.createReceipt(ctx, { receiptDate: '2026-11-12', receiptNo: 'IN-P3', lotNo: 'L-3002', itemName: 'بوليستر خام', quantity: 500 });
  await rej(() => yl.createRun(ctx, { runDate: '2026-11-13', productionOrderId: V('ff'), fabricKg: 10, wastePercent: 0, lines: [{ lotNo: 'L-3001', blendPercent: 100 }] }), /أمر التصنيع غير موجود/, 'unknown production order refused');
  await yl.createRun(ctx, { runDate: '2026-11-13', productionOrderId: PO, machineCode: 'M-01', fabricKg: 400, wastePercent: 2, lines: [{ lotNo: 'L-3001', blendPercent: 75 }, { lotNo: 'L-3002', blendPercent: 25 }] });
  await yl.createRun(ctx, { runDate: '2026-11-14', productionOrderId: PO, fabricKg: 100, wastePercent: 0, lines: [{ lotNo: 'L-3001', blendPercent: 100 }] }); await yl.createRun(ctx, { runDate: '2026-11-14', productionOrderId: PO2, fabricKg: 50, wastePercent: 0, lines: [{ lotNo: 'L-3001', blendPercent: 100 }] });
  const lg = (await yl.ledger(ctx, {})).lots.find((x: any) => x.lotNo === 'L-3001'); near(lg.avgCost, 70, 'weighted avg price (1000@60 + 1000@80) = 70'); near(lg.balanceValue, lg.balance * 70, 'balance value = balance × avg');
  const oc = await yl.orderYarnCost(ctx, PO); ok(oc.orderNo === 'PO-Y1' && oc.lots.length === 2, 'order cost: 2 lots');
  const a1 = oc.lots.find((x: any) => x.lotNo === 'L-3001'); near(a1.netKg, 300 + 100, 'L-3001 net 400 on order (300 + 100)'); near(a1.wasteKg, 400 * 0.02 * 0.75, 'L-3001 waste 6'); near(a1.netCost, 400 * 70, 'net cost 28000'); near(a1.wasteCost, 6 * 70, 'waste cost 420');
  ok(oc.lots.find((x: any) => x.lotNo === 'L-3002').unitPrice === null && oc.warnings.some((w: string) => /L-3002/.test(w)), 'unpriced lot flagged and excluded');
  near(oc.totals.totalCost, 28000 + 420, 'order yarn cost 28420'); near(oc.totals.wasteShareOfCost, (420 / 28420) * 100, 'waste share of cost', 0.01); near(oc.fabricKg, 500, 'order fabric 500 kg'); near(oc.totals.costPerKgFabric, 28420 / 500, 'cost per kg fabric', 0.001);
  ok((await yl.listRuns(ctx, { productionOrderId: PO })).length === 2 && (await yl.listRuns(ctx, { productionOrderId: PO }))[0].order_no === 'PO-Y1', 'runs listed by order with order number');
  await rej(() => yl.orderYarnCost(ctx, V('ee')), /غير موجود/, 'unknown order'); denied.add('yarnlot.view'); await rej(() => yl.orderYarnCost(ctx, PO), /DENIED/, 'cost needs view'); denied.clear();
  console.log(`PASS ${pass} FAIL ${fail}`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

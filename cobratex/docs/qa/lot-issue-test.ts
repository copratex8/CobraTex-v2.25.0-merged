import * as li from '@/modules/manufacturing/textileLotIssue';
import * as lt from '@/modules/manufacturing/textileLots';
import { recordInMovement } from '@/modules/inventory/stockService';
import { pool } from '@/db/pool';
const Z = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`;
const denied = new Set<string>();
const ctx: any = { companyId: Z('0000000000c1'), tenantId: Z('0000000000a1'), userId: Z('000000000f00'), assertPermission(c: string) { if (denied.has(c)) throw new Error('DENIED:' + c); }, visibleBranchIds: () => null };
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const near = (a: any, b: number, m: string) => ok(a !== null && a !== undefined && Math.abs(Number(a) - b) < 0.0006, `${m}: expected ${b} got ${a}`);
const rej = async (fn: () => Promise<unknown>, re: RegExp, m: string) => { try { await fn(); ok(false, m + ' (no error)'); } catch (e: any) { ok(re.test(e.message), m + ' → ' + e.message); } };
const BR = Z('0000000000b1'), WH = Z('000000000001'), BOM = Z('000000000002'), FP = Z('000000000003'), FAB = Z('000000000102'), YARN = Z('000000000101'), COT = Z('000000000201'), UOM = Z('0000000000d0');
const q = (s: string, p: any[] = []) => pool.query(s, p);
(async () => {
  // استراتيجيات التخصيص (صرفة)
  const pool3 = [{ batchId: 'a', batchNo: 'Y1', available: 60, avgCost: 10, productionDate: '2026-01-01' }, { batchId: 'b', batchNo: 'Y2', available: 50, avgCost: 12, productionDate: '2026-02-01' }, { batchId: 'c', batchNo: 'Y3', available: 100, avgCost: 8, productionDate: '2026-03-01' }];
  const f = li.allocate(100, pool3, 'fifo'); ok(f.allocations.length === 2 && f.allocations[0].batchNo === 'Y1' && f.allocations[0].quantity === 60 && f.allocations[1].quantity === 40 && f.shortfall === 0, 'FIFO: oldest first 60 + 40');
  const c = li.allocate(100, pool3, 'cheapest'); ok(c.allocations.length === 1 && c.allocations[0].batchNo === 'Y3', 'cheapest: Y3 alone');
  const l = li.allocate(120, pool3, 'largest'); ok(l.allocations[0].batchNo === 'Y3' && l.allocations[1].batchNo === 'Y1' && l.allocations[1].quantity === 20, 'largest first: Y3 100 + Y1 20');
  const sh = li.allocate(300, pool3, 'fifo'); ok(sh.shortfall === 90 && sh.allocations.length === 3, 'shortfall 90 when stock is 210');
  ok(li.allocate(10, [{ batchId: 'x', batchNo: 'Z', available: 0, avgCost: 1, productionDate: null }]).allocations.length === 0, 'empty lots ignored');

  await q(`INSERT INTO items(id,company_id,item_kind,code,name_ar,name_en,base_uom_id) VALUES ($1,$2,'generic','COT','قطن','COT',$3) ON CONFLICT DO NOTHING`, [COT, ctx.companyId, UOM]);
  const bt = async (item: string, no: string, d: string) => (await q(`INSERT INTO batches(company_id,item_id,batch_no,production_date) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.companyId, item, no, d])).rows[0].id;
  const Y1 = await bt(YARN, 'Y1', '2026-01-01'), Y2 = await bt(YARN, 'Y2', '2026-02-01'), Y3 = await bt(YARN, 'Y3', '2026-03-01'), C1 = await bt(COT, 'C1', '2026-01-05'), C2 = await bt(COT, 'C2', '2026-01-06');
  const recv = (item: string, batch: string, qty: number, cost: number) => recordInMovement(ctx, { branchId: BR, warehouseId: WH, itemId: item, batchId: batch, quantity: String(qty), unitCost: String(cost), movementDate: '2026-10-01', sourceDocumentType: 'test' });
  await recv(YARN, Y1, 60, 10); await recv(YARN, Y2, 50, 12); await recv(YARN, Y3, 100, 8); await recv(COT, C1, 30, 5); await recv(COT, C2, 40, 6);
  await q(`UPDATE production_orders SET status='reversed'`);
  const O = (await q(`INSERT INTO production_orders(company_id,branch_id,warehouse_id,bom_id,output_item_id,document_number,fiscal_period_id,order_date,currency_code,planned_output_quantity,actual_output_quantity,status) VALUES ($1,$2,$3,$4,$5,'LOT-O',$6,'2026-10-20','EGP',90,90,'draft') RETURNING *`, [ctx.companyId, BR, WH, BOM, FAB, FP])).rows[0];
  const L1 = (await q(`INSERT INTO production_order_lines(production_order_id,company_id,component_item_id,planned_quantity,is_main_material) VALUES ($1,$2,$3,100,true) RETURNING id`, [O.id, ctx.companyId, YARN])).rows[0].id;
  const L2 = (await q(`INSERT INTO production_order_lines(production_order_id,company_id,component_item_id,planned_quantity,is_main_material) VALUES ($1,$2,$3,50,false) RETURNING id`, [O.id, ctx.companyId, COT])).rows[0].id;

  // تحديد اللوطات والتحقق
  await rej(() => li.setLineLots(ctx, O.id, L1, { lots: [{ batchId: Y1, quantity: 70 }] }), /المتاح 60/, 'cannot exceed lot availability');
  await rej(() => li.setLineLots(ctx, O.id, L1, { lots: [{ batchId: Y1, quantity: 60 }, { batchId: Y3, quantity: 60 }] }), /يتجاوز المطلوب/, 'cannot exceed required quantity');
  await rej(() => li.setLineLots(ctx, O.id, L1, { lots: [{ batchId: C1, quantity: 10 }] }), /ليس من نفس صنف/, 'lot of another item rejected');
  await rej(() => li.setLineLots(ctx, O.id, L1, { lots: [{ batchId: Y1, quantity: 10 }, { batchId: Y1, quantity: 10 }] }), /مكرر/, 'duplicate lot rejected');
  denied.add('textile.lots.manage'); await rej(() => li.setLineLots(ctx, O.id, L1, { lots: [{ batchId: Y1, quantity: 10 }] }), /DENIED/, 'needs lots.manage'); denied.clear();
  const s1 = await li.setLineLots(ctx, O.id, L1, { lots: [{ batchId: Y1, quantity: 60 }, { batchId: Y2, quantity: 40 }] }); near(s1.allocated, 100, 'allocated 100'); near(s1.remaining, 0, 'remaining 0');
  const ol = await li.orderLots(ctx, O.id); const o1 = ol.lines.find((x: any) => x.lineId === L1)!, o2 = ol.lines.find((x: any) => x.lineId === L2)!;
  ok(o1.allocations.length === 2 && o1.remaining === 0 && o1.isMain, 'orderLots: line 1 fully allocated'); ok(o2.allocated === 0 && o2.availableLots.length === 2, 'line 2 untouched, shows 2 available lots'); ok(ol.ready === true, 'ready (unallocated lines use the legacy path)');
  const reLots = await li.setLineLots(ctx, O.id, L1, { lots: [{ batchId: Y3, quantity: 100 }] }); near(reLots.allocated, 100, 'replace allocation'); ok((await q(`SELECT 1 FROM production_line_lots WHERE production_order_line_id=$1`, [L1])).rows.length === 1, 'replacement removed old lots');
  await li.setLineLots(ctx, O.id, L1, { lots: [{ batchId: Y1, quantity: 60 }, { batchId: Y2, quantity: 40 }] });
  await li.setLineLots(ctx, O.id, L2, { lots: [{ batchId: C1, quantity: 20 }] }); ok((await li.orderLots(ctx, O.id)).ready === false, 'partially allocated line → not ready');

  // اقتراح/تطبيق تلقائي
  const sg = await li.autoAllocate(ctx, O.id, { strategy: 'cheapest' }, false); const sl2 = sg.lines.find((x: any) => x.lineId === L2) as any; ok(sl2.skipped && (sg.lines.find((x: any) => x.lineId === L1) as any).skipped, 'suggest skips lines already allocated');
  await q(`DELETE FROM production_line_lots WHERE production_order_line_id=$1`, [L2]);
  const sg2 = await li.autoAllocate(ctx, O.id, { strategy: 'cheapest' }, false) as any; const l2s = sg2.lines.find((x: any) => x.lineId === L2); ok(l2s.allocations[0].batchNo === 'C1' && l2s.allocations[0].quantity === 30 && l2s.allocations[1].batchNo === 'C2' && l2s.allocations[1].quantity === 20 && !l2s.applied, 'suggest cheapest cotton: C1 30 (5) + C2 20 (6), not applied');
  ok((await q(`SELECT 1 FROM production_line_lots WHERE production_order_line_id=$1`, [L2])).rows.length === 0, 'suggest did not write');
  const ap = await li.autoAllocate(ctx, O.id, { strategy: 'cheapest' }, true) as any; ok(ap.complete && ap.lines.find((x: any) => x.lineId === L2).applied, 'auto-apply writes allocation'); near((await li.orderLots(ctx, O.id)).lines.find((x: any) => x.lineId === L2)!.allocated, 50, 'line 2 allocated 50');

  // الصرف الفعلي لكل لوط
  const order = (await q(`SELECT * FROM production_orders WHERE id=$1`, [O.id])).rows[0];
  const line1 = { id: L1, component_item_id: YARN }, line2 = { id: L2, component_item_id: COT };
  await q(`DELETE FROM production_line_lots WHERE production_order_line_id=$1`, [L2]); await li.setLineLots(ctx, O.id, L2, { lots: [{ batchId: C1, quantity: 20 }] });
  await rej(() => li.issueLineLots(ctx, pool, order, line2, '50'), /لا يساوي الكمية المستهلكة/, 'partial allocation blocks posting (no silent partial issue)');
  const isu = await li.issueLineLots(ctx, pool, order, line1, '100'); ok(!!isu && isu.lots === 2, 'issued two lots'); near(isu!.lineCost, 60 * 10 + 40 * 12, 'line cost = 600 + 480 (each lot at its own cost)');
  const bal = async (b: string) => Number((await q(`SELECT quantity_on_hand FROM stock_balances WHERE batch_id=$1`, [b])).rows[0].quantity_on_hand);
  near(await bal(Y1), 0, 'Y1 emptied'); near(await bal(Y2), 10, 'Y2 left 10'); near(await bal(Y3), 100, 'Y3 untouched');
  const pl = (await q(`SELECT b.batch_no, a.unit_cost, a.line_cost, a.stock_movement_id FROM production_line_lots a JOIN batches b ON b.id=a.batch_id WHERE a.production_order_line_id=$1 ORDER BY b.batch_no`, [L1])).rows; near(pl[0].unit_cost, 10, 'Y1 unit cost recorded'); near(pl[1].line_cost, 480, 'Y2 cost recorded'); ok(pl.every((x: any) => !!x.stock_movement_id), 'movement ids stored per lot');
  ok((await li.issueLineLots(ctx, pool, order, { id: Z('0000000000ee'), component_item_id: YARN }, '5')) === null, 'no allocation → null (legacy path)');
  // كارت اللوط بعد الصرف (يختبر production_consume)
  const card = await lt.lotCard(ctx, { itemId: YARN, batchNo: 'Y1' }); near(card.totals.balance, 0, 'lot card Y1 balance 0 after production consume'); ok(card.movements.at(-1)!.label === 'صرف للتصنيع' && card.movements.at(-1)!.sign === -1, 'lot card shows production consumption as outflow');
  // فصل اللوتات
  const run = await li.lotRun(ctx, O.id); const ry1 = run.lots.find((x: any) => x.batchNo === 'Y1')!, ry2 = run.lots.find((x: any) => x.batchNo === 'Y2')!;
  near(ry1.sharePercent, 60, 'Y1 share 60%'); near(ry2.sharePercent, 40, 'Y2 share 40%'); near(ry1.attributedOutput, 54, 'Y1 attributed output 90×60%'); near(ry2.attributedOutput, 36, 'Y2 attributed output'); near(ry1.cost, 600, 'Y1 cost'); ok(ry1.posted && run.lots.some((x: any) => x.itemCode !== ry1.itemCode && x.attributedOutput === null), 'non-main component lots get no output attribution');
  // عكس
  ok(await li.reverseLineLots(ctx, pool, order, line1) === true, 'reverse handled lots'); near(await bal(Y1), 60, 'Y1 restored'); near(await bal(Y2), 50, 'Y2 restored');
  const wac = Number((await q(`SELECT weighted_average_cost FROM stock_balances WHERE batch_id=$1`, [Y1])).rows[0].weighted_average_cost); near(wac, 10, 'Y1 restored at its own cost');
  ok(await li.reverseLineLots(ctx, pool, order, { id: Z('0000000000ee'), component_item_id: YARN }) === false, 'reverse without lots → false (legacy path)');
  await q(`UPDATE production_orders SET status='posted' WHERE id=$1`, [O.id]); await rej(() => li.setLineLots(ctx, O.id, L1, { lots: [{ batchId: Y1, quantity: 10 }] }), /المسودة فقط/, 'posted order cannot change lots');
  denied.add('textile.lots.view'); await rej(() => li.orderLots(ctx, O.id), /DENIED/, 'view needs permission'); denied.clear();
  console.log(`LOTISSUE: ${pass} passed, ${fail} failed`); await pool.end(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });

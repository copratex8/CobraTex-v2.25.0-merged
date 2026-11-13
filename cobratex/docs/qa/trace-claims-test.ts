import * as tr from '@/modules/manufacturing/textileTraceService';
import * as dl from '@/modules/manufacturing/textileDeliveryService';
import { pool } from '@/db/pool';

const Z = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`;
const denied = new Set<string>();
const ctx: any = { companyId: Z('0000000000c1'), tenantId: Z('0000000000a1'), userId: Z('000000000f00'), assertPermission(c: string) { if (denied.has(c)) throw new Error('DENIED:' + c); }, visibleBranchIds: () => null };
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const rej = async (fn: () => Promise<unknown>, re: RegExp, m: string) => { try { await fn(); ok(false, m + ' (no error)'); } catch (e: any) { ok(re.test(e.message), m + ' → ' + String(e.message).slice(0, 100)); } };
const BR = Z('0000000000b1'), C1 = Z('000000000009'), C2 = Z('000000000019'), FAB = Z('000000000102'), YARN = Z('000000000101'), WH = Z('000000000001'), BOM = Z('000000000002'), FP = Z('000000000003'), S1 = Z('0000000000e1');

(async () => {
  await pool.query(`SET session_replication_role=replica; INSERT INTO customers(id,company_id,code,name_ar,name_en,currency_code,linked_account_id) SELECT '${C2}',company_id,'C2','عميل 2','c2',currency_code,linked_account_id FROM customers WHERE id='${C1}'; SET session_replication_role=origin;`);
  const mkOrder = async (no: string) => (await pool.query(`INSERT INTO production_orders(company_id,branch_id,warehouse_id,bom_id,output_item_id,document_number,fiscal_period_id,order_date,currency_code,planned_output_quantity,status) VALUES ($1,$2,$3,$4,$5,$6,$7,'2026-10-10','EGP',1000,'posted') RETURNING id`, [ctx.companyId, BR, WH, BOM, FAB, no, FP])).rows[0].id;
  const oA = await mkOrder('T-A'), oB = await mkOrder('T-B'), oC = await mkOrder('T-C');
  const mkRoll = async (no: string, ord: string, w: number) => (await dl.createRollWithDefects(ctx, { rollNo: no, productionOrderId: ord, itemId: FAB, lengthM: 100, widthCm: 150, weightKg: w, defects: [] })).id;
  const rA1 = await mkRoll('TR-A1', oA, 80), rA2 = await mkRoll('TR-A2', oA, 82), rB1 = await mkRoll('TR-B1', oB, 79), rC1 = await mkRoll('TR-C1', oC, 81);
  // تسجيل اللوطات: اللوط L-77 دخل الأمرين A وB؛ C استعمل لوطًا آخر
  await tr.recordLot(ctx, { productionOrderId: oA, itemId: YARN, lotRef: ' L-77 ', quantity: 300 });
  await tr.recordLot(ctx, { productionOrderId: oB, itemId: YARN, lotRef: 'L-77', quantity: 200 });
  await tr.recordLot(ctx, { productionOrderId: oC, itemId: YARN, lotRef: 'L-88', quantity: 400 });
  await tr.recordLot(ctx, { productionOrderId: oA, itemId: YARN, lotRef: 'L-90', quantity: 100, notes: 'لوط ثانٍ' });
  await rej(() => tr.recordLot(ctx, { productionOrderId: oA, itemId: YARN, lotRef: 'L-77', quantity: 1 }), /مسجَّل بالفعل/, 'duplicate lot on same order+item');
  await rej(() => tr.recordLot(ctx, { productionOrderId: Z('777'), itemId: YARN, lotRef: 'X', quantity: 1 }), /غير موجود/, 'unknown order');
  await rej(() => tr.recordLot(ctx, { productionOrderId: oA, itemId: Z('999'), lotRef: 'X', quantity: 1 }), /الصنف/, 'unknown item');
  await rej(() => tr.recordLot(ctx, { productionOrderId: oA, itemId: YARN, lotRef: 'X', fiberLotId: Z('999'), quantity: 1 }), /لوط ألياف/, 'unknown fiber lot');
  denied.add('textile.trace.manage'); await rej(() => tr.recordLot(ctx, { productionOrderId: oA, itemId: YARN, lotRef: 'Q', quantity: 1 }), /DENIED/, 'recordLot permission'); denied.clear();
  ok((await tr.listOrderLots(ctx, oA)).length === 2 && (await tr.listOrderLots(ctx, oA)).some((l: any) => l.lot_ref === 'L-77'), 'lot_ref trimmed, 2 lots on A');

  // أذون تسليم: A1 و B1 لعميل 1 ، A2 لعميل 2 ، C1 بالمخزن
  const n1 = await dl.createDeliveryNote(ctx, { branchId: BR, customerId: C1, noteDate: '2026-10-25', packingUnitIds: [], fabricRollIds: [rA1, rB1] });
  const n2 = await dl.createDeliveryNote(ctx, { branchId: BR, customerId: C2, noteDate: '2026-10-26', packingUnitIds: [], fabricRollIds: [rA2] });

  // تتبّع أمامي (سحب لوط L-77)
  const t = await tr.trace(ctx, { lotRef: 'L-77' }) as any;
  ok(t.found && t.totalIssuedQty === 500 && t.orders.length === 2, 'lot L-77: 500 kg across 2 orders');
  ok(t.rolls.length === 3 && t.rolls.filter((r: any) => r.delivered).length === 3, 'lot L-77 → rolls of A and B only (A1,A2,B1), all delivered');
  const c1 = t.recall.customers.find((c: any) => c.customerId === C1), c2 = t.recall.customers.find((c: any) => c.customerId === C2);
  ok(c1.rolls === 2 && Math.abs(c1.meters - 200) < 0.01 && Math.abs(c1.kg - 159) < 0.01, 'recall customer1: 2 rolls, 200 m, 159 kg');
  ok(c2.rolls === 1 && Math.abs(c2.kg - 82) < 0.01, 'recall customer2: 1 roll 82 kg');
  ok(!t.rolls.some((r: any) => r.roll_no === 'TR-C1'), 'unrelated order roll not in recall');
  const t88 = await tr.trace(ctx, { lotRef: 'L-88' }) as any; ok(t88.recall.customers.length === 0 && t88.recall.inStockRolls === 1, 'L-88 never delivered: 1 roll in stock');
  const none = await tr.trace(ctx, { lotRef: 'NOPE' }) as any; ok(none.found === false && none.rolls.length === 0, 'unknown lot → found=false');

  // تتبّع خلفي من الرول
  const br = await tr.trace(ctx, { rollNo: 'TR-A1' }) as any;
  ok(br.order.document_number === 'T-A' && br.materialLots.length === 2 && br.delivered[0].customer_name === 'عميل 1' && br.traceComplete, 'roll TR-A1 → order, 2 lots, delivered to customer 1');
  ok((await tr.trace(ctx, { rollId: rC1 }) as any).delivered.length === 0, 'in-stock roll has no delivery');
  await rej(() => tr.trace(ctx, { rollNo: 'NOPE' }), /غير موجود/, 'unknown roll');
  const rn = await dl.createRollWithDefects(ctx, { rollNo: 'TR-NOORD', lengthM: 10, widthCm: 150, defects: [] });
  ok(!(await tr.trace(ctx, { rollId: rn.id }) as any).traceComplete, 'roll without order → traceComplete=false (honest gap)');
  // إلغاء إذن التسليم يُخرج الرول من نطاق التسليم
  await dl.cancelDeliveryNote(ctx, n2.id, 'تجربة'); ok((await tr.trace(ctx, { lotRef: 'L-77' }) as any).recall.customers.length === 1, 'cancelled delivery leaves recall scope');
  await dl.createDeliveryNote(ctx, { branchId: BR, customerId: C2, noteDate: '2026-10-27', packingUnitIds: [], fabricRollIds: [rA2] });

  // المطالبات
  denied.add('textile.claims.manage'); await rej(() => tr.createClaim(ctx, { branchId: BR, customerId: C1, claimDate: '2026-10-28', category: 'shade', description: 'اختلاف درجة' }), /DENIED/, 'claim permission'); denied.clear();
  await rej(() => tr.createClaim(ctx, { branchId: BR, customerId: C2, claimDate: '2026-10-28', category: 'shade', fabricRollId: rA1, description: 'خطأ عميل' }), /لعميل آخر/, 'roll delivered to another customer rejected');
  await rej(async () => tr.createClaim(ctx, { branchId: BR, customerId: C1, claimDate: '2026-10-28', category: 'shade', deliveryNoteId: (await dl.listDeliveryNotes(ctx, {})).find((n: any) => n.customer_id === C2).id, description: 'خطأ' }), /لعميل آخر/, 'delivery note of another customer rejected');
  await rej(() => tr.createClaim(ctx, { branchId: BR, customerId: Z('999'), claimDate: '2026-10-28', category: 'shade', description: 'خطأ' }), /العميل/, 'unknown customer');
  const k1 = await tr.createClaim(ctx, { branchId: BR, customerId: C1, claimDate: '2026-10-28', category: 'shade', severity: 'major', fabricRollId: rA1, claimedQuantity: 80, claimedUnit: 'kg', claimedValue: 4000, description: 'اختلاف درجة اللون عن العينة' });
  ok(/^CL-2026-\d{5}$/.test(k1.claim_no) && k1.delivery_note_id === n1.id, 'claim auto-links the delivery note of the roll');
  const k2 = await tr.createClaim(ctx, { branchId: BR, customerId: C1, claimDate: '2026-10-29', category: 'defect', fabricRollId: rB1, claimedValue: 1000, description: 'عيوب نسيج' });
  const full = await tr.getClaim(ctx, k1.id); ok(full.trace.order.document_number === 'T-A' && full.trace.materialLots.some((l: any) => l.lot_ref === 'L-77'), 'claim detail carries the trace (order + lots)');
  ok((await tr.trace(ctx, { lotRef: 'L-77' }) as any).claims.length === 2, 'lot trace lists related claims');

  // دورة الحالة
  await rej(() => tr.updateClaimStatus(ctx, k1.id, { status: 'settled', resolution: 'credit_note', settledValue: 1 }), /لا يمكن الانتقال/, 'cannot settle from open');
  await tr.updateClaimStatus(ctx, k1.id, { status: 'investigating' });
  await rej(() => tr.updateClaimStatus(ctx, k1.id, { status: 'accepted' }), /السبب الجذري/, 'accept requires root cause');
  const st = (await pool.query(`SELECT id FROM textile_stages LIMIT 1`)).rows[0].id;
  await rej(() => tr.updateClaimStatus(ctx, k1.id, { status: 'accepted', rootCause: 'درجة حرارة الصباغة', rootCauseStageId: Z('555') }), /المرحلة/, 'unknown stage');
  const a = await tr.updateClaimStatus(ctx, k1.id, { status: 'accepted', rootCause: 'درجة حرارة الصباغة', rootCauseStageId: st }); ok(a.status === 'accepted' && !a.closed_at, 'accepted, not closed');
  await rej(() => tr.updateClaimStatus(ctx, k1.id, { status: 'settled', resolution: 'credit_note' }), /نوع الحل وقيمته/, 'settle needs value');
  await rej(() => tr.updateClaimStatus(ctx, k1.id, { status: 'settled', resolution: 'none', settledValue: 5 }), /بلا/, 'resolution none cannot carry value');
  const s = await tr.updateClaimStatus(ctx, k1.id, { status: 'settled', resolution: 'credit_note', settledValue: 2500 }); ok(s.status === 'settled' && !!s.closed_at && Number(s.settled_value) === 2500, 'settled & closed with value');
  await rej(() => tr.updateClaimStatus(ctx, k1.id, { status: 'investigating' }), /لا يمكن الانتقال/, 'closed claim is final');
  await rej(() => tr.updateClaimStatus(ctx, k2.id, { status: 'rejected' }), /سبب الرفض/, 'reject requires reason');
  const rj = await tr.updateClaimStatus(ctx, k2.id, { status: 'rejected', note: 'العيب ضمن حدود القبول 4 نقاط' }); ok(rj.status === 'rejected' && !!rj.closed_at, 'rejected & closed');
  // قيد قاعدة البيانات مستقل عن الخدمة
  await rej(async () => pool.query(`UPDATE quality_claims SET status='settled', closed_at=now() WHERE id=$1`, [(await tr.createClaim(ctx, { branchId: BR, customerId: C1, claimDate: '2026-10-30', category: 'packing', description: 'تغليف تالف' })).id]), /check|violates/i, 'DB check: settled needs resolution/value/root cause');

  // التقرير
  const k3 = await tr.createClaim(ctx, { branchId: BR, customerId: C2, claimDate: '2026-10-30', category: 'shade', claimedValue: 500, description: 'درجة' });
  const rep = await tr.claimsReport(ctx, { from: '2026-10-01', to: '2026-10-31' });
  ok(rep.total === 4 && rep.open === 2 && rep.accepted === 1 && rep.rejected === 1, `report counts total4/open2/accepted1/rejected1 got ${rep.total}/${rep.open}/${rep.accepted}/${rep.rejected}`);
  ok(rep.settledValue === 2500 && rep.claimedValue === 5500, 'report values'); ok(rep.byCategory[0].key === 'shade' && rep.byCategory[0].count === 2, 'by category sorted by count');
  ok(rep.byStage.length === 1 && rep.byStage[0].count === 1, 'by root-cause stage'); ok(rep.byCustomer.find((c: any) => c.key === C1).count === 3, 'by customer'); ok(rep.avgDaysToClose !== null, 'avg days to close computed');
  ok((await tr.listClaims(ctx, { status: 'open' })).length === 2 && (await tr.listClaims(ctx, { customerId: C2 })).length === 1, 'list filters');
  const au = (globalThis as any).__audit.map((a: any) => a.entityType); ok(au.includes('order_material_lot') && au.includes('quality_claim'), 'audit trail');
  console.log(`\nTRACE RESULT: ${pass} passed, ${fail} failed`);
  (await import('/tmp/final/stubs/pool.js') as any).__closeAll(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e); process.exit(2); });

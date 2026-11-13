import * as sl from '@/modules/manufacturing/textileSalesLinkService';
import * as dl from '@/modules/manufacturing/textileDeliveryService';
import * as ut from '@/modules/manufacturing/textileUtilitiesService';
import * as hr from '@/modules/manufacturing/textileHrService';
import * as ops from '@/modules/manufacturing/textileOpsService';
import { simulatorDefaults } from '@/modules/manufacturing/textileSimulatorRoutes';

const Z = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`;
const denied = new Set<string>();
const ctx: any = { companyId: Z('0000000000c1'), tenantId: Z('0000000000a1'), userId: Z('000000000f00'), assertPermission(c: string) { if (denied.has(c)) throw new Error('DENIED:' + c); }, visibleBranchIds: () => null };
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const near = (a: number, b: number, m: string) => ok(Math.abs(Number(a) - b) < 0.006, `${m}: expected ${b} got ${a}`);
const rej = async (fn: () => Promise<unknown>, re: RegExp, m: string) => { try { await fn(); ok(false, m + ' (no error)'); } catch (e: any) { ok(re.test(e.message), m + ' → ' + String(e.message).slice(0, 90)); } };
const BR = Z('0000000000b1'), CUST = Z('000000000009'), FP = Z('000000000003'), S1 = Z('0000000000e1'), SAFE = Z('0000000000aa');
const L = (n: number) => Z('0000000006a' + n), PO = (n: string) => Z('000000000a' + n);

(async () => {
  /* ============ ١) ربط البيع بالتصنيع ============ */
  let t = await sl.tracking(ctx, {});
  const st = (n: number) => t.lines.find((x: any) => x.lineId === L(n))?.status;
  ok(st(1) === 'on_track', 'L1 on_track got ' + st(1)); ok(st(2) === 'at_risk', 'L2 at_risk got ' + st(2)); ok(st(3) === 'late', 'L3 late got ' + st(3));
  ok(st(4) === 'delivered', 'L4 delivered got ' + st(4)); ok(st(5) === 'unplanned', 'L5 unplanned got ' + st(5)); ok(st(6) === 'short', 'L6 short (98/100, all posted) got ' + st(6));
  ok(!t.lines.some((x: any) => x.salesOrderNo === 'SO-2'), 'draft sales order excluded');
  ok(t.summary.late === 1 && t.summary.short === 1, 'summary counts');
  t = await sl.tracking(ctx, { status: 'late' }); ok(t.lines.length === 1, 'status filter');
  await rej(() => sl.setPromise(ctx, L(1), { promisedDate: '2026-12-15' }), /سبب/, 'changing promise requires reason');
  await sl.setPromise(ctx, L(1), { promisedDate: '2026-12-15', reason: 'تأخر مواد' });
  const h = await sl.promiseHistory(ctx, L(1)); ok(h.length === 1 && h[0].new_date.startsWith('2026-12-15') && h[0].old_date.startsWith('2026-12-01'), 'promise history recorded old→new');
  await sl.setPromise(ctx, L(5), { promisedDate: '2026-12-31', reason: 'اتفاق مع العميل' }); ok(true, 'promise change with reason');
  await rej(() => sl.linkOrder(ctx, L(1), PO('08')), /صنف/, 'link rejects item mismatch');
  await rej(() => sl.linkOrder(ctx, L(1), PO('05')), /آخر/, 'link rejects order bound to another line');
  await rej(() => sl.linkOrder(ctx, Z('0000000006b1'), PO('07')), /المؤكَّدة/, 'link rejects draft sales order');
  const lk = await sl.linkOrder(ctx, L(5), PO('07')); ok(lk.linked, 'link free order to L5');
  await rej(() => sl.unlinkOrder(ctx, PO('06')), /مرحَّل/, 'cannot unlink posted order');
  await sl.unlinkOrder(ctx, PO('07')); ok(true, 'unlink draft order');
  const cr = await sl.createFromLine(ctx, L(5), { branchId: BR, warehouseId: Z('000000000001'), bomId: Z('000000000002'), fiscalPeriodId: FP, orderDate: '2026-10-31' });
  near(Number(cr.plannedQuantity), 60, 'createFromLine defaults to remaining 60 (100-40)');
  await rej(() => sl.createFromLine(ctx, L(5), { branchId: BR, warehouseId: Z('000000000001'), bomId: Z('000000000003'), fiscalPeriodId: FP, orderDate: '2026-10-31' }), /مخرج/, 'createFromLine rejects BOM of other item');
  await rej(() => sl.createFromLine(ctx, L(6), { branchId: BR, warehouseId: Z('000000000001'), bomId: Z('000000000002'), fiscalPeriodId: FP, orderDate: '2026-10-31' }), /بالكامل/, 'fully planned line rejected');
  denied.add('textile.sales_link.manage'); await rej(() => sl.setPromise(ctx, L(2), { promisedDate: '2026-12-20', reason: 'x' }), /DENIED:textile\.sales_link\.manage/, 'setPromise requires manage permission'); denied.clear();

  /* ============ ٢) العيوب ============ */
  const s1 = await dl.seedDefectCatalog(ctx), s2 = await dl.seedDefectCatalog(ctx);
  ok(s1.added === 11 && s2.added === 0, `seed catalog 11 then idempotent 0 (got ${s1.added}/${s2.added})`);
  const types = await dl.listDefectTypes(ctx); const T = (c: string) => types.find((x: any) => x.code === c).id;
  const roll1 = await dl.createRollWithDefects(ctx, { rollNo: 'R-1', lengthM: 100, widthCm: 150, weightKg: 80, defects: [{ defectTypeId: T('K-HOL'), occurrences: 2 }, { defectTypeId: T('W-SLB'), occurrences: 1 }] });
  ok(roll1.totalPoints === 9, 'roll points 2×4+1×1=9'); ok(Math.abs(Number(roll1.points_per_100sqyd) - 5.02) < 0.02, 'points/100yd² ≈ 5.02 (100m×150cm=179.4yd²), got ' + roll1.points_per_100sqyd); ok(roll1.grade === 'A', 'grade A');
  const roll2 = await dl.createRollWithDefects(ctx, { rollNo: 'R-2', lengthM: 50, widthCm: 150, defects: [{ defectTypeId: T('D-SHD'), occurrences: 10 }] });
  ok(roll2.grade === 'C', 'roll with 40 points over 50m = grade C, got ' + roll2.grade);
  await rej(() => dl.createRollWithDefects(ctx, { rollNo: 'R-1', lengthM: 10, widthCm: 150, defects: [] }), /مستخدم/, 'duplicate roll no → ConflictError');
  await rej(() => dl.createRollWithDefects(ctx, { rollNo: 'R-3', lengthM: 10, widthCm: 150, defects: [{ defectTypeId: Z('999'), occurrences: 1 }] }), /غير موجود/, 'unknown defect type rejected');
  const roll0 = await dl.createRollWithDefects(ctx, { rollNo: 'R-0', lengthM: 10, widthCm: 150, defects: [] }); ok(roll0.grade === 'A' && roll0.totalPoints === 0, 'clean roll = A, 0 points');
  const pareto = await dl.defectPareto(ctx, {});
  ok(pareto[0].code === 'D-SHD' && pareto[0].points === 40 && pareto[pareto.length - 1].cumulativePercent === 100, 'pareto sorted, cumulative=100');

  /* ============ ٣) إذن التسليم + الفاتورة ============ */
  const sh = await dl.shippable(ctx); ok(sh.units.length === 2 && sh.rolls.length === 3, `shippable 2 units / 3 rolls got ${sh.units.length}/${sh.rolls.length}`);
  await rej(() => dl.createDeliveryNote(ctx, { branchId: BR, customerId: Z('999'), noteDate: '2026-10-31', packingUnitIds: [Z('0000000007a1')], fabricRollIds: [] }), /العميل/, 'unknown customer rejected');
  const dn = await dl.createDeliveryNote(ctx, { branchId: BR, customerId: CUST, noteDate: '2026-10-31', vehicleNo: 'ABC', packingUnitIds: [Z('0000000007a1')], fabricRollIds: [roll1.id] });
  ok(/^DN-2026-\d{5}$/.test(dn.note_no), 'note number format ' + dn.note_no);
  await rej(() => dl.createDeliveryNote(ctx, { branchId: BR, customerId: CUST, noteDate: '2026-10-31', packingUnitIds: [Z('0000000007a1')], fabricRollIds: [] }), /مشحونة/, 'double-ship packing unit rejected');
  await rej(() => dl.createDeliveryNote(ctx, { branchId: BR, customerId: CUST, noteDate: '2026-10-31', packingUnitIds: [], fabricRollIds: [roll1.id] }), /مُدرج/, 'double-ship roll rejected (unique index)');
  const doc = await dl.deliveryNoteDoc(ctx, dn.id); near(doc.totals.netKg, 100, 'doc net kg 100'); ok(doc.totals.unitsCount === 1 && doc.totals.rollsCount === 1, 'doc counts');
  ok((await dl.shippable(ctx)).units.length === 1, 'shipped unit leaves shippable');
  const cands = await dl.invoiceCandidates(ctx, dn.id); ok(cands.length === 1 && cands[0].document_number === 'INV-1', 'candidates: only same-customer non-cancelled');
  await rej(() => dl.linkInvoice(ctx, dn.id, Z('0000000008a3')), /عميل/, 'link other-customer invoice rejected');
  await rej(() => dl.linkInvoice(ctx, dn.id, Z('0000000008a2')), /ملغاة/, 'link cancelled invoice rejected');
  await dl.linkInvoice(ctx, dn.id, Z('0000000008a1'));
  const rec = await dl.invoiceReconciliation(ctx, Z('0000000008a1')); const ri = rec.items.find((x: any) => x.itemName);
  near(ri.invoicedQty, 150, 'recon invoiced 150'); near(ri.deliveredKg, 100, 'recon bale kg 100'); const rn = rec.items.find((x: any) => x.itemId === null); ok(!!rn && rn.notInvoice && Math.abs(rn.deliveredKg - 80) < 0.01 && Math.abs(rn.deliveredMeters - 100) < 0.01, 'roll without item shown in its own row (80 kg, 100 m)');
  const doc2 = await dl.deliveryNoteDoc(ctx, dn.id); ok(doc2.note.sales_invoice_no === 'INV-1', 'doc shows invoice no');
  await dl.cancelDeliveryNote(ctx, dn.id, 'خطأ إدخال');
  ok((await dl.shippable(ctx)).units.length === 2, 'cancel restores packing units');
  await rej(() => dl.cancelDeliveryNote(ctx, dn.id, 'مرة ثانية'), /ملغى/, 'double cancel rejected');
  await rej(() => dl.linkInvoice(ctx, dn.id, Z('0000000008a1')), /ملغى/, 'cannot link cancelled note');

  /* ============ ٤) المرافق ============ */
  await ut.createBill(ctx, { branchId: BR, kind: 'electricity', periodFrom: '2026-10-01', periodTo: '2026-10-31', totalCost: 4000 });
  await ut.createBill(ctx, { branchId: BR, kind: 'steam', periodFrom: '2026-10-01', periodTo: '2026-10-31', totalCost: 1000, driver: 'run_hours' });
  await ut.createBill(ctx, { branchId: BR, kind: 'water', periodFrom: '2026-08-01', periodTo: '2026-08-31', totalCost: 500 });
  const ar = await ut.allocationReport(ctx, { from: '2026-08-01', to: '2026-10-31' });
  const sp = ar.stages.find((x: any) => x.stageName === 'غزل'), wv = ar.stages.find((x: any) => x.stageName === 'نسيج');
  near(sp.byKind.electricity, 3000, 'electricity → spinning 3000 (300/400 kWh)'); near(wv.byKind.electricity, 1000, 'electricity → weaving 1000');
  near(sp.byKind.steam, 500, 'steam by run hours 50/50'); near(ar.grandTotal, 5000, 'grand total = distributed bills only (water had no logs)');
  ok(ar.warnings.some((w: string) => /لا سجلات/.test(w)), 'warning for bill without logs');
  near(sp.costPerUnit, 3500 / 100, 'cost/unit spinning = 3500/100'); 
  await rej(() => ut.createBill(ctx, { branchId: BR, kind: 'gas', periodFrom: '2026-10-05', periodTo: '2026-10-01', totalCost: 1 }), /[Zz]od|نهاية|violates|check/, 'period_to<from rejected by DB check');
  await ut.deleteBill(ctx, (await ut.listBills(ctx, {})).find((b: any) => b.kind === 'water').id); ok(true, 'delete bill');

  /* ============ ٥) المحاكي ============ */
  const sd = await simulatorDefaults(ctx); ok(sd.length === 2 && sd.find((x: any) => x.name === 'غزل').units === 2, 'simulator defaults from machines');

  /* ============ ٦) الحضور والرواتب ============ */
  const W1 = Z('000000000b01'), W2 = Z('000000000b02'), W3 = Z('000000000b03');
  await hr.updateWorkerPay(ctx, W3, { payType: 'hourly', baseRate: 20 }); await hr.updateWorkerPay(ctx, W3, { payType: 'monthly', baseRate: 0 }); // يعود بلا أجر
  const day = (d: number) => `2026-10-${String(d).padStart(2, '0')}`;
  for (let d = 1; d <= 23; d++) await hr.saveAttendance(ctx, { workDate: day(d), records: [{ workerId: W1, status: 'present' }, { workerId: W2, status: d <= 20 ? 'present' : d === 21 ? 'holiday' : 'absent' }] });
  await hr.saveAttendance(ctx, { workDate: day(24), records: [{ workerId: W1, status: 'present', overtimeHours: 10, lateMinutes: 60 }, { workerId: W2, status: 'absent' }] });
  await hr.saveAttendance(ctx, { workDate: day(25), records: [{ workerId: W1, status: 'absent' }, { workerId: W2, status: 'weekly_off' }] });
  await rej(() => hr.saveAttendance(ctx, { workDate: day(26), records: [{ workerId: W1, status: 'present' }, { workerId: W1, status: 'absent' }] }), /مكرر/, 'duplicate worker in a day rejected');
  await hr.saveAttendance(ctx, { workDate: day(1), records: [{ workerId: W1, status: 'present', checkIn: '08:00', checkOut: '18:00' }] }); // تعديل (upsert): 10 ساعات → إضافي 2
  const a1 = (await hr.listAttendance(ctx, { date: day(1) })).find((x: any) => x.worker_id === W1); near(a1.hours_worked, 10, 'upsert recalculates hours'); near(a1.overtime_hours, 2, 'auto overtime = hours-8');
  await hr.saveAttendance(ctx, { workDate: day(1), records: [{ workerId: W1, status: 'present' }] }); // إرجاع
  await hr.createAdjustment(ctx, { workerId: W1, adjDate: day(5), kind: 'advance', amount: 300 });
  await hr.createAdjustment(ctx, { workerId: W1, adjDate: day(6), kind: 'allowance', amount: 200 });
  await hr.createAdjustment(ctx, { workerId: W1, adjDate: day(7), kind: 'penalty', amount: 100 });
  await ops.createIncentiveRate(ctx, { unit: 'kg', ratePerUnit: '0.5', effectiveFrom: '2026-01-01' });
  await ops.addWorkerLog(ctx, { branchId: BR, shift: 'morning', unit: 'kg', workerId: W1, stageId: S1, logDate: day(10), quantity: '1000' });
  denied.add('textile.payroll.manage'); await rej(() => hr.createRun(ctx, { month: '2026-10', workingDays: 25 }), /DENIED:textile\.payroll\.manage/, 'createRun requires payroll.manage'); denied.clear();
  const run = await hr.createRun(ctx, { month: '2026-10', workingDays: 25 });
  near(run.total_net, 5846.4 + 4200, 'run total net = W1 5846.4 + W2 4200');
  const det = await hr.getRun(ctx, run.id); const l1 = det.lines.find((x: any) => x.code === 'W1'), l2 = det.lines.find((x: any) => x.code === 'W2');
  ok(det.lines.length === 2, 'worker without rate excluded');
  near(l1.base_pay, 5760, 'W1 base'); near(l1.overtime_pay, 450, 'W1 overtime'); near(l1.incentive, 500, 'W1 incentive from output log'); near(l1.allowances, 200, 'W1 allowances');
  near(l1.insurance, 633.6, 'W1 insurance 11%'); near(l1.employer_insurance, 1080, 'W1 employer insurance 18.75%'); near(l1.late_deduction, 30, 'W1 late'); near(l1.advances, 300, 'W1 advance'); near(l1.penalties, 100, 'W1 penalty'); near(l1.net, 5846.4, 'W1 net');
  near(l2.base_pay, 4200, 'W2 daily: (20 present+1 holiday)×200'); near(l2.net, 4200, 'W2 net'); ok(Number(l2.days_absent) === 3, 'W2 absent days = 3 got ' + l2.days_absent);
  await rej(() => hr.createRun(ctx, { month: '2026-10', workingDays: 25 }), /يوجد كشف/, 'second run same month rejected');
  await hr.createAdjustment(ctx, { workerId: W1, adjDate: day(8), kind: 'bonus', amount: 50 });
  const rc = await hr.recalcRun(ctx, run.id); near(rc.total_net, 5896.4 + 4200, 'recalc after bonus +50');
  await rej(() => hr.postRun(ctx, run.id, { branchId: BR, fiscalPeriodId: FP, entryDate: '2026-10-31' }), /المعتمد/, 'cannot post a draft run');
  denied.add('textile.payroll.approve'); await rej(() => hr.approveRun(ctx, run.id), /DENIED/, 'approve requires approve permission'); denied.clear();
  await hr.approveRun(ctx, run.id);
  await rej(() => hr.recalcRun(ctx, run.id), /للمسودة/, 'cannot recalc approved');
  const adjId = (await hr.listAdjustments(ctx, { month: '2026-10' }))[0].id;
  await rej(() => hr.deleteAdjustment(ctx, adjId), /معتمد/, 'cannot delete adjustment of approved month');
  await rej(() => hr.payRun(ctx, run.id, { branchId: BR, safeOrBankId: SAFE, fiscalPeriodId: FP, transactionDate: '2026-10-31' }), /رحِّل/, 'cannot pay before posting');
  denied.add('textile.payroll.post'); await rej(() => hr.postRun(ctx, run.id, { branchId: BR, fiscalPeriodId: FP, entryDate: '2026-10-31' }), /DENIED/, 'post requires post permission'); denied.clear();
  const pr = await hr.postRun(ctx, run.id, { branchId: BR, fiscalPeriodId: FP, entryDate: '2026-10-31' });
  const je = (globalThis as any).__je.at(-1); const sumL = (k: 'debit' | 'credit') => je.input.lines.reduce((s: number, l: any) => s + Number(l[k]), 0);
  near(sumL('debit'), sumL('credit'), 'journal entry balanced');
  // إجمالي = 6910+50 + 4200 ؛ تأخير 30 ؛ جزاء 100 ؛ + تأمين صاحب العمل 1080
  near(pr.amounts.wagesExpense, 6960 + 4200 - 30 - 100 + 1080, 'wages expense = gross − late − penalties + employer share'); near(pr.amounts.insurancePayable, 633.6 + 1080, 'insurance payable'); near(pr.amounts.advancesRecovered, 300, 'advances'); near(pr.amounts.salariesPayable, 5896.4 + 4200, 'salaries payable = net');
  ok(je.input.sourceDocumentType === 'payroll_run' && je.input.lines.length === 4, 'JE has 4 lines & source payroll_run');
  await rej(() => hr.postRun(ctx, run.id, { branchId: BR, fiscalPeriodId: FP, entryDate: '2026-10-31' }), /بالفعل/, 'double post rejected');
  await rej(() => hr.cancelRun(ctx, run.id, 'سبب'), /مُرحَّل/, 'cannot cancel posted run');
  const net = 5896.4 + 4200;
  await rej(() => hr.payRun(ctx, run.id, { branchId: BR, safeOrBankId: SAFE, fiscalPeriodId: FP, transactionDate: '2026-10-31', amount: net + 1 }), /يتجاوز/, 'overpay rejected');
  const p1 = await hr.payRun(ctx, run.id, { branchId: BR, safeOrBankId: SAFE, fiscalPeriodId: FP, transactionDate: '2026-10-31', amount: 4000 });
  near(p1.remaining, net - 4000, 'partial pay remaining');
  const p2 = await hr.payRun(ctx, run.id, { branchId: BR, safeOrBankId: SAFE, fiscalPeriodId: FP, transactionDate: '2026-10-31' }); near(p2.amount, net - 4000, 'second pay defaults to remaining'); near(p2.remaining, 0, 'fully paid');
  await rej(() => hr.payRun(ctx, run.id, { branchId: BR, safeOrBankId: SAFE, fiscalPeriodId: FP, transactionDate: '2026-10-31' }), /بالكامل/, 'pay after full rejected');
  const tx = (globalThis as any).__tx; ok(tx.length === 2 && tx.every((x: any) => x.input.contraAccountId && x.input.counterpartyType === 'other' && x.status === 'posted'), 'two posted treasury payments vs salaries-payable account');
  const dr = await hr.getRun(ctx, run.id); near(dr.paid, net, 'run.paid'); near(dr.remaining, 0, 'run.remaining 0');
  await rej(() => hr.unpostRun(ctx, run.id, 'سبب كافٍ'), /دفعات/, 'cannot unpost while payments exist');
  await rej(() => hr.unpayRun(ctx, run.id, { reason: 'سبب كافٍ' }), /paymentId/, 'unpay needs paymentId when several');
  await hr.unpayRun(ctx, run.id, { reason: 'سبب كافٍ', paymentId: dr.payments[0].id }); await hr.unpayRun(ctx, run.id, { reason: 'سبب كافٍ' });
  ok((await hr.getRun(ctx, run.id)).payments.length === 0 && tx.every((x: any) => x.status === 'reversed'), 'both payments reversed');
  await hr.unpostRun(ctx, run.id, 'سبب كافٍ'); ok(!(await hr.getRun(ctx, run.id)).run.journal_entry_id, 'unpost clears JE link');
  await hr.cancelRun(ctx, run.id, 'إلغاء للاختبار'); ok((await hr.getRun(ctx, run.id)).run.status === 'cancelled', 'cancel after unpost works');
  const run2 = await hr.createRun(ctx, { month: '2026-10', workingDays: 25 }); ok(run2.id !== run.id, 'new run allowed after cancel (partial unique index)');
  const setg = await hr.getPostingSettings(ctx); ok(!!setg.wages_expense_account_id, 'posting settings auto-created'); const setg2 = await hr.getPostingSettings(ctx); ok(setg.wages_expense_account_id === setg2.wages_expense_account_id, 'settings idempotent');
  // شهر بلا حضور: تحذير
  const run3 = await hr.createRun(ctx, { month: '2026-09', workingDays: 26 }); ok(run3.noAttendance.length === 2, 'month without attendance warns both workers');

  /* ============ ٧) استيراد البصمة + الإجازات ============ */
  const punches = [
    { workerCode: 'W1', timestamp: '2026-11-02 08:20' }, { workerCode: 'W1', timestamp: '2026-11-02 18:00' }, { workerCode: 'W2', timestamp: '2026-11-02 08:00' },
    { workerCode: 'W9', timestamp: '2026-11-02 08:00' }, { workerCode: 'W1', timestamp: 'bad' },
  ];
  const dry = await hr.importPunches(ctx, { punches, shiftStart: '08:00', graceMinutes: 10, dryRun: true });
  ok(dry.daysParsed === 3 && dry.saved === 0 && dry.unknownWorkers.join() === 'W9' && dry.invalidPunches.length === 1 && dry.singlePunchDays.length === 1, 'import dry-run summary');
  const real = await hr.importPunches(ctx, { punches, shiftStart: '08:00', graceMinutes: 10 }); ok(real.saved === 2, 'import saved 2 known workers');
  const imp = await hr.listAttendance(ctx, { date: '2026-11-02' }); const i1 = imp.find((x: any) => x.worker_id === W1), i2 = imp.find((x: any) => x.worker_id === W2);
  near(i1.hours_worked, 9.67, 'W1 hours 08:20→18:00'); near(i1.overtime_hours, 1.67, 'W1 overtime'); ok(i1.late_minutes === 10, 'W1 late = 20-10 grace'); near(i2.hours_worked, 8, 'single punch → std hours');
  await hr.saveAttendance(ctx, { workDate: '2026-11-03', records: [{ workerId: W1, status: 'leave_paid' }, { workerId: W2, status: 'sick' }] });
  await hr.updateWorkerPay(ctx, W2, { payType: 'daily', baseRate: 200, hireDate: '2026-07-10' });
  const lb = await hr.leaveBalance(ctx, { year: 2026 }); const b1 = lb.workers.find((x: any) => x.code === 'W1'), b2 = lb.workers.find((x: any) => x.code === 'W2');
  ok(b1.entitlement === 21 && b1.used === 1 && b1.remaining === 20, 'W1 leave 21 used 1 remaining 20'); ok(b2.entitlement === 10.5, 'W2 hired July → 10.5 prorated, got ' + b2.entitlement); ok(b2.sick === 1, 'sick counted separately');

  /* ============ ٨) سجل التدقيق ============ */
  const au = (globalThis as any).__audit.map((a: any) => a.entityType); ok(['payroll_run', 'delivery_note', 'utility_bill', 'sales_order_line_promise'].every((e) => au.includes(e)), 'audit trail written for all modules');

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  (await import('/tmp/final/stubs/pool.js') as any).__closeAll();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e); process.exit(2); });

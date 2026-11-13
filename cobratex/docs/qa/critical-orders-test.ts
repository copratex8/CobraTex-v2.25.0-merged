import * as cr from '@/modules/manufacturing/textileCritical';
import { pool } from '@/db/pool';
const Z = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`;
const denied = new Set<string>();
const ctx: any = { companyId: Z('0000000000c1'), tenantId: Z('0000000000a1'), userId: Z('000000000f00'), assertPermission(c: string) { if (denied.has(c)) throw new Error('DENIED:' + c); }, visibleBranchIds: () => null };
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const rej = async (fn: () => Promise<unknown>, re: RegExp, m: string) => { try { await fn(); ok(false, m + ' (no error)'); } catch (e: any) { ok(re.test(e.message), m + ' → ' + e.message); } };
const BR = Z('0000000000b1'), WH = Z('000000000001'), BOM = Z('000000000002'), FP = Z('000000000003'), FAB = Z('000000000102'), YARN = Z('000000000101'), UOM = Z('0000000000d0'), M1 = Z('0000000000f1'), M2 = Z('0000000000f2'), SO = Z('0000000005a1');
const q = (s: string, p: any[] = []) => pool.query(s, p);
(async () => {
  // مساعدات صرفة
  ok(cr.addDays('2026-11-30', 1) === '2026-12-01' && cr.addDays('2026-03-01', -1) === '2026-02-28', 'addDays across month');
  ok(cr.diffDays('2026-11-20', '2026-11-01') === 19 && cr.diffDays('2026-11-01', '2026-11-20') === -19, 'diffDays signed');
  ok(JSON.stringify(cr.findFreeSlot([], '2026-11-01', 5)) === '{"start":"2026-11-01","end":"2026-11-05"}', 'free slot: nothing busy');
  ok(cr.findFreeSlot([{ start: '2026-11-03', end: '2026-11-06' }], '2026-11-01', 5).start === '2026-11-07', 'free slot: gap too small → after busy');
  ok(cr.findFreeSlot([{ start: '2026-11-08', end: '2026-11-09' }], '2026-11-01', 5).start === '2026-11-01', 'free slot: fits before busy');
  ok(cr.findFreeSlot([{ start: '2026-11-03', end: '2026-11-04' }, { start: '2026-11-05', end: '2026-11-09' }], '2026-11-01', 3).start === '2026-11-10', 'free slot: chained busy periods');
  const a0 = cr.assess({ due: null, plannedStart: null, plannedEnd: null, machineId: null, conflict: false, shortLines: null }, '2026-11-01', 14); ok(a0.level === 'ok' && a0.score === 0 && a0.slackDays === null, 'no due, nothing → ok');
  const a1 = cr.assess({ due: '2026-11-20', plannedStart: '2026-11-02', plannedEnd: '2026-11-10', machineId: 'm', conflict: false, shortLines: 2 }, '2026-11-01', 14); ok(a1.score === 25 && a1.level === 'ok', 'shortage alone = 25 (ok level)');
  const a2 = cr.assess({ due: '2026-11-12', plannedStart: '2026-11-02', plannedEnd: '2026-11-10', machineId: 'm', conflict: false, shortLines: 2 }, '2026-11-01', 14); ok(a2.score === 55 && a2.level === 'warning', 'slack 2 (30) + shortage (25) = 55 warning');
  const a3 = cr.assess({ due: '2026-11-12', plannedStart: '2026-11-02', plannedEnd: '2026-11-10', machineId: 'm', conflict: true, shortLines: 2 }, '2026-11-01', 14); ok(a3.score === 70 && a3.level === 'critical', '+ conflict 15 = 70 critical');

  // قاعدة حقيقية: نُبطل الأوامر المزروعة ونبني سيناريو نظيفًا (اليوم = 2026-11-01)
  await q(`UPDATE production_orders SET status='reversed'`);
  let n = 0;
  const mk = async (no: string, due: string | null, machine: string | null, s: string | null, e: string | null) => {
    let line: string | null = null;
    if (due) { line = Z('00000000cc' + String(++n).padStart(2, '0')); await q(`INSERT INTO sales_order_lines(id,sales_order_id,company_id,item_id,uom_id,quantity,unit_price,invoiced_quantity,promised_date) VALUES ($1,$2,$3,$4,$5,100,10,0,$6)`, [line, SO, ctx.companyId, YARN, UOM, due]); }
    return (await q(`INSERT INTO production_orders(company_id,branch_id,warehouse_id,bom_id,output_item_id,document_number,fiscal_period_id,order_date,currency_code,planned_output_quantity,status,machine_id,planned_start,planned_end,sales_order_line_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'2026-10-20','EGP',100,'draft',$8,$9,$10,$11) RETURNING id`, [ctx.companyId, BR, WH, BOM, FAB, no, FP, machine, s, e, line])).rows[0].id;
  };
  const A = await mk('CA', '2026-11-20', M1, '2026-11-02', '2026-11-11'), B = await mk('CB', '2026-11-18', M1, '2026-11-10', '2026-11-15'), C = await mk('CC', '2026-11-10', M2, '2026-11-05', '2026-11-20');
  const D = await mk('CD', '2026-10-20', null, '2026-10-25', '2026-11-05'), E = await mk('CE', null, null, null, null), F = await mk('CF', '2026-11-12', null, null, null);
  await q(`INSERT INTO production_orders(company_id,branch_id,warehouse_id,bom_id,output_item_id,document_number,fiscal_period_id,order_date,currency_code,planned_output_quantity,status,machine_id,planned_start,planned_end) VALUES ($1,$2,$3,$4,$5,'CPOSTED',$6,'2026-10-20','EGP',100,'posted',$7,'2026-11-12','2026-11-16')`, [ctx.companyId, BR, WH, BOM, FAB, FP, M1]); // مرحَّل: لا يُعدّ مشغولًا ولا يظهر

  const r = await cr.criticalOrders(ctx, { asOf: '2026-11-01' });
  const by = (no: string) => r.orders.find((o: any) => o.orderNo === no)!;
  ok(r.orders.length === 6 && !r.orders.some((o: any) => o.orderNo === 'CPOSTED'), 'only open (draft) orders listed');
  ok(r.orders[0].orderNo === 'CD' && r.orders[1].orderNo === 'CC' && r.orders[2].orderNo === 'CB', 'sorted by score: CD, CC, CB');
  ok(by('CD').level === 'critical' && by('CD').score === 211 && by('CD').dueInDays === -12 && by('CD').slackDays === -16, 'CD: overdue 100 + slack −16 (76) + late start 15 + unscheduled 20 = 211');
  ok(by('CC').level === 'critical' && by('CC').score === 70 && by('CC').slackDays === -10, 'CC: slack −10 → 60+10');
  ok(by('CB').level === 'warning' && by('CB').score === 45 && by('CB').machineConflict && by('CB').slackDays === 3, 'CB: slack 3 (30) + conflict (15)');
  ok(by('CA').level === 'ok' && by('CA').machineConflict && by('CA').slackDays === 9, 'CA ok but flags the conflict');
  ok(by('CF').level === 'ok' && by('CF').score === 20, 'CF unscheduled, due in 11 days = 20');
  ok(by('CE').score === 0 && by('CE').dueDate === null, 'CE nothing');
  ok(JSON.stringify(by('CB').suggestedSlot) === '{"start":"2026-11-12","end":"2026-11-17"}', 'CB suggested slot after CA on M1 (posted order ignored)');
  ok(by('CC').suggestedSlot === null, 'CC alone on M2: no better slot than own');
  ok(by('CD').suggestedSlot === null, 'unscheduled order gets no machine slot');
  ok(r.summary.critical === 2 && r.summary.warning === 1 && r.summary.ok === 3, 'summary 2/1/3');
  ok(by('CD').reasons.length === 4 && by('CD').actions.length >= 2, 'reasons + actions provided');
  const rc = await cr.criticalOrders(ctx, { asOf: '2026-11-01', level: 'critical' }); ok(rc.orders.length === 2 && rc.summary.ok === 3, 'level filter keeps summary overall');
  const late = await cr.criticalOrders(ctx, { asOf: '2026-11-21' }); ok(late.orders.find((o: any) => o.orderNo === 'CA')!.level === 'critical' || late.orders.find((o: any) => o.orderNo === 'CA')!.score >= 100, 'a later "today" turns CA overdue (promise passed)');
  denied.add('textile.schedule.view'); await rej(() => cr.criticalOrders(ctx, {}), /DENIED/, 'requires schedule.view'); denied.clear();
  console.log(`CRIT: ${pass} passed, ${fail} failed`); await pool.end(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });

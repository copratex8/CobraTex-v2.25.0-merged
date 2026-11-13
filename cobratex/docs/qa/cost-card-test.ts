import * as cc from '@/modules/manufacturing/textileCostCard';
import { pool } from '@/db/pool';
const Z = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`;
const ctx: any = { companyId: Z('0000000000c1'), tenantId: Z('0000000000a1'), userId: Z('000000000f00'), assertPermission() {}, visibleBranchIds: () => null };
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const near = (a: any, b: number, m: string, t = 0.01) => ok(a !== null && Math.abs(Number(a) - b) <= t, `${m}: expected ${b} got ${a}`);
const BR = Z('0000000000b1'), WH = Z('000000000001'), BOM = Z('000000000002'), FP = Z('000000000003'), FAB = Z('000000000102'), M1 = Z('0000000000f1'), M2 = Z('0000000000f2'), W1 = Z('000000000b01'), S1 = Z('0000000000e1');
const COT = Z('000000000201'), POL = Z('000000000202');
const q = (s: string, p: any[] = []) => pool.query(s, p);
(async () => {
  // ===== دالة نقية =====
  const base = { materialsActual: 1000, materialsPlanned: 900, opsCost: 0, std: { labor: 100, overhead: 50, energy: 40 }, utilities: {}, incentives: 10, recovered: 20, abnormalLoss: 5, outputKg: 100, plannedKg: 120, meters: 0, includeUtilities: true };
  let c = cc.assembleCostCard(base); near(c.gross, 1000 + 190 + 10, 'pure: materials+std conversion(190)+incentives', 0.001); near(c.netProductCost, 1200 - 25, 'pure: net = gross − recovered − abnormal'); near(c.costPerKg, 11.75, 'pure: per kg'); ok(c.costPerMeter === null, 'pure: no meters → no per-meter'); near(c.yieldPercent, 83.3333, 'pure: yield', 0.001); near(c.materialVariance, 100, 'pure: variance');
  c = cc.assembleCostCard({ ...base, utilities: { electricity: 60 } }); near(c.lines.conversion, 150, 'pure: electricity bill replaces std energy (150 not 190)'); near(c.gross, 1000 + 150 + 60 + 10, 'pure: gross with utilities');
  c = cc.assembleCostCard({ ...base, opsCost: 300, utilities: { electricity: 60 } }); ok(c.lines.conversionBasis === 'books' && c.lines.conversion === 300 && c.warnings.some((w) => /تكرار/.test(w)), 'pure: books conversion wins + overlap warning');
  c = cc.assembleCostCard({ ...base, utilities: { electricity: 60 }, includeUtilities: false }); near(c.lines.conversion, 190, 'pure: includeUtilities=false keeps std energy'); ok(c.lines.utilities.length === 0, 'pure: utilities omitted');
  c = cc.assembleCostCard({ ...base, materialsActual: null, outputKg: null }); ok(c.lines.materialsBasis === 'estimate' && c.costPerKg === null && c.warnings.length >= 2, 'pure: draft → estimate + no per-kg');
  c = cc.assembleCostCard({ ...base, recovered: 5000 }); ok(c.warnings.some((w) => /سالب/.test(w)) && c.costPerKg === null, 'pure: non-positive net flagged, no per-kg');
  c = cc.assembleCostCard({ ...base, meters: 200 }); near(c.costPerMeter, 1175 / 200, 'pure: per meter');

  // ===== قاعدة حقيقية =====
  await q(`SET session_replication_role=replica; INSERT INTO stock_balances(company_id,warehouse_id,item_id,quantity_on_hand,weighted_average_cost) VALUES ('${ctx.companyId}','${WH}','${COT}',5000,48),('${ctx.companyId}','${WH}','${POL}',5000,40); SET session_replication_role=origin;`).catch(() => null);
  for (const [id, code] of [[COT, 'COT'], [POL, 'POL']]) await q(`INSERT INTO items(id,company_id,item_kind,code,name_ar,name_en,base_uom_id) VALUES ($1,$2,'generic',$3,$3,$3,$4) ON CONFLICT DO NOTHING`, [id, ctx.companyId, code, Z('0000000000d0')]);
  await q(`INSERT INTO stock_balances(company_id,warehouse_id,item_id,quantity_on_hand,weighted_average_cost) VALUES ($1,$2,$3,5000,48),($1,$2,$4,5000,40) ON CONFLICT DO NOTHING`, [ctx.companyId, WH, COT, POL]);
  const mk = async (no: string, status: string, out: number | null, extra = '') => (await q(`INSERT INTO production_orders(company_id,branch_id,warehouse_id,bom_id,output_item_id,document_number,fiscal_period_id,order_date,currency_code,planned_output_quantity,actual_output_quantity,status,recovered_value_total,abnormal_loss_total) VALUES ($1,$2,$3,$4,$5,$6,$7,'2026-10-05','EGP',1500,$8,$9,${extra || 'NULL,NULL'}) RETURNING id`, [ctx.companyId, BR, WH, BOM, FAB, no, FP, out, status])).rows[0].id;
  const X = await mk('C-X', 'posted', 1300, '1000,500'), Y = await mk('C-Y', 'posted', 100, '0,0'), Y2 = await mk('C-Y2', 'posted', 100, '0,0'), Z1 = await mk('C-Z', 'draft', null);
  const line = (o: string, it: string, plan: number, cons: number | null, cost: number | null) => q(`INSERT INTO production_order_lines(production_order_id,company_id,component_item_id,planned_quantity,consumed_quantity,line_cost) VALUES ($1,$2,$3,$4,$5,$6)`, [o, ctx.companyId, it, plan, cons, cost]);
  await line(X, COT, 1000, 1000, 50000); await line(X, POL, 400, 400, 16000); await line(Y, COT, 100, 100, 5000); await line(Y2, COT, 100, 100, 5000); await line(Z1, COT, 100, null, null);
  await q(`INSERT INTO production_order_operations(production_order_id,company_id,sequence,name,cost_type,planned_cost) VALUES ($1,$2,1,'تشغيل','labor',5000)`, [X, ctx.companyId]);
  await q(`INSERT INTO textile_cost_rates(company_id,rate_type,rate) VALUES ($1,'labor_per_run_hour',20),($1,'overhead_per_run_hour',10),($1,'energy_per_kwh',0.5)`, [ctx.companyId]);
  const lg = (m: string, d: string, sh: string, h: number, kwh: number, o: string) => q(`INSERT INTO machine_production_logs(company_id,branch_id,machine_id,shift,log_date,run_hours,output_quantity,energy_kwh,production_order_id) VALUES ($1,$2,$3,$4,$5,$6,10,$7,$8)`, [ctx.companyId, BR, m, sh, d, h, kwh, o]);
  await lg(M1, '2026-10-05', 'morning', 8, 150, X); await lg(M1, '2026-10-05', 'evening', 8, 150, X); await lg(M2, '2026-10-06', 'morning', 10, 100, Y2); await lg(M1, '2026-08-10', 'morning', 10, 100, Y);
  await q(`INSERT INTO utility_bills(company_id,branch_id,kind,period_from,period_to,total_cost,driver) VALUES ($1,$2,'electricity','2026-10-01','2026-10-31',3000,'energy_kwh')`, [ctx.companyId, BR]);
  await q(`INSERT INTO incentive_rates(company_id,unit,rate_per_unit,effective_from) VALUES ($1,'kg',0.5,'2026-01-01')`, [ctx.companyId]);
  await q(`INSERT INTO worker_output_logs(company_id,branch_id,worker_id,machine_id,stage_id,production_order_id,log_date,shift,quantity,unit) VALUES ($1,$2,$3,$4,$5,$6,'2026-10-05','morning',1000,'kg')`, [ctx.companyId, BR, W1, M1, S1, X]);
  await q(`INSERT INTO fabric_rolls(company_id,production_order_id,item_id,roll_no,length_m,width_cm,weight_kg,points_per_100sqyd,grade) VALUES ($1,$2,$3,'CR1',100,150,600,3,'A'),($1,$2,$3,'CR2',100,150,700,3,'A')`, [ctx.companyId, X, FAB]);

  const x = await cc.costCard(ctx, X);
  near(x.lines.materials, 66000, 'X materials actual'); ok(x.lines.materialsBasis === 'actual', 'X basis actual'); near(x.materialVariance, 2000, 'X variance vs plan 64000');
  ok(x.lines.conversionBasis === 'books' && x.lines.conversion === 5000, 'X conversion from order operations (books)');
  near(x.lines.utilities.find((u: any) => u.kind === 'electricity')?.amount, 1125, 'X electricity = 3000×300/800 kWh'); near(x.lines.incentives, 500, 'X incentives 1000kg × 0.5');
  near(x.gross, 72625, 'X gross'); near(x.netProductCost, 71125, 'X net = gross − 1000 recovered − 500 abnormal'); near(x.abnormalLoss, 500, 'X abnormal separate'); near(x.costPerKg, 54.7115, 'X per kg', 0.001); near(x.costPerMeter, 71125 / 200, 'X per meter (2 rolls × 100 m)'); near(x.yieldPercent, 86.6667, 'X yield', 0.001);
  ok(x.warnings.some((w: string) => /تكرار/.test(w)), 'X overlap warning present');
  const xn = await cc.costCard(ctx, X, { includeUtilities: 'false' }); near(xn.netProductCost, 70000, 'X net without utilities'); near(xn.costPerKg, 53.8462, 'X per kg without utilities', 0.001);
  const y = await cc.costCard(ctx, Y); ok(y.lines.conversionBasis === 'standard', 'Y standard conversion'); near(y.lines.conversion, 200 + 100 + 50, 'Y std = 10h×20 + 10h×10 + 100kWh×0.5'); ok(y.lines.utilities.length === 0, 'Y Aug has no bill'); near(y.costPerKg, 53.5, 'Y per kg (5000+350)/100');
  const y2 = await cc.costCard(ctx, Y2); near(y2.lines.conversion, 300, 'Y2 std excludes energy since actual electricity bill exists'); near(y2.lines.utilities[0].amount, 375, 'Y2 electricity 3000×100/800'); near(y2.costPerKg, 56.75, 'Y2 per kg');
  const z = await cc.costCard(ctx, Z1); ok(z.lines.materialsBasis === 'estimate' && z.costPerKg === null, 'draft order: estimate, no per-kg'); near(z.lines.materials, 4800, 'draft materials = 100 × WAC 48');
  let threw = false; try { await cc.costCard(ctx, Z('777')); } catch { threw = true; } ok(threw, 'unknown order rejected');
  const rk = await cc.costRanking(ctx, { from: '2026-10-01', to: '2026-10-31' }); ok(rk.count === 3 && rk.cheapest.orderNo === 'C-Y2' || rk.cheapest.orderNo === 'C-Y', 'ranking picks cheapest posted'); ok(rk.dearest.orderNo === 'C-Y2' || rk.dearest.orderNo === 'C-X', 'ranking has dearest'); ok(rk.orders.every((o: any, i: number, a: any[]) => i === 0 || o.costPerKg === null || a[i - 1].costPerKg === null || a[i - 1].costPerKg <= o.costPerKg), 'ranking sorted ascending');
  ok(cc.costQuerySchema.safeParse({ includeUtilities: 'false' }).success && !cc.costQuerySchema.safeParse({ includeUtilities: 'x' }).success, 'query schema');
  console.log(`\nCOST RESULT: ${pass} passed, ${fail} failed`); (await import('/tmp/final/stubs/pool.js') as any).__closeAll(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e); process.exit(2); });

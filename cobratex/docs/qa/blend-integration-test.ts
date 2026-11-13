import * as bl from '@/modules/manufacturing/textileBlendService';
import { pool } from '@/db/pool';
import { yarnRequirements, sumPercent } from '@/modules/manufacturing/textileBlendService';

const Z = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`;
const denied = new Set<string>();
const ctx: any = { companyId: Z('0000000000c1'), tenantId: Z('0000000000a1'), userId: Z('000000000f00'), assertPermission(c: string) { if (denied.has(c)) throw new Error('DENIED:' + c); }, visibleBranchIds: () => null };
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const near = (a: number, b: number, m: string) => ok(Math.abs(Number(a) - b) < 0.0006, `${m}: expected ${b} got ${a}`);
const rej = async (fn: () => Promise<unknown>, re: RegExp, m: string) => { try { await fn(); ok(false, m + ' (no error)'); } catch (e: any) { ok(re.test(e.message), m + ' → ' + String(e.message).slice(0, 100)); } };
const FAB = Z('000000000102'), YARN = Z('000000000101'), M1 = Z('0000000000f1'), M2 = Z('0000000000f2'), BR = Z('0000000000b1'), WH = Z('000000000001'), BOM = Z('000000000002'), FP = Z('000000000003');
const Y_COT = Z('000000000201'), Y_POL = Z('000000000202'), Y_VIS = Z('000000000203');

(async () => {
  const mach = (await pool.query(`SELECT id, code FROM machines ORDER BY code`)).rows; const m1 = mach[0].id, m2 = mach[1].id;
  for (const [id, c] of [[Y_COT, 'COT'], [Y_POL, 'POL'], [Y_VIS, 'VIS']]) await pool.query(`INSERT INTO items(id,company_id,item_kind,code,name_ar,name_en,base_uom_id) VALUES ($1,$2,'generic',$3,$3,$3,$4)`, [id, ctx.companyId, c, Z('0000000000d0')]);

  // pure
  ok(sumPercent([{ percent: 33.3333 }, { percent: 33.3333 }, { percent: 33.3334 }]) === 100, 'sumPercent exact on 1e-4 grid');
  ok(sumPercent([{ percent: 0.1 }, { percent: 0.2 }]) === 0.3, 'sumPercent avoids float drift');
  const rq = yarnRequirements(1000, 2, [{ yarnItemId: 'a', percent: 65 }, { yarnItemId: 'b', percent: 35 }]); near(rq[0].quantity, 663, 'req cotton 1000×65%×1.02'); near(rq[1].quantity, 357, 'req poly');

  // إنشاء مسودة (قطن 65 + بوليستر 35) افتراضية للصنف
  const d1 = await bl.createRecipe(ctx, { itemId: FAB, name: 'قطن/بوليستر', wastePercent: 2, lines: [{ yarnItemId: Y_COT, role: 'main', percent: 65 }, { yarnItemId: Y_POL, role: 'main', percent: 35 }] });
  ok(d1.status === 'draft' && d1.version_no === 1 && d1.percentTotal === 100, 'draft v1 created');
  await rej(() => bl.createRecipe(ctx, { itemId: FAB, name: 'x', lines: [{ yarnItemId: FAB, percent: 100 }] }), /أحد خيوطها/, 'item cannot be its own yarn');
  await rej(() => bl.createRecipe(ctx, { itemId: FAB, name: 'x', lines: [{ yarnItemId: Z('999'), percent: 100 }] }), /غير موجود/, 'unknown yarn rejected');
  await rej(() => bl.createRecipe(ctx, { itemId: FAB, name: 'x', lines: [{ yarnItemId: Y_COT, percent: 50 }, { yarnItemId: Y_COT, percent: 50 }] }), /مكرر/, 'duplicate yarn+role rejected');
  await rej(() => bl.createRecipe(ctx, { itemId: FAB, machineId: Z('888'), name: 'x', lines: [{ yarnItemId: Y_COT, percent: 100 }] }), /الماكينة/, 'unknown machine rejected');
  denied.add('textile.blend.manage'); await rej(() => bl.createRecipe(ctx, { itemId: FAB, name: 'x', lines: [{ yarnItemId: Y_COT, percent: 100 }] }), /DENIED/, 'create requires manage'); denied.clear();

  // تعديل المسودة ثم تثبيت مع رفض مجموع ≠ 100
  const u = await bl.updateDraft(ctx, d1.id, { lines: [{ yarnItemId: Y_COT, percent: 60 }, { yarnItemId: Y_POL, percent: 30 }] }); near(u.percentTotal, 90, 'draft may hold incomplete total');
  denied.add('textile.blend.lock'); await rej(() => bl.lockRecipe(ctx, d1.id), /DENIED/, 'lock requires lock permission'); denied.clear();
  await rej(() => bl.lockRecipe(ctx, d1.id), /90%/, 'cannot lock when total ≠ 100');
  await bl.updateDraft(ctx, d1.id, { lines: [{ yarnItemId: Y_COT, percent: 65 }, { yarnItemId: Y_POL, percent: 35 }] });
  const l1 = await bl.lockRecipe(ctx, d1.id); ok(l1.status === 'locked' && l1.supersededVersions.length === 0, 'locked v1');
  await rej(() => bl.updateDraft(ctx, d1.id, { name: 'y' }), /مثبَّتة/, 'service refuses editing locked');
  await rej(() => bl.deleteDraft(ctx, d1.id), /مثبَّتة/, 'service refuses deleting locked');
  await rej(() => bl.lockRecipe(ctx, d1.id), /بالفعل/, 'double lock refused');
  // حماية على مستوى القاعدة (تجاوز الخدمة)
  await rej(() => pool.query(`UPDATE yarn_blend_lines SET percent=70 WHERE recipe_id=$1 AND yarn_item_id=$2`, [d1.id, Y_COT]), /مثبَّتة/, 'DB trigger blocks line update on locked recipe');
  await rej(() => pool.query(`DELETE FROM yarn_blend_lines WHERE recipe_id=$1`, [d1.id]), /مثبَّتة/, 'DB trigger blocks line delete');
  await rej(() => pool.query(`INSERT INTO yarn_blend_lines(company_id,recipe_id,yarn_item_id,role,percent) VALUES ($1,$2,$3,'warp',5)`, [ctx.companyId, d1.id, Y_VIS]), /مثبَّتة/, 'DB trigger blocks line insert');
  await rej(() => pool.query(`UPDATE yarn_blend_recipes SET waste_percent=9 WHERE id=$1`, [d1.id]), /مثبَّتة/, 'DB trigger blocks waste change on locked');
  await rej(() => pool.query(`DELETE FROM yarn_blend_recipes WHERE id=$1`, [d1.id]), /مثبَّتة/, 'DB trigger blocks delete of locked recipe');

  // إصدار جديد بنسب مختلفة: يحل محل السابق عند التثبيت
  const v2 = await bl.newVersion(ctx, d1.id, { reason: 'تغيير مورد القطن' }); ok(v2.version_no === 2 && v2.status === 'draft' && v2.parent_recipe_id === d1.id && v2.lines.length === 2, 'new version copied lines (draft v2)');
  await bl.updateDraft(ctx, v2.id, { lines: [{ yarnItemId: Y_COT, percent: 50 }, { yarnItemId: Y_POL, percent: 30 }, { yarnItemId: Y_VIS, percent: 20 }] });
  const l2 = await bl.lockRecipe(ctx, v2.id); ok(l2.supersededVersions.join() === '1', 'locking v2 supersedes v1'); ok(l2.lines.length === 3 && l2.percentTotal === 100, 'three-yarn blend locked');
  const all = await bl.listRecipes(ctx, { itemId: FAB }); ok(all.find((r: any) => r.version_no === 1).status === 'superseded' && all.find((r: any) => r.version_no === 2).status === 'locked', 'v1 superseded, v2 current');
  await rej(() => pool.query(`UPDATE yarn_blend_recipes SET status='locked', locked_at=now() WHERE id=$1`, [d1.id]), /لا يُعاد|duplicate|unique|uq_blend_current/, 'cannot reactivate old version');
  const hist = await bl.getRecipe(ctx, v2.id); ok(hist.history.length === 2 && hist.history[0].version_no === 2, 'history lists versions');

  // وصفة خاصة بماكينة (نسب مختلفة) — تتقدم على الافتراضية لتلك الماكينة فقط
  const mr = await bl.createRecipe(ctx, { itemId: FAB, machineId: m1, name: 'ماكينة 1', wastePercent: 1, lines: [{ yarnItemId: Y_COT, percent: 70 }, { yarnItemId: Y_POL, percent: 30 }] });
  ok(mr.version_no === 1, 'machine scope has its own version counter'); await bl.lockRecipe(ctx, mr.id);
  const rs1 = await bl.resolve(ctx, { itemId: FAB, machineId: m1 }), rs2 = await bl.resolve(ctx, { itemId: FAB, machineId: m2 }), rs0 = await bl.resolve(ctx, { itemId: FAB });
  ok(rs1.source === 'machine' && rs1.id === mr.id, 'machine1 resolves to its own recipe'); ok(rs2.source === 'default' && rs2.id === v2.id, 'machine2 falls back to default'); ok(rs0.id === v2.id, 'no machine → default');
  ok((await bl.resolve(ctx, { itemId: YARN })) === null, 'item without recipe → null');
  // نسخ وصفة لماكينة أخرى
  const cp = await bl.newVersion(ctx, mr.id, { reason: 'نسخ لماكينة 2', machineId: m2 }); ok(cp.machine_id === m2 && cp.version_no === 1, 'copy to another machine starts at its own v1');
  await bl.updateDraft(ctx, cp.id, { lines: [{ yarnItemId: Y_COT, percent: 55 }, { yarnItemId: Y_POL, percent: 45 }] }); await bl.lockRecipe(ctx, cp.id);
  ok((await bl.resolve(ctx, { itemId: FAB, machineId: m2 })).id === cp.id, 'machine2 now has its own');
  const dr = await bl.createRecipe(ctx, { itemId: FAB, name: 'مسودة للحذف', lines: [{ yarnItemId: Y_COT, percent: 100 }] }); ok((await bl.deleteDraft(ctx, dr.id)).deleted, 'draft can be deleted');

  // المتطلبات
  const rr = await bl.requirements(ctx, v2.id, 1000); near(rr.totalYarn, 1020, 'requirements total (v2 inherits 2% waste)'); near(rr.lines.find((x: any) => x.yarnItemId === Y_COT).quantity, 510, 'cotton 50% ×1.02');
  const rm = await bl.requirements(ctx, mr.id, 1000); near(rm.totalYarn, 1010, 'machine recipe with 1% waste → 1010');

  // الربط بأوامر التصنيع
  const mkOrder = async (no: string, machine: string | null, status = 'draft') => (await pool.query(
    `INSERT INTO production_orders(company_id,branch_id,warehouse_id,bom_id,output_item_id,document_number,fiscal_period_id,order_date,currency_code,planned_output_quantity,actual_output_quantity,status,machine_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'2026-10-20','EGP',1000,$8,$9,$10) RETURNING id`, [ctx.companyId, BR, WH, BOM, FAB, no, FP, status === 'posted' ? 1000 : null, status, machine])).rows[0].id;
  const oA = await mkOrder('B-1', m1), oB = await mkOrder('B-2', m2), oC = await mkOrder('B-3', null), oP = await mkOrder('B-P', m1, 'posted');
  const a1 = await bl.attachToOrder(ctx, oA, {}); ok(a1.recipeId === mr.id && a1.machineBound, 'auto-resolve machine1 order → machine recipe');
  const a2 = await bl.attachToOrder(ctx, oB, {}); ok(a2.recipeId === cp.id, 'auto-resolve machine2 order → its recipe');
  const a3 = await bl.attachToOrder(ctx, oC, {}); ok(a3.recipeId === v2.id && !a3.machineBound, 'order without machine → default');
  await rej(() => bl.attachToOrder(ctx, oB, { recipeId: mr.id }), /ماكينة أخرى/, 'machine-bound recipe refuses other machine');
  await rej(() => bl.attachToOrder(ctx, oC, { recipeId: d1.id }), /مثبَّتة وحالية/, 'superseded recipe cannot be attached');
  const other = await bl.createRecipe(ctx, { itemId: YARN, name: 'غزل', lines: [{ yarnItemId: Y_COT, percent: 100 }] }); await bl.lockRecipe(ctx, other.id);
  await rej(() => bl.attachToOrder(ctx, oC, { recipeId: other.id }), /لا يطابق/, 'recipe of another item refused');
  await rej(() => bl.attachToOrder(ctx, oP, {}), /مرحَّل/, 'posted order cannot change recipe');
  await rej(() => bl.attachToOrder(ctx, Z('777'), {}), /غير موجود/, 'unknown order');
  // أمر ربط ثم إصدار جديد: الأمر يحتفظ بالإصدار الذي رُبط به
  const v3 = await bl.newVersion(ctx, v2.id, { reason: 'تعديل' }); await bl.updateDraft(ctx, v3.id, { lines: [{ yarnItemId: Y_COT, percent: 100 }] }); await bl.lockRecipe(ctx, v3.id);
  ok((await pool.query(`SELECT blend_recipe_id FROM production_orders WHERE id=$1`, [oC])).rows[0].blend_recipe_id === v2.id, 'order keeps the version it was linked to after a newer lock');
  ok((await bl.attachToOrder(ctx, oC, {})).recipeId === v3.id, 're-attach picks the newest locked version');

  // الانحراف الفعلي: أمر oA (قطن 70 / بوليستر 30) استهلاك 720/280 + فسكوز خارج الوصفة 10
  for (const [it, q] of [[Y_COT, 720], [Y_POL, 280], [Y_VIS, 10]] as const) await pool.query(`INSERT INTO production_order_lines(production_order_id,company_id,component_item_id,planned_quantity,consumed_quantity) VALUES ($1,$2,$3,$4,$4)`, [oA, ctx.companyId, it, q]);
  const vr = await bl.orderVariance(ctx, oA); const vc = vr.lines.find((x: any) => x.yarnItemId === Y_COT);
  near(vc.actualPercent, 72, 'actual cotton 720/1000'); near(vc.deviation, 2, 'deviation +2 points'); ok(vr.outsideRecipe.length === 1 && vr.outsideRecipe[0].qty === 10, 'consumption outside recipe flagged');
  await rej(() => bl.orderVariance(ctx, Z('777')), /غير موجود/, 'variance unknown order');
  const noBlend = await mkOrder('B-4', null); await rej(() => bl.orderVariance(ctx, noBlend), /غير مربوط/, 'variance on unlinked order refused');
  const vz = await bl.orderVariance(ctx, oB); ok(!vz.measurable, 'no consumption → not measurable (no divide by zero)');

  // تقرير الإنتاج لكل ماكينة ووصفة
  await pool.query(`INSERT INTO machine_production_logs(company_id,branch_id,machine_id,shift,log_date,run_hours,output_quantity,production_order_id) VALUES ($1,$2,$3,'morning','2026-10-21',8,400,$4),($1,$2,$3,'evening','2026-10-21',8,200,$4),($1,$2,$5,'morning','2026-10-21',8,500,$6)`, [ctx.companyId, BR, m1, oA, m2, oB]);
  const rep = await bl.machineBlendReport(ctx, { from: '2026-10-01', to: '2026-10-31' });
  const r1 = rep.find((x: any) => x.machineId === m1), r2 = rep.find((x: any) => x.machineId === m2);
  near(r1.output, 600, 'machine1 output 400+200'); near(r1.yarnUsage.find((x: any) => x.yarnItemId === Y_COT).quantity, 600 * 0.7 * 1.01, 'machine1 cotton by its 70% ratio + 1% waste');
  near(r2.output, 500, 'machine2 output'); near(r2.yarnUsage.find((x: any) => x.yarnItemId === Y_COT).quantity, 500 * 0.55 * 1.01, 'machine2 cotton by ITS 55% ratio (+1% inherited waste)'); ok(r1.recipeId !== r2.recipeId, 'production separated per machine/recipe');
  ok((await bl.machineBlendReport(ctx, { machineId: m2 })).length === 1, 'report machine filter');


  // ===== 2.1.0: BOM من الوصفة + التكلفة + توفر الرصيد =====
  const g1 = await bl.generateBom(ctx, v3.id, {}); ok(g1.lines === 1, 'BOM generated from current v3 (1 yarn line)');
  const bl1 = (await pool.query(`SELECT quantity, waste_percent FROM bom_lines WHERE bom_id=$1 ORDER BY sequence`, [g1.bomId])).rows; near(bl1[0].quantity, 1, 'BOM line = pct/100 per kg (100%)'); near(bl1[0].waste_percent, 2, 'BOM line carries recipe waste');
  await rej(() => bl.generateBom(ctx, v3.id, {}), /من قبل|قبل/, 'one BOM per recipe');
  await rej(() => bl.generateBom(ctx, v2.id, {}), /مثبَّتة وحالية/, 'cannot generate from superseded recipe');
  await rej(() => bl.generateBom(ctx, d1.id, {}), /مثبَّتة وحالية/, 'cannot generate from superseded recipe');
  denied.add('manufacturing.bom.create'); await rej(() => bl.generateBom(ctx, mr.id, {}), /DENIED/, 'needs BOM-create permission too'); denied.clear();
  const g2 = await bl.generateBom(ctx, mr.id, { code: 'BOM-M1-CUSTOM' }); ok(g2.code === 'BOM-M1-CUSTOM', 'machine recipe → its own BOM with custom code');
  await rej(() => bl.generateBom(ctx, cp.id, { code: 'BOM-M1-CUSTOM' }), /مُستخدَم/, 'duplicate BOM code → conflict');
  await pool.query(`UPDATE production_orders SET bom_id=$2 WHERE id=$1`, [oA, g2.bomId]); ok((await bl.attachToOrder(ctx, oA, {})).bomMatchesRecipe === true, 'attach reports BOM matches recipe');
  ok((await bl.attachToOrder(ctx, oB, {})).bomMatchesRecipe === false, 'attach warns BOM differs from recipe');

  // تكلفة: رصيد خيوط بمتوسط مرجّح
  for (const [w, it, q, c] of [[WH, Y_COT, 1000, 60], [WH, Y_COT, 1000, 80], [WH, Y_POL, 500, 40]] as const) await pool.query(`INSERT INTO stock_balances(company_id,warehouse_id,item_id,quantity_on_hand,weighted_average_cost,batch_id) VALUES ($1,$2,$3,$4,$5,gen_random_uuid())`, [ctx.companyId, w, it, q, c]).catch(() => {});
  const cst = await bl.recipeCost(ctx, mr.id, { conversionCostPerUnit: 5 });
  // قطن متوسط (1000×60+1000×80)/2000=70؛ بوليستر 40 ؛ 70%×1.01×70 + 30%×1.01×40 = 49.49+12.12=61.61
  near(cst.materialCostPerKg, 61.61, 'material cost/kg = weighted avg × pct × waste'); near(cst.totalCostPerKg, 66.61, 'total incl. conversion 5'); ok(cst.complete, 'complete costing');
  const cst2 = await bl.recipeCost(ctx, v2.id, {}); ok(!cst2.complete && cst2.missingCost.includes('VIS'), 'yarn without stock reported, not guessed');
  const cmp = await bl.costComparison(ctx, FAB, {}); ok(cmp.recipes.length >= 3, 'comparison lists recipes'); ok(cmp.cheapest !== null && cmp.cheapest.complete, 'cheapest among complete only');
  ok(cmp.cheapest.totalCostPerKg <= Math.min(...cmp.recipes.filter((x: any) => x.complete).map((x: any) => x.totalCostPerKg)), 'cheapest really minimal');

  // توفر الرصيد لأمر oA (1000 كجم، وصفة ماكينة1: قطن 70% بهالك 1% = 707، بوليستر 303)
  await pool.query(`UPDATE stock_balances SET quantity_reserved=300 WHERE item_id=$1 AND quantity_on_hand=1000 AND weighted_average_cost=60`, [Y_COT]);
  const av = await bl.orderAvailability(ctx, oA); const ac = av.lines.find((x: any) => x.yarnItemId === Y_COT), ap = av.lines.find((x: any) => x.yarnItemId === Y_POL);
  near(ac.required, 707, 'required cotton'); near(ac.available, 1700, 'available = on-hand 2000 − reserved 300'); ok(ac.ok, 'cotton sufficient'); near(ap.required, 303, 'required poly'); near(ap.available, 500, 'poly available'); ok(av.allAvailable, 'all available');
  await pool.query(`UPDATE production_orders SET planned_output_quantity=2000 WHERE id=$1`, [oA]);
  const av2 = await bl.orderAvailability(ctx, oA); const pp = av2.lines.find((x: any) => x.yarnItemId === Y_POL); near(pp.shortage, 606 - 500, 'poly shortage 106'); ok(!av2.allAvailable, 'shortage detected');
  await rej(() => bl.orderAvailability(ctx, noBlend), /غير مربوط/, 'availability needs recipe');

  const au = (globalThis as any).__audit.map((a: any) => a.action + ':' + a.entityType); ok(au.includes('lock:yarn_blend_recipe') && au.includes('update:production_order_blend'), 'audit trail for lock and attach');
  console.log(`\nBLEND RESULT: ${pass} passed, ${fail} failed`);
  (await import('/tmp/final/stubs/pool.js') as any).__closeAll(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e); process.exit(2); });

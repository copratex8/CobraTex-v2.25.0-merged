import * as sk from '@/modules/manufacturing/textileFabricStock';
import * as dl from '@/modules/manufacturing/textileDeliveryService';
import { pool } from '@/db/pool';
const Z = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`;
const ctx: any = { companyId: Z('0000000000c1'), tenantId: Z('0000000000a1'), userId: Z('000000000f00'), assertPermission() {}, visibleBranchIds: () => null };
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };
const near = (a: any, b: number, m: string, t = 0.001) => ok(Math.abs(Number(a) - b) <= t, `${m}: expected ${b} got ${a}`);
const rej = async (fn: () => any, re: RegExp, m: string) => { try { await fn(); ok(false, m + ' no error'); } catch (e: any) { ok(re.test(e.message), m + ' → ' + e.message.slice(0, 80)); } };
(async () => {
  // 150 جم/م² × عرض 1.5 م = 0.225 كجم/م → 100 كجم = 444.4444 م
  const c = sk.convertFabric({ gsm: 150, widthCm: 150, kg: 100, pricePerKg: 90 });
  near(c.kgPerMeter, 0.225, 'kg/m', 1e-6); near(c.meters, 444.4444, 'meters from kg', 0.001); near(c.yards, 486.0504, 'yards = 444.4444/0.9144', 0.001); near(c.pricePerMeter, 20.25, 'price/m = 90×0.225'); near(c.totalValue, 9000, 'value'); near(c.sqMeters, 666.6667, 'm²', 0.001);
  const d = sk.convertFabric({ gsm: 150, widthCm: 150, meters: 100, pricePerMeter: 20.25 }); near(d.kg, 22.5, 'kg from meters'); near(d.pricePerKg, 90, 'price/kg from price/m');
  const e = sk.convertFabric({ gsm: 150, widthCm: 150, yards: 100 }); near(e.meters, 91.44, 'yards→m'); ok(e.pricePerKg === null && e.totalValue === null, 'no price → null (not guessed)');
  await rej(async () => sk.convertFabric({ gsm: 150, widthCm: 150 }), /كمية واحدة/, 'needs one quantity'); await rej(async () => sk.convertFabric({ gsm: 150, widthCm: 150, kg: 1, meters: 1 }), /كمية واحدة/, 'rejects two quantities'); await rej(async () => sk.convertFabric({ gsm: 0, widthCm: 150, kg: 1 }), /GSM/, 'rejects zero gsm');
  ok(sk.bucketOf(0) === '0-30' && sk.bucketOf(30) === '0-30' && sk.bucketOf(31) === '31-90' && sk.bucketOf(180) === '91-180' && sk.bucketOf(181) === '180+', 'age buckets boundaries');
  ok(sk.convSchema.safeParse({ kg: '10' }).success && !sk.convSchema.safeParse({ kg: '10', meters: '5' }).success && !sk.convSchema.safeParse({ kg: 1, pricePerKg: 1, pricePerMeter: 1 }).success, 'query schema rules');
  // من مواصفات الصنف
  const FAB = Z('000000000102'); await pool.query(`INSERT INTO item_textile_specs(company_id,item_id,fabric_gsm,fabric_width_cm) VALUES ($1,$2,200,160)`, [ctx.companyId, FAB]);
  const s = await sk.convert(ctx, { itemId: FAB, meters: 10 }); ok(s.source === 'item_specs', 'uses item specs'); near(s.kg, 3.2, '200gsm×1.6m×10m = 3.2 kg');
  await rej(() => sk.convert(ctx, { itemId: Z('999'), meters: 1 }), /لا مواصفات/, 'unknown item');
  // مخزون الرولات والعمر
  const mk = async (no: string, w: number, defects: any[] = []) => (await dl.createRollWithDefects(ctx, { rollNo: no, itemId: FAB, lengthM: 100, widthCm: 150, weightKg: w, defects })).id;
  const r1 = await mk('S1', 80), r2 = await mk('S2', 82), r3 = await mk('S3', 70), r4 = await mk('S4', 60);
  const types = await dl.seedDefectCatalog(ctx); const t = (await dl.listDefectTypes(ctx)).find((x: any) => x.code === 'D-SHD').id;
  const rc = await dl.createRollWithDefects(ctx, { rollNo: 'S-C', itemId: FAB, lengthM: 50, widthCm: 150, weightKg: 30, defects: [{ defectTypeId: t, occurrences: 10 }] });
  await pool.query(`UPDATE fabric_rolls SET inspected_at = now() - interval '45 days' WHERE roll_no='S2'`); await pool.query(`UPDATE fabric_rolls SET inspected_at = now() - interval '200 days' WHERE roll_no='S3'`);
  const BR = Z('0000000000b1'), C1 = Z('000000000009');
  await dl.createDeliveryNote(ctx, { branchId: BR, customerId: C1, noteDate: new Date().toISOString().slice(0, 10), packingUnitIds: [], fabricRollIds: [r4] });
  const st = await sk.rollStock(ctx, {}); const A = st.groups.find((g: any) => g.grade === 'A');
  ok(st.totalRolls === 4, 'delivered roll excluded (5 rolls − 1 delivered = 4) got ' + st.totalRolls); ok(A.rolls === 3 && Math.abs(A.kg - 232) < 0.01 && A.oldestDays >= 200, 'grade A: 3 rolls 232 kg oldest ≥200d');
  ok(A.ageing['0-30'] === 1 && A.ageing['31-90'] === 1 && A.ageing['180+'] === 1, 'age distribution'); near(st.gradeCShare, 25, 'grade C share 1/4 = 25%', 0.1);
  const past = await sk.rollStock(ctx, { asOf: new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10) }); ok(past.totalRolls === 1, 'as-of date in the past counts only rolls inspected by then (S3) got ' + past.totalRolls);
  console.log(`\nSTK RESULT: ${pass} passed, ${fail} failed`); (await import('/tmp/final/stubs/pool.js') as any).__closeAll(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e); process.exit(2); });

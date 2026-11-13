import { z } from 'zod';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError, ConflictError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';

/**
 * دفتر لوطات الخيوط والهالك (2.19.0) — مبني على منطق شيت «Textile Yarn Inventory»:
 *  • الوارد بالوط؛ التشغيل: كمية قماش × نسب خلط (حتى أي عدد خيوط، لا ٣ فقط) ؛ الصافي = قماش × نسبة الخلط؛
 *  • الهالك = قماش × نسبة الهالك × نسبة الخلط (أو هالك فعلي موزّع بنسب الخلط)، ويُخصم من الرصيد مع الصافي؛ الرصيد = وارد − صافي − هالك.
 *  تحسينات على الشيت: مجموع الخلط = 100% إلزامي (الشيت يكتفي بتحذير)، منع الرصيد السالب، إلغاء بسبب بدل المسح، استيراد من الشيت نفسه.
 *  تحليلي: لا يُرحِّل قيودًا ولا يحرّك المخزون المحاسبي (يُقارَن برصيد الدُفعة في المخزن إن وُجدت).
 */
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ YYYY-MM-DD');
const lot = z.string().trim().min(1).max(60);
const r3 = (n: number) => Math.round(n * 1000) / 1000; const r4 = (n: number) => Math.round(n * 10000) / 10000;
export const receiptSchema = z.strictObject({ receiptDate: date, receiptNo: z.string().trim().max(60).optional(), lotNo: lot, itemName: z.string().trim().min(1).max(120), quantity: z.number().positive(), unitPrice: z.number().min(0).optional(), notes: z.string().max(500).optional() });
export const runSchema = z.strictObject({ runDate: date, productionOrderId: z.uuid().optional(), machineCode: z.string().trim().max(40).optional(), fabricKg: z.number().positive(), wastePercent: z.number().min(0).max(100).default(0), wasteOverrideKg: z.number().min(0).optional(),
  lines: z.array(z.strictObject({ lotNo: lot, blendPercent: z.number().gt(0).max(100) })).min(1).max(20), notes: z.string().max(500).optional(), allowNegative: z.boolean().optional() });
export const cancelSchema = z.strictObject({ reason: z.string().trim().min(3) });
export const listSchema = z.object({ from: date.optional(), to: date.optional(), lotNo: z.string().optional(), machineCode: z.string().optional(), productionOrderId: z.string().uuid().optional(), includeCancelled: z.enum(['true', 'false']).optional() });
export const ledgerSchema = z.object({ asOf: date.optional(), wasteLimit: z.coerce.number().min(0).optional() });
export const lotCardSchema = z.object({ lotNo: lot });
export const importSchema = z.strictObject({ dryRun: z.boolean().default(true), allowNegative: z.boolean().optional(),
  receipts: z.array(z.strictObject({ date, receiptNo: z.string().optional(), lotNo: lot, itemName: z.string().trim().min(1), quantity: z.number().positive(), notes: z.string().optional() })).max(5000).default([]),
  runs: z.array(z.strictObject({ date, machineCode: z.string().optional(), fabricKg: z.number().positive(), wastePercent: z.number().min(0).max(100).default(0), lines: z.array(z.strictObject({ lotNo: lot, itemName: z.string().optional(), blendPercent: z.number().gt(0).max(100) })).min(1).max(20) })).max(5000).default([]) });

/** حساب سطور التشغيل: الصافي والهالك لكل خيط. */
export function computeRun(fabricKg: number, wastePercent: number, lines: Array<{ lotNo: string; blendPercent: number }>, wasteOverrideKg?: number) {
  const sum = lines.reduce((s, l) => s + l.blendPercent, 0);
  const out = lines.map((l) => ({ lotNo: l.lotNo, blendPercent: l.blendPercent, netKg: r4((fabricKg * l.blendPercent) / 100), wasteKg: r4(wasteOverrideKg !== undefined ? (wasteOverrideKg * l.blendPercent) / 100 : (fabricKg * wastePercent * l.blendPercent) / 10000) }));
  return { blendSum: Math.round(sum * 10000) / 10000, lines: out, net: r4(out.reduce((s, l) => s + l.netKg, 0)), waste: r4(out.reduce((s, l) => s + l.wasteKg, 0)) };
}

type Q = { query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }> }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function balance(db: Q, companyId: string, lotNo: string) {
  const rin = Number((await db.query(`SELECT COALESCE(SUM(quantity),0) AS n FROM yarn_receipts WHERE company_id=$1 AND lot_no=$2 AND status='active'`, [companyId, lotNo])).rows[0].n);
  const out = (await db.query(`SELECT COALESCE(SUM(l.net_kg),0) AS net, COALESCE(SUM(l.waste_kg),0) AS wst FROM yarn_run_lines l JOIN yarn_runs r ON r.id=l.run_id WHERE l.company_id=$1 AND l.lot_no=$2 AND r.status='active'`, [companyId, lotNo])).rows[0];
  return { received: rin, net: Number(out.net), waste: Number(out.wst), balance: r4(rin - Number(out.net) - Number(out.wst)) };
}
const lock = (client: Q, companyId: string, lots: string[]) => Promise.all([...new Set(lots)].sort().map((l) => client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${companyId}:yarn:${l}`])));
async function itemOfLot(db: Q, companyId: string, lotNo: string) { return (await db.query(`SELECT item_name FROM yarn_receipts WHERE company_id=$1 AND lot_no=$2 ORDER BY created_at LIMIT 1`, [companyId, lotNo])).rows[0]?.item_name as string | undefined; }
async function resolveItem(db: Q, companyId: string, name: string) { return (await db.query(`SELECT id FROM items WHERE company_id=$1 AND name_ar=$2 LIMIT 1`, [companyId, name])).rows[0]?.id ?? null; }

export async function createReceipt(ctx: RequestContext, raw: z.input<typeof receiptSchema>) {
  ctx.assertPermission('yarnlot.manage'); const b = receiptSchema.parse(raw);
  return withTransaction(async (c) => {
    await lock(c as Q, ctx.companyId, [b.lotNo]);
    const known = await itemOfLot(c as Q, ctx.companyId, b.lotNo);
    if (known && known !== b.itemName) throw new ValidationError(`اللوط ${b.lotNo} مسجَّل بصنف «${known}» — لا يمكن استلامه بصنف «${b.itemName}»`);
    if (b.receiptNo && (await c.query(`SELECT 1 FROM yarn_receipts WHERE company_id=$1 AND receipt_no=$2 AND lot_no=$3 AND status='active'`, [ctx.companyId, b.receiptNo, b.lotNo])).rows.length) throw new ConflictError('إذن الوارد مسجَّل لنفس اللوط');
    const itemId = await resolveItem(c as Q, ctx.companyId, b.itemName);
    const row = (await c.query(`INSERT INTO yarn_receipts(company_id,receipt_date,receipt_no,lot_no,item_name,item_id,quantity,unit_price,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, receipt_date::text AS receipt_date, lot_no, quantity`, [ctx.companyId, b.receiptDate, b.receiptNo ?? null, b.lotNo, b.itemName, itemId, b.quantity, b.unitPrice ?? null, b.notes ?? null, ctx.userId])).rows[0];
    await writeAuditLog(c, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'create', entityType: 'yarn_receipt', entityId: row.id, afterJson: { lot: b.lotNo, qty: b.quantity } });
    return row;
  });
}

export async function createRun(ctx: RequestContext, raw: z.input<typeof runSchema>) {
  ctx.assertPermission('yarnlot.manage'); const b = runSchema.parse(raw);
  const lots = b.lines.map((l) => l.lotNo); if (new Set(lots).size !== lots.length) throw new ValidationError('لوط مكرر داخل نفس التشغيلة — اجمع نسبته في سطر واحد');
  const calc = computeRun(b.fabricKg, b.wastePercent, b.lines, b.wasteOverrideKg);
  if (Math.abs(calc.blendSum - 100) > 0.01) throw new ValidationError(`مجموع نسب الخلط ${calc.blendSum}% — يجب أن يساوي 100%`);
  return withTransaction(async (c) => {
    await lock(c as Q, ctx.companyId, lots);
    const items = new Map<string, string>();
    for (const l of calc.lines) {
      const it = await itemOfLot(c as Q, ctx.companyId, l.lotNo); if (!it) throw new ValidationError(`اللوط ${l.lotNo} غير مسجَّل في الوارد`); items.set(l.lotNo, it);
      const bal = await balance(c as Q, ctx.companyId, l.lotNo); const need = l.netKg + l.wasteKg;
      if (!b.allowNegative && need > bal.balance + 0.0005) throw new ValidationError(`رصيد اللوط ${l.lotNo} (${r3(bal.balance)} كجم) لا يكفي للسحب ${r3(need)} كجم (صافي ${r3(l.netKg)} + هالك ${r3(l.wasteKg)})`);
    }
    if (b.productionOrderId && !(await c.query(`SELECT 1 FROM production_orders WHERE id=$1 AND company_id=$2`, [b.productionOrderId, ctx.companyId])).rows.length) throw new ValidationError('أمر التصنيع غير موجود');
    const machineId = b.machineCode ? (await c.query(`SELECT id FROM machines WHERE company_id=$1 AND code=$2 LIMIT 1`, [ctx.companyId, b.machineCode])).rows[0]?.id ?? null : null;
    const run = (await c.query(`INSERT INTO yarn_runs(company_id,run_date,machine_code,machine_id,production_order_id,fabric_kg,waste_percent,waste_override_kg,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [ctx.companyId, b.runDate, b.machineCode ?? null, machineId, b.productionOrderId ?? null, b.fabricKg, b.wastePercent, b.wasteOverrideKg ?? null, b.notes ?? null, ctx.userId])).rows[0];
    for (const l of calc.lines) await c.query(`INSERT INTO yarn_run_lines(run_id,company_id,lot_no,item_name,blend_percent,net_kg,waste_kg) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [run.id, ctx.companyId, l.lotNo, items.get(l.lotNo), l.blendPercent, l.netKg, l.wasteKg]);
    await writeAuditLog(c, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'create', entityType: 'yarn_run', entityId: run.id, afterJson: { fabric: b.fabricKg, net: calc.net, waste: calc.waste } });
    return { id: run.id, ...calc, withdrawn: r4(calc.net + calc.waste) };
  });
}

export async function cancelRun(ctx: RequestContext, id: string, raw: z.input<typeof cancelSchema>) {
  ctx.assertPermission('yarnlot.cancel'); const b = cancelSchema.parse(raw);
  const r = (await pool.query(`SELECT status FROM yarn_runs WHERE id=$1 AND company_id=$2`, [id, ctx.companyId])).rows[0]; if (!r) throw new NotFoundError('التشغيلة غير موجودة'); if (r.status !== 'active') throw new ConflictError('ملغاة بالفعل');
  await pool.query(`UPDATE yarn_runs SET status='cancelled', cancel_reason=$2 WHERE id=$1`, [id, b.reason]);
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'yarn_run', entityId: id, afterJson: { cancelled: b.reason } });
  return { id, status: 'cancelled' };
}
export async function cancelReceipt(ctx: RequestContext, id: string, raw: z.input<typeof cancelSchema>) {
  ctx.assertPermission('yarnlot.cancel'); const b = cancelSchema.parse(raw);
  return withTransaction(async (c) => {
    const r = (await c.query(`SELECT status, lot_no, quantity FROM yarn_receipts WHERE id=$1 AND company_id=$2`, [id, ctx.companyId])).rows[0]; if (!r) throw new NotFoundError('الإذن غير موجود'); if (r.status !== 'active') throw new ConflictError('ملغى بالفعل');
    await lock(c as Q, ctx.companyId, [r.lot_no]); const bal = await balance(c as Q, ctx.companyId, r.lot_no);
    if (bal.balance - Number(r.quantity) < -0.0005) throw new ValidationError(`إلغاء الإذن يجعل رصيد اللوط ${r.lot_no} سالبًا (${r3(bal.balance - Number(r.quantity))} كجم) — ألغِ التشغيلات أولًا`);
    await c.query(`UPDATE yarn_receipts SET status='cancelled', cancel_reason=$2 WHERE id=$1`, [id, b.reason]);
    await writeAuditLog(c, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'yarn_receipt', entityId: id, afterJson: { cancelled: b.reason } });
    return { id, status: 'cancelled' };
  });
}

export async function listReceipts(ctx: RequestContext, raw: z.input<typeof listSchema>) {
  ctx.assertPermission('yarnlot.view'); const q = listSchema.parse(raw); const p: unknown[] = [ctx.companyId]; let w = 'company_id=$1';
  if (q.from) { p.push(q.from); w += ` AND receipt_date>=$${p.length}`; } if (q.to) { p.push(q.to); w += ` AND receipt_date<=$${p.length}`; } if (q.lotNo) { p.push(q.lotNo); w += ` AND lot_no=$${p.length}`; } if (q.includeCancelled !== 'true') w += ` AND status='active'`;
  return (await pool.query(`SELECT id, receipt_date::text AS receipt_date, receipt_no, lot_no, item_name, quantity, notes, status, cancel_reason FROM yarn_receipts WHERE ${w} ORDER BY receipt_date DESC, created_at DESC LIMIT 1000`, p)).rows;
}
export async function listRuns(ctx: RequestContext, raw: z.input<typeof listSchema>) {
  ctx.assertPermission('yarnlot.view'); const q = listSchema.parse(raw); const p: unknown[] = [ctx.companyId]; let w = 'r.company_id=$1';
  if (q.from) { p.push(q.from); w += ` AND r.run_date>=$${p.length}`; } if (q.to) { p.push(q.to); w += ` AND r.run_date<=$${p.length}`; } if (q.machineCode) { p.push(q.machineCode); w += ` AND r.machine_code=$${p.length}`; } if (q.productionOrderId) { p.push(q.productionOrderId); w += ` AND r.production_order_id=$${p.length}`; }
  if (q.lotNo) { p.push(q.lotNo); w += ` AND EXISTS (SELECT 1 FROM yarn_run_lines x WHERE x.run_id=r.id AND x.lot_no=$${p.length})`; } if (q.includeCancelled !== 'true') w += ` AND r.status='active'`;
  const runs = (await pool.query(`SELECT r.id, r.run_date::text AS run_date, r.machine_code, r.production_order_id, (SELECT document_number FROM production_orders po WHERE po.id=r.production_order_id) AS order_no, r.fabric_kg, r.waste_percent, r.waste_override_kg, r.status, r.cancel_reason, r.notes FROM yarn_runs r WHERE ${w} ORDER BY r.run_date DESC, r.created_at DESC LIMIT 1000`, p)).rows;
  if (!runs.length) return [];
  const ls = (await pool.query(`SELECT run_id, lot_no, item_name, blend_percent, net_kg, waste_kg FROM yarn_run_lines WHERE run_id = ANY($1::uuid[]) ORDER BY lot_no`, [runs.map((r) => r.id)])).rows;
  return runs.map((r) => { const lines = ls.filter((l) => l.run_id === r.id).map((l) => ({ lotNo: l.lot_no, itemName: l.item_name, blendPercent: Number(l.blend_percent), netKg: Number(l.net_kg), wasteKg: Number(l.waste_kg) })); const net = r4(lines.reduce((s, l) => s + l.netKg, 0)), waste = r4(lines.reduce((s, l) => s + l.wasteKg, 0)); return { ...r, fabric_kg: Number(r.fabric_kg), waste_percent: Number(r.waste_percent), lines, net, waste, withdrawn: r4(net + waste) }; });
}

/** اللوحة: ملخص اللوطات والأصناف والماكينات + تنبيهات (رصيد سالب، هالك مرتفع، فرق مع المخزن). */
export async function ledger(ctx: RequestContext, raw: z.input<typeof ledgerSchema>) {
  ctx.assertPermission('yarnlot.view'); const q = ledgerSchema.parse(raw); const asOf = q.asOf ?? '9999-12-31';
  const rc = (await pool.query(`SELECT lot_no, MIN(item_name) AS item, SUM(quantity) AS qty FROM yarn_receipts WHERE company_id=$1 AND status='active' AND receipt_date<=$2 GROUP BY lot_no ORDER BY MIN(created_at), lot_no`, [ctx.companyId, asOf])).rows;
  const ru = (await pool.query(`SELECT l.lot_no, SUM(l.net_kg) AS net, SUM(l.waste_kg) AS wst FROM yarn_run_lines l JOIN yarn_runs r ON r.id=l.run_id WHERE l.company_id=$1 AND r.status='active' AND r.run_date<=$2 GROUP BY l.lot_no`, [ctx.companyId, asOf])).rows;
  const um = new Map(ru.map((x) => [x.lot_no, x])); const alerts: string[] = [];
  const pr = new Map((await pool.query(`SELECT lot_no, SUM(quantity*unit_price) AS v, SUM(quantity) AS q FROM yarn_receipts WHERE company_id=$1 AND status='active' AND receipt_date<=$2 AND unit_price IS NOT NULL GROUP BY lot_no`, [ctx.companyId, asOf])).rows.map((x) => [x.lot_no, Number(x.q) ? Number(x.v) / Number(x.q) : null]));
  const stock = new Map((await pool.query(`SELECT b.batch_no, COALESCE(SUM(s.quantity_on_hand),0) AS qty FROM batches b LEFT JOIN stock_balances s ON s.batch_id=b.id AND s.company_id=b.company_id WHERE b.company_id=$1 GROUP BY b.batch_no`, [ctx.companyId])).rows.map((x) => [x.batch_no, Number(x.qty)]));
  const lots = rc.map((x, i) => { const u = um.get(x.lot_no); const recv = Number(x.qty), net = Number(u?.net ?? 0), wst = Number(u?.wst ?? 0), bal = r3(recv - net - wst);
    if (bal < -0.0005) alerts.push(`رصيد سالب للوط ${x.lot_no}: ${bal} كجم`);
    const st = stock.has(x.lot_no) ? stock.get(x.lot_no)! : null; if (st !== null && Math.abs(st - bal) >= 1) alerts.push(`اللوط ${x.lot_no}: رصيد الدفتر ${bal} ≠ رصيد المخزن ${r3(st)} كجم`);
    return { seq: i + 1, lotNo: x.lot_no, item: x.item, received: r3(recv), net: r3(net), waste: r3(wst), withdrawn: r3(net + wst), balance: bal, consumptionPercent: recv ? r3(((net + wst) / recv) * 100) : 0, wastePercent: net ? r3((wst / net) * 100) : 0, stockBalance: st, avgCost: pr.get(x.lot_no) == null ? null : r4(pr.get(x.lot_no)!), balanceValue: pr.get(x.lot_no) == null ? null : r3(bal * pr.get(x.lot_no)!) }; });
  const orphan = ru.filter((x) => !rc.some((r) => r.lot_no === x.lot_no)).map((x) => x.lot_no); if (orphan.length) alerts.push(`تشغيل على لوطات بلا وارد (ضمن التاريخ): ${orphan.join('، ')}`);
  const sum = (k: 'received' | 'net' | 'waste' | 'withdrawn' | 'balance') => r3(lots.reduce((s, l) => s + l[k], 0));
  const byItemMap = new Map<string, { item: string; received: number; net: number; waste: number; balance: number }>();
  for (const l of lots) { const e = byItemMap.get(l.item) ?? { item: l.item, received: 0, net: 0, waste: 0, balance: 0 }; e.received = r3(e.received + l.received); e.net = r3(e.net + l.net); e.waste = r3(e.waste + l.waste); e.balance = r3(e.balance + l.balance); byItemMap.set(l.item, e); }
  const byMachine = (await pool.query(`SELECT COALESCE(r.machine_code,'—') AS machine, COUNT(*)::int AS runs, SUM(r.fabric_kg) AS fabric, COALESCE(SUM(x.net),0) AS net, COALESCE(SUM(x.wst),0) AS wst
    FROM yarn_runs r LEFT JOIN (SELECT run_id, SUM(net_kg) AS net, SUM(waste_kg) AS wst FROM yarn_run_lines GROUP BY run_id) x ON x.run_id=r.id WHERE r.company_id=$1 AND r.status='active' AND r.run_date<=$2 GROUP BY COALESCE(r.machine_code,'—') ORDER BY 1`, [ctx.companyId, asOf])).rows
    .map((m) => ({ machine: m.machine, runs: m.runs, fabric: r3(Number(m.fabric)), net: r3(Number(m.net)), waste: r3(Number(m.wst)), wastePercent: Number(m.net) ? r3((Number(m.wst) / Number(m.net)) * 100) : 0 }));
  const tNet = sum('net'), tWaste = sum('waste'); const avg = tNet ? (tWaste / tNet) * 100 : 0; const limit = q.wasteLimit ?? r3(avg * 1.5);
  const high = limit > 0 ? (await pool.query(`SELECT r.id, r.run_date::text AS run_date, r.machine_code, r.fabric_kg, r.waste_percent, COALESCE(x.wst,0) AS wst FROM yarn_runs r LEFT JOIN (SELECT run_id, SUM(waste_kg) AS wst FROM yarn_run_lines GROUP BY run_id) x ON x.run_id=r.id WHERE r.company_id=$1 AND r.status='active' AND r.run_date<=$2 AND (CASE WHEN r.fabric_kg>0 THEN COALESCE(x.wst,0)/r.fabric_kg*100 ELSE 0 END) > $3 ORDER BY r.run_date`, [ctx.companyId, asOf, limit])).rows.map((r) => ({ id: r.id, date: r.run_date, machine: r.machine_code, fabric: Number(r.fabric_kg), wastePercent: r3((Number(r.wst) / Number(r.fabric_kg)) * 100), waste: r3(Number(r.wst)) })) : [];
  return { asOf: q.asOf ?? null, lots, totals: { stockValue: r3(lots.reduce((s2, l) => s2 + (l.balanceValue ?? 0), 0)), received: sum('received'), net: tNet, waste: tWaste, withdrawn: sum('withdrawn'), balance: sum('balance'), wastePercentOfNet: r3(avg), lotCount: lots.length, runCount: byMachine.reduce((s, m) => s + m.runs, 0) },
    byItem: [...byItemMap.values()], byMachine, wasteLimit: limit, highWasteRuns: high, alerts, check: Math.abs(sum('received') - sum('withdrawn') - sum('balance')) < 0.01 ? 'مطابق' : 'غير مطابق' };
}

export async function lotCard(ctx: RequestContext, raw: z.input<typeof lotCardSchema>) {
  ctx.assertPermission('yarnlot.view'); const { lotNo } = lotCardSchema.parse(raw);
  const rc = (await pool.query(`SELECT receipt_date::text AS d, receipt_no, quantity, notes, created_at FROM yarn_receipts WHERE company_id=$1 AND lot_no=$2 AND status='active'`, [ctx.companyId, lotNo])).rows;
  if (!rc.length) throw new NotFoundError('اللوط غير موجود');
  const ru = (await pool.query(`SELECT r.run_date::text AS d, r.machine_code, l.net_kg, l.waste_kg, l.blend_percent, r.created_at FROM yarn_run_lines l JOIN yarn_runs r ON r.id=l.run_id WHERE l.company_id=$1 AND l.lot_no=$2 AND r.status='active'`, [ctx.companyId, lotNo])).rows;
  const ev = [...rc.map((x) => ({ date: x.d, type: 'وارد', ref: x.receipt_no ?? '', machine: '', inKg: Number(x.quantity), netKg: 0, wasteKg: 0, at: x.created_at })), ...ru.map((x) => ({ date: x.d, type: 'تشغيل', ref: '', machine: x.machine_code ?? '', inKg: 0, netKg: Number(x.net_kg), wasteKg: Number(x.waste_kg), at: x.created_at }))]
    .sort((a, b) => (a.date === b.date ? (a.inKg ? -1 : 1) - (b.inKg ? -1 : 1) : a.date < b.date ? -1 : 1));
  let run = 0; return { lotNo, item: await itemOfLot(pool as unknown as Q, ctx.companyId, lotNo), movements: ev.map((e) => { run = r3(run + e.inKg - e.netKg - e.wasteKg); return { date: e.date, type: e.type, ref: e.ref, machine: e.machine, in: e.inKg, net: e.netKg, waste: e.wasteKg, balance: run }; }), balance: (await balance(pool as unknown as Q, ctx.companyId, lotNo)).balance };
}

/** استيراد من الشيت: dryRun يتحقق ويُرجع الأخطاء دون كتابة. النسب تصل بالمئة (الواجهة تحوّل الكسور). */
export async function importData(ctx: RequestContext, raw: z.input<typeof importSchema>) {
  ctx.assertPermission('yarnlot.import'); const b = importSchema.parse(raw); const errors: string[] = []; const notes: string[] = [];
  return withTransaction(async (c) => {
    await lock(c as Q, ctx.companyId, [...b.receipts.map((r) => r.lotNo), ...b.runs.flatMap((r) => r.lines.map((l) => l.lotNo))]);
    const itemOf = new Map<string, string>(); const stock = new Map<string, number>();
    const own = async (lotNo: string) => { if (!itemOf.has(lotNo)) { const it = await itemOfLot(c as Q, ctx.companyId, lotNo); if (it) itemOf.set(lotNo, it); } return itemOf.get(lotNo); };
    const delta = new Map<string, number>(); const bump = (l: string, v: number) => delta.set(l, (delta.get(l) ?? 0) + v);
    let recIn = 0, recDup = 0, runIn = 0, runDup = 0; const recRows: typeof b.receipts = []; const runRows: Array<{ run: (typeof b.runs)[number]; calc: ReturnType<typeof computeRun> }> = [];
    for (const [i, r] of b.receipts.entries()) {
      const known = (await own(r.lotNo)) ?? [...recRows].find((x) => x.lotNo === r.lotNo)?.itemName; if (known && known !== r.itemName) { errors.push(`وارد #${i + 1}: اللوط ${r.lotNo} بصنف «${r.itemName}» ≠ «${known}»`); continue; }
      if (r.receiptNo && (await c.query(`SELECT 1 FROM yarn_receipts WHERE company_id=$1 AND receipt_no=$2 AND lot_no=$3 AND status='active'`, [ctx.companyId, r.receiptNo, r.lotNo])).rows.length) { recDup++; continue; }
      if (r.receiptNo && recRows.some((x) => x.receiptNo === r.receiptNo && x.lotNo === r.lotNo)) { errors.push(`وارد #${i + 1}: إذن ${r.receiptNo} مكرر لنفس اللوط داخل الملف`); continue; }
      recRows.push(r); itemOf.set(r.lotNo, r.itemName); bump(r.lotNo, r.quantity); recIn++;
    }
    for (const [i, r] of b.runs.entries()) {
      const lots = r.lines.map((l) => l.lotNo); if (new Set(lots).size !== lots.length) { errors.push(`تشغيل #${i + 1}: لوط مكرر داخل التشغيلة`); continue; }
      const calc = computeRun(r.fabricKg, r.wastePercent, r.lines); if (Math.abs(calc.blendSum - 100) > 0.01) { errors.push(`تشغيل #${i + 1} (${r.date} ${r.machineCode ?? ''}): مجموع الخلط ${calc.blendSum}% ≠ 100%`); continue; }
      let bad = false; for (const l of calc.lines) { if (!(await own(l.lotNo))) { errors.push(`تشغيل #${i + 1}: اللوط ${l.lotNo} بلا وارد`); bad = true; } } if (bad) continue;
      const dup = (await c.query(`SELECT 1 FROM yarn_runs r WHERE r.company_id=$1 AND r.status='active' AND r.run_date=$2 AND COALESCE(r.machine_code,'')=$3 AND r.fabric_kg=$4 AND EXISTS (SELECT 1 FROM yarn_run_lines x WHERE x.run_id=r.id AND x.lot_no=$5)`, [ctx.companyId, r.date, r.machineCode ?? '', r.fabricKg, r.lines[0].lotNo])).rows.length;
      if (dup) { runDup++; continue; }
      runRows.push({ run: r, calc }); for (const l of calc.lines) bump(l.lotNo, -(l.netKg + l.wasteKg)); runIn++;
    }
    if (!b.allowNegative) for (const [lotNo, d] of delta) { const bal = await balance(c as Q, ctx.companyId, lotNo); if (bal.balance + d < -0.0005) errors.push(`اللوط ${lotNo}: الرصيد بعد الاستيراد ${r3(bal.balance + d)} كجم (سالب)`); }
    void stock; if (recDup || runDup) notes.push(`تخطّيت ${recDup} إذن وارد و${runDup} تشغيلة مكررة (موجودة سابقًا)`);
    const summary = { receipts: recIn, runs: runIn, skippedDuplicates: recDup + runDup, errors, notes, dryRun: b.dryRun, imported: false };
    if (b.dryRun || errors.length) return summary;
    for (const r of recRows) await c.query(`INSERT INTO yarn_receipts(company_id,receipt_date,receipt_no,lot_no,item_name,item_id,quantity,notes,source,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'import',$9)`, [ctx.companyId, r.date, r.receiptNo || null, r.lotNo, r.itemName, await resolveItem(c as Q, ctx.companyId, r.itemName), r.quantity, r.notes ?? null, ctx.userId]);
    for (const { run: r, calc } of runRows) {
      const machineId = r.machineCode ? (await c.query(`SELECT id FROM machines WHERE company_id=$1 AND code=$2 LIMIT 1`, [ctx.companyId, r.machineCode])).rows[0]?.id ?? null : null;
      const id = (await c.query(`INSERT INTO yarn_runs(company_id,run_date,machine_code,machine_id,fabric_kg,waste_percent,source,created_by) VALUES ($1,$2,$3,$4,$5,$6,'import',$7) RETURNING id`, [ctx.companyId, r.date, r.machineCode || null, machineId, r.fabricKg, r.wastePercent, ctx.userId])).rows[0].id;
      for (const l of calc.lines) await c.query(`INSERT INTO yarn_run_lines(run_id,company_id,lot_no,item_name,blend_percent,net_kg,waste_kg) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, ctx.companyId, l.lotNo, itemOf.get(l.lotNo) ?? null, l.blendPercent, l.netKg, l.wasteKg]);
    }
    await writeAuditLog(c, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'create', entityType: 'yarn_import', entityId: ctx.companyId, afterJson: { receipts: recIn, runs: runIn } });
    return { ...summary, imported: true };
  });
}

/** تكلفة الخيوط والهالك لأمر تصنيع: كل لوط بمتوسط سعره المرجّح (الواردات المسعَّرة فقط)؛ اللوط بلا سعر يُنبَّه عليه ولا يدخل القيمة. */
export async function orderYarnCost(ctx: RequestContext, orderId: string) {
  ctx.assertPermission('yarnlot.view');
  const o = (await pool.query(`SELECT id, document_number FROM production_orders WHERE id=$1 AND company_id=$2`, [orderId, ctx.companyId])).rows[0]; if (!o) throw new NotFoundError('أمر التصنيع غير موجود');
  const rows = (await pool.query(`SELECT l.lot_no, MIN(l.item_name) AS item, SUM(l.net_kg) AS net, SUM(l.waste_kg) AS wst, COUNT(DISTINCT r.id)::int AS runs FROM yarn_run_lines l JOIN yarn_runs r ON r.id=l.run_id WHERE r.company_id=$1 AND r.production_order_id=$2 AND r.status='active' GROUP BY l.lot_no ORDER BY l.lot_no`, [ctx.companyId, orderId])).rows;
  const fabric = Number((await pool.query(`SELECT COALESCE(SUM(fabric_kg),0) AS n FROM yarn_runs WHERE company_id=$1 AND production_order_id=$2 AND status='active'`, [ctx.companyId, orderId])).rows[0].n);
  const price = new Map((await pool.query(`SELECT lot_no, SUM(quantity*unit_price)/NULLIF(SUM(quantity),0) AS p FROM yarn_receipts WHERE company_id=$1 AND status='active' AND unit_price IS NOT NULL GROUP BY lot_no`, [ctx.companyId])).rows.map((x) => [x.lot_no, x.p === null ? null : Number(x.p)]));
  const warnings: string[] = []; const lots = rows.map((x) => { const p = price.get(x.lot_no) ?? null; const net = Number(x.net), wst = Number(x.wst); if (p === null) warnings.push(`اللوط ${x.lot_no} بلا سعر — لا تدخل قيمته في التكلفة`); return { lotNo: x.lot_no, item: x.item, netKg: r3(net), wasteKg: r3(wst), unitPrice: p === null ? null : r4(p), netCost: p === null ? null : r3(net * p), wasteCost: p === null ? null : r3(wst * p) }; });
  const netCost = r3(lots.reduce((s, l) => s + (l.netCost ?? 0), 0)), wasteCost = r3(lots.reduce((s, l) => s + (l.wasteCost ?? 0), 0));
  return { orderId, orderNo: o.document_number, fabricKg: r3(fabric), lots, totals: { netKg: r3(lots.reduce((s, l) => s + l.netKg, 0)), wasteKg: r3(lots.reduce((s, l) => s + l.wasteKg, 0)), netCost, wasteCost, totalCost: r3(netCost + wasteCost), wasteShareOfCost: netCost + wasteCost ? r3((wasteCost / (netCost + wasteCost)) * 100) : 0, costPerKgFabric: fabric ? r4((netCost + wasteCost) / fabric) : null }, warnings };
}

import { z } from 'zod';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError, ConflictError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { agedBalances } from '@/modules/accounting/financialReports';

/**
 * ترحيل الأرصدة إلى السنة الجديدة (2.18.0) — بخبرة مدير مالي:
 *  • يُرحَّل بالكامل: أرصدة حسابات الميزانية (أصول/التزامات/حقوق ملكية)، وأرصدة العملاء والموردين (فواتير مفتوحة + دفعات مقدمة)، ورصيد المخزون (كمية وقيمة لكل صنف/مخزن).
 *  • لا يُرحَّل: الإيرادات والمصروفات — تُقفل في الأرباح المرحَّلة بقيد إقفال السنة (شرط مسبق هنا: أرصدتها صفر).
 *  • لا قيد افتتاحيًا جديدًا في الدفتر: الدفتر تراكمي فالقيد كان سيضاعف الأرصدة؛ الناتج لقطة موثّقة قابلة للتدقيق والمقارنة (verify) وتُنشئ فترة السنة الجديدة إن غابت.
 */
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ YYYY-MM-DD');
export const previewSchema = z.strictObject({ toDate: date });
export const createSchema = z.strictObject({ toDate: date });
export const reverseSchema = z.strictObject({ reason: z.string().min(3) });
const r2 = (n: number) => Math.round(n * 100) / 100;
const IN_TYPES = `('opening','in','transfer_in','adjustment_in')`;

async function compute(ctx: RequestContext, toDate: string) {
  const co = (await pool.query(`SELECT id FROM companies WHERE id=$1`, [ctx.companyId])).rows[0]; if (!co) throw new NotFoundError('الشركة غير موجودة');
  const blockers: string[] = []; const warnings: string[] = [];
  const ye = (await pool.query(`SELECT id, from_date::text AS from_date, to_date::text AS to_date FROM year_end_closings WHERE company_id=$1 AND status='posted' AND to_date=$2 ORDER BY created_at DESC LIMIT 1`, [ctx.companyId, toDate])).rows[0];
  if (!ye) blockers.push(`لا قيد إقفال سنة مرحَّل ينتهي في ${toDate} — نفِّذه أولًا (حتى لا تُرحَّل الإيرادات والمصروفات)`);
  const gl = (await pool.query(`SELECT a.id, a.code, a.name_ar AS name, a.account_type AS type, COALESCE(SUM(l.debit - l.credit),0) AS bal
      FROM accounts a JOIN journal_lines l ON l.account_id=a.id JOIN journal_entries e ON e.id=l.journal_entry_id
      WHERE a.company_id=$1 AND e.status IN ('posted','reversed') AND e.entry_date<=$2 GROUP BY a.id, a.code, a.name_ar, a.account_type ORDER BY a.code`, [ctx.companyId, toDate])).rows;
  const pnl = gl.filter((a) => (a.type === 'revenue' || a.type === 'expense') && Math.abs(Number(a.bal)) >= 0.005);
  if (pnl.length) blockers.push(`${pnl.length} حساب إيراد/مصروف رصيده غير صفري بعد الإقفال (${pnl.slice(0, 3).map((a) => a.code).join('، ')}…) — راجع قيد إقفال السنة`);
  const accounts = gl.filter((a) => ['asset', 'liability', 'equity'].includes(a.type) && Math.abs(Number(a.bal)) >= 0.005).map((a) => { const b = Number(a.bal); return { id: a.id, code: a.code, name: a.name, type: a.type, debit: b > 0 ? r2(b) : 0, credit: b < 0 ? r2(-b) : 0, balance: r2(b) }; });
  const dr = r2(accounts.reduce((s, a) => s + a.debit, 0)), cr = r2(accounts.reduce((s, a) => s + a.credit, 0));
  if (Math.abs(dr - cr) >= 0.01) blockers.push(`أرصدة الميزانية غير متوازنة: مدين ${dr} ≠ دائن ${cr}`);

  const party = async (kind: 'receivable' | 'payable') => {
    const r = await agedBalances(ctx, { kind, asOf: toDate, detail: true } as never) as { parties: any[]; totals: { total: number }; unallocatedAdvances: number }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const rows = r.parties.filter((p) => Math.abs(p.total) >= 0.005 || Math.abs(p.unallocatedAdvance) >= 0.005).map((p) => ({ id: p.partyId, code: p.code, name: p.name, balance: r2(p.total), advance: r2(p.unallocatedAdvance), net: r2(p.total - p.unallocatedAdvance), invoices: (p.invoices ?? []).map((i: any) => ({ documentNumber: i.documentNumber, invoiceDate: i.invoiceDate, dueDate: i.dueDate, outstanding: i.outstandingBase, currency: i.currency })) })); // eslint-disable-line @typescript-eslint/no-explicit-any
    return { rows, total: r2(r.totals.total), advances: r2(r.unallocatedAdvances), net: r2(r.totals.total - r.unallocatedAdvances) };
  };
  const customers = await party('receivable'), suppliers = await party('payable');
  const ctl = async (tbl: 'customers' | 'suppliers', sign: 1 | -1, subNet: number, label: string) => {
    const accs = (await pool.query(`SELECT DISTINCT linked_account_id AS id FROM ${tbl} WHERE company_id=$1 AND linked_account_id IS NOT NULL`, [ctx.companyId])).rows.map((x) => x.id);
    if (!accs.length) return;
    const g = Number((await pool.query(`SELECT COALESCE(SUM(l.debit-l.credit),0) AS bal FROM journal_lines l JOIN journal_entries e ON e.id=l.journal_entry_id WHERE l.account_id = ANY($1::uuid[]) AND e.status IN ('posted','reversed') AND e.entry_date<=$2`, [accs, toDate])).rows[0].bal) * sign;
    if (Math.abs(g - subNet) >= 1) warnings.push(`${label}: دفتر الأستاذ ${r2(g)} ≠ دفتر الأطراف ${subNet} (فرق ${r2(g - subNet)}) — راجع قبل الاعتماد`);
  };
  await ctl('customers', 1, customers.net, 'العملاء'); await ctl('suppliers', -1, suppliers.net, 'الموردون');

  // المتوسط المرجّح: كل حركة تحمل unit_cost (وارد: المُدخَل، صرف: المتوسط وقت الصرف) فالقيمة = Σ وارد − Σ صرف بتكلفة الحركة.
  const inv = (await pool.query(`SELECT m.item_id, m.warehouse_id, i.code, i.name_ar AS name, w.name_ar AS wname,
      SUM(CASE WHEN m.movement_type IN ${IN_TYPES} THEN m.quantity ELSE -m.quantity END) AS qty,
      SUM(CASE WHEN m.movement_type IN ${IN_TYPES} THEN m.quantity * m.unit_cost ELSE -m.quantity * m.unit_cost END) AS val
      FROM stock_movements m JOIN items i ON i.id=m.item_id JOIN warehouses w ON w.id=m.warehouse_id
      WHERE m.company_id=$1 AND m.effective_date<=$2 GROUP BY m.item_id, m.warehouse_id, i.code, i.name_ar, w.name_ar HAVING ABS(SUM(CASE WHEN m.movement_type IN ${IN_TYPES} THEN m.quantity ELSE -m.quantity END)) > 0.00005 ORDER BY i.code`, [ctx.companyId, toDate])).rows;
  const inventory = inv.map((x) => { const qty = Number(x.qty); const val = r2(Number(x.val)); if (qty < 0) warnings.push(`رصيد مخزني سالب للصنف ${x.code} في ${x.wname}`); return { itemId: x.item_id, warehouseId: x.warehouse_id, code: x.code, name: x.name, warehouse: x.wname, quantity: qty, value: val, unitCost: qty > 0 ? r2(val / qty) : 0 }; });
  const invTotal = r2(inventory.reduce((s, x) => s + x.value, 0));
  const cur = Number((await pool.query(`SELECT COALESCE(SUM(quantity_on_hand * weighted_average_cost),0) AS v FROM stock_balances WHERE company_id=$1`, [ctx.companyId])).rows[0].v);
  const lastMove = (await pool.query(`SELECT max(effective_date)::text AS d FROM stock_movements WHERE company_id=$1`, [ctx.companyId])).rows[0].d;
  if (lastMove && lastMove <= toDate && Math.abs(cur - invTotal) >= 1) warnings.push(`قيمة المخزون من الحركات ${invTotal} تختلف عن الرصيد الحالي بالمتوسط المرجّح ${r2(cur)} — غالبًا تكاليف إضافية/تعديلات تكلفة؛ راجع.`);
  const exists = (await pool.query(`SELECT 1 FROM carry_forward_snapshots WHERE company_id=$1 AND to_date=$2 AND status='posted'`, [ctx.companyId, toDate])).rows.length;
  if (exists) blockers.push('رُحِّلت الأرصدة لهذه السنة بالفعل — اعكس اللقطة السابقة أولًا');
  const nextStart = (await pool.query(`SELECT ($1::date + 1)::text AS s, (($1::date + interval '1 year')::date)::text AS e`, [toDate])).rows[0];
  const np = (await pool.query(`SELECT id, start_date::text AS s, end_date::text AS e FROM fiscal_periods WHERE company_id=$1 AND start_date<=$2 AND end_date>=$2`, [ctx.companyId, nextStart.s])).rows[0];
  return { toDate, openingDate: nextStart.s, yearEnd: ye ?? null, blockers, warnings, canCreate: blockers.length === 0,
    accounts, accountTotals: { debit: dr, credit: cr }, customers, suppliers, inventory, inventoryTotal: invTotal,
    nextPeriod: np ? { exists: true, id: np.id, start: np.s, end: np.e } : { exists: false, start: nextStart.s, end: nextStart.e },
    excluded: { revenueExpenseAccounts: pnl.length, note: 'الإيرادات والمصروفات لا تُرحَّل — أُقفلت في الأرباح المرحَّلة.' } };
}

export async function preview(ctx: RequestContext, raw: z.input<typeof previewSchema>) { ctx.assertPermission('carryforward.view'); const b = previewSchema.parse(raw); return compute(ctx, b.toDate); }

export async function create(ctx: RequestContext, raw: z.input<typeof createSchema>) {
  ctx.assertPermission('carryforward.create'); const b = createSchema.parse(raw); const p = await compute(ctx, b.toDate);
  if (!p.canCreate) throw new ValidationError(p.blockers.join(' • '));
  return withTransaction(async (client) => {
    let periodId = p.nextPeriod.exists ? (p.nextPeriod as { id: string }).id : null;
    if (!periodId) periodId = (await client.query(`INSERT INTO fiscal_periods(company_id,start_date,end_date,status) VALUES ($1,$2,$3,'open') RETURNING id`, [ctx.companyId, p.nextPeriod.start, p.nextPeriod.end])).rows[0].id;
    const totals = { accountsDebit: p.accountTotals.debit, accountsCredit: p.accountTotals.credit, customers: p.customers.net, suppliers: p.suppliers.net, inventory: p.inventoryTotal, accounts: p.accounts.length, customerCount: p.customers.rows.length, supplierCount: p.suppliers.rows.length, inventoryLines: p.inventory.length };
    const from = (p.yearEnd as { from_date: string }).from_date;
    const s = (await client.query(`INSERT INTO carry_forward_snapshots(company_id,from_date,to_date,opening_date,next_period_id,year_end_closing_id,totals,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [ctx.companyId, from, b.toDate, p.openingDate, periodId, (p.yearEnd as { id: string }).id, JSON.stringify(totals), ctx.userId])).rows[0];
    const ins = (kind: string, ref: string | null, wh: string | null, code: string, name: string, debit: number, credit: number, qty: number | null, amount: number, detail: unknown) => client.query(`INSERT INTO carry_forward_lines(snapshot_id,company_id,kind,ref_id,warehouse_id,code,name,debit,credit,quantity,amount,detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [s.id, ctx.companyId, kind, ref, wh, code, name, debit, credit, qty, amount, detail ? JSON.stringify(detail) : null]);
    for (const a of p.accounts) await ins('account', a.id, null, a.code, a.name, a.debit, a.credit, null, a.balance, { type: a.type });
    for (const c of p.customers.rows) await ins('customer', c.id, null, c.code, c.name, 0, 0, null, c.net, { balance: c.balance, advance: c.advance, invoices: c.invoices });
    for (const c of p.suppliers.rows) await ins('supplier', c.id, null, c.code, c.name, 0, 0, null, c.net, { balance: c.balance, advance: c.advance, invoices: c.invoices });
    for (const x of p.inventory) await ins('inventory', x.itemId, x.warehouseId, x.code, x.name, 0, 0, x.quantity, x.value, { warehouse: x.warehouse, unitCost: x.unitCost });
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'create', entityType: 'carry_forward', entityId: s.id, afterJson: totals });
    return { ...s, totals, nextPeriodCreated: !p.nextPeriod.exists, warnings: p.warnings };
  });
}

export async function list(ctx: RequestContext) { ctx.assertPermission('carryforward.view'); return (await pool.query(`SELECT id, from_date::text AS from_date, to_date::text AS to_date, opening_date::text AS opening_date, status, totals, created_at FROM carry_forward_snapshots WHERE company_id=$1 ORDER BY to_date DESC, created_at DESC`, [ctx.companyId])).rows; }

export async function get(ctx: RequestContext, id: string) {
  ctx.assertPermission('carryforward.view');
  const s = (await pool.query(`SELECT id, from_date::text AS from_date, to_date::text AS to_date, opening_date::text AS opening_date, status, totals, reverse_reason FROM carry_forward_snapshots WHERE id=$1 AND company_id=$2`, [id, ctx.companyId])).rows[0];
  if (!s) throw new NotFoundError('اللقطة غير موجودة');
  const lines = (await pool.query(`SELECT kind, ref_id, warehouse_id, code, name, debit, credit, quantity, amount, detail FROM carry_forward_lines WHERE snapshot_id=$1 ORDER BY kind, code`, [id])).rows.map((l) => ({ ...l, debit: Number(l.debit), credit: Number(l.credit), quantity: l.quantity === null ? null : Number(l.quantity), amount: Number(l.amount) }));
  return { ...s, accounts: lines.filter((l) => l.kind === 'account'), customers: lines.filter((l) => l.kind === 'customer'), suppliers: lines.filter((l) => l.kind === 'supplier'), inventory: lines.filter((l) => l.kind === 'inventory') };
}

/** مقارنة اللقطة بالحساب الحالي لنفس التاريخ — يكشف أي ترحيل بأثر رجعي غيّر أرصدة سنة مُرحَّلة. */
export async function verify(ctx: RequestContext, id: string) {
  ctx.assertPermission('carryforward.view'); const s = await get(ctx, id); const now = await compute(ctx, s.to_date);
  const diffs: string[] = [];
  const cmp = (label: string, was: Map<string, number>, nowM: Map<string, number>, names: Map<string, string>) => { for (const key of new Set([...was.keys(), ...nowM.keys()])) { const x = was.get(key) ?? 0, y = nowM.get(key) ?? 0; if (Math.abs(x - y) >= 0.01) diffs.push(`${label} ${names.get(key) ?? key}: اللقطة ${r2(x)} ≠ الآن ${r2(y)}`); } };
  const mapOf = (rows: Array<{ id: string; v: number; n: string }>) => ({ m: new Map(rows.map((r) => [r.id, r.v])), n: new Map(rows.map((r) => [r.id, r.n])) });
  const pairs: Array<[string, Array<{ id: string; v: number; n: string }>, Array<{ id: string; v: number; n: string }>]> = [
    ['حساب', s.accounts.map((l: any) => ({ id: l.ref_id, v: l.amount, n: l.code })), now.accounts.map((a) => ({ id: a.id, v: a.balance, n: a.code }))], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['عميل', s.customers.map((l: any) => ({ id: l.ref_id, v: l.amount, n: l.code })), now.customers.rows.map((c) => ({ id: c.id, v: c.net, n: c.code }))], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['مورد', s.suppliers.map((l: any) => ({ id: l.ref_id, v: l.amount, n: l.code })), now.suppliers.rows.map((c) => ({ id: c.id, v: c.net, n: c.code }))], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['مخزون (قيمة)', s.inventory.map((l: any) => ({ id: `${l.ref_id}|${l.warehouse_id}`, v: l.amount, n: l.code })), now.inventory.map((x) => ({ id: `${x.itemId}|${x.warehouseId}`, v: x.value, n: x.code }))], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['مخزون (كمية)', s.inventory.map((l: any) => ({ id: `${l.ref_id}|${l.warehouse_id}`, v: l.quantity ?? 0, n: l.code })), now.inventory.map((x) => ({ id: `${x.itemId}|${x.warehouseId}`, v: x.quantity, n: x.code }))], // eslint-disable-line @typescript-eslint/no-explicit-any
  ];
  for (const [label, a, b2] of pairs) { const wa = mapOf(a), nb = mapOf(b2); cmp(label, wa.m, nb.m, new Map([...wa.n, ...nb.n])); }
  return { id, toDate: s.to_date, matches: diffs.length === 0, differences: diffs };
}

export async function reverse(ctx: RequestContext, id: string, raw: z.input<typeof reverseSchema>) {
  ctx.assertPermission('carryforward.reverse'); const b = reverseSchema.parse(raw);
  const s = (await pool.query(`SELECT status FROM carry_forward_snapshots WHERE id=$1 AND company_id=$2`, [id, ctx.companyId])).rows[0];
  if (!s) throw new NotFoundError('اللقطة غير موجودة'); if (s.status !== 'posted') throw new ConflictError('معكوسة بالفعل');
  const row = (await pool.query(`UPDATE carry_forward_snapshots SET status='reversed', reverse_reason=$2, reversed_at=now() WHERE id=$1 RETURNING id, status`, [id, b.reason])).rows[0];
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'carry_forward', entityId: id, afterJson: { reversed: true, reason: b.reason } });
  return row;
}

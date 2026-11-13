import { z } from 'zod';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError, ConflictError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { uuid, optionalUuid } from '@/shared/zodSchemas';
import { assertManufacturingEnabled } from '@/modules/manufacturing/manufacturingService';
import { incentiveReport } from '@/modules/manufacturing/textileOpsService';
import { computePay, hoursBetween } from '@/modules/manufacturing/textilePayroll';
import { groupPunches, lateMinutes, leaveEntitlement } from '@/modules/manufacturing/textileHrPure';
import { payrollEntryAmounts, payrollEntryLines } from '@/modules/manufacturing/textilePayrollPosting';
import { postJournalEntry, reverseJournalEntry } from '@/modules/accounting/accountingService';
import { createTreasuryTransaction, postTreasuryTransaction, reverseTreasuryTransaction } from '@/modules/treasury/treasuryTransactionService';

/** الحضور والرواتب لعمالة المصنع (هجرة 0049). كشف تشغيلي بلا ترحيل قيود. */
type B = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'الشهر بصيغة YYYY-MM');
const STATUS = ['present', 'absent', 'leave_paid', 'leave_unpaid', 'sick', 'holiday', 'weekly_off'] as const;

export const workerPaySchema = z.strictObject({
  payType: z.enum(['monthly', 'daily', 'hourly']), baseRate: z.number().min(0).max(1e9), stdHoursPerDay: z.number().gt(0).max(24).optional(),
  overtimeMultiplier: z.number().min(1).max(5).optional(), insurancePercent: z.number().min(0).max(100).optional(), employerInsurancePercent: z.number().min(0).max(100).optional(), annualLeaveDays: z.number().min(0).max(366).optional(), hireDate: date.optional(),
});
export const attendanceBulkSchema = z.strictObject({
  workDate: date,
  records: z.array(z.strictObject({
    workerId: uuid, status: z.enum(STATUS), checkIn: time.optional(), checkOut: time.optional(),
    hoursWorked: z.number().min(0).max(24).optional(), overtimeHours: z.number().min(0).max(24).optional(), lateMinutes: z.number().int().min(0).max(1440).optional(), notes: z.string().max(200).optional(),
  })).min(1).max(1000),
});
export const attendanceQuerySchema = z.object({ date: date.optional(), month: month.optional(), workerId: optionalUuid }).passthrough();
export const adjustmentSchema = z.strictObject({ workerId: uuid, adjDate: date, kind: z.enum(['advance', 'penalty', 'deduction', 'bonus', 'allowance']), amount: z.number().positive().max(1e9), reason: z.string().max(200).optional() });
export const importSchema = z.strictObject({
  punches: z.array(z.strictObject({ workerCode: z.string().min(1).max(40), timestamp: z.string().min(10).max(25) })).min(1).max(20000),
  shiftStart: time.optional(), graceMinutes: z.number().int().min(0).max(240).optional(), dryRun: z.boolean().optional(),
});
export const leaveQuerySchema = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }).passthrough();
export const adjQuerySchema = z.object({ month: month.optional(), workerId: optionalUuid }).passthrough();
export const runBodySchema = z.strictObject({ branchId: optionalUuid, month, workingDays: z.number().int().min(1).max(31) });
export const postRunSchema = z.strictObject({ branchId: uuid, fiscalPeriodId: uuid, entryDate: date });
export const payRunSchema = z.strictObject({ branchId: uuid, safeOrBankId: uuid, fiscalPeriodId: uuid, transactionDate: date, amount: z.number().positive().max(1e12).optional() });
export const unpayRunSchema = z.strictObject({ reason: z.string().min(3).max(300), paymentId: optionalUuid });
export const unpostRunSchema = z.strictObject({ reason: z.string().min(3).max(300) });
export const postingSettingsSchema = z.strictObject({ wagesExpenseAccountId: uuid, salariesPayableAccountId: uuid, insuranceAccountId: uuid, advancesAccountId: uuid });
export const cancelRunSchema = z.strictObject({ reason: z.string().min(3).max(300) });

const bounds = (m: string) => { const [y, mo] = m.split('-').map(Number); const last = new Date(Date.UTC(y, mo, 0)).getUTCDate(); return { from: `${m}-01`, to: `${m}-${String(last).padStart(2, '0')}` }; };

export async function updateWorkerPay(ctx: RequestContext, workerId: string, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.hr.manage');
  const r = await pool.query(
    `UPDATE textile_workers SET pay_type=$3, base_rate=$4, std_hours_per_day=COALESCE($5,std_hours_per_day), overtime_multiplier=COALESCE($6,overtime_multiplier), insurance_percent=COALESCE($7,insurance_percent), hire_date=COALESCE($8,hire_date), employer_insurance_percent=COALESCE($9,employer_insurance_percent), annual_leave_days=COALESCE($10,annual_leave_days)
     WHERE id=$1 AND company_id=$2 RETURNING *`, [workerId, ctx.companyId, b.payType, b.baseRate, b.stdHoursPerDay ?? null, b.overtimeMultiplier ?? null, b.insurancePercent ?? null, b.hireDate ?? null, b.employerInsurancePercent ?? null, b.annualLeaveDays ?? null]);
  if (!r.rows[0]) throw new NotFoundError('العامل غير موجود');
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'worker_pay', entityId: workerId, afterJson: { payType: b.payType } });
  return r.rows[0];
}

export async function saveAttendance(ctx: RequestContext, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.hr.manage');
  const ids: string[] = b.records.map((r: B) => r.workerId);
  if (new Set(ids).size !== ids.length) throw new ValidationError('عامل مكرر في نفس اليوم');
  const ws = (await pool.query(`SELECT id, std_hours_per_day FROM textile_workers WHERE company_id=$1 AND id = ANY($2::uuid[])`, [ctx.companyId, ids])).rows;
  if (ws.length !== ids.length) throw new ValidationError('عامل غير موجود');
  const std = new Map<string, number>(ws.map((w) => [w.id, Number(w.std_hours_per_day)]));
  await withTransaction(async (client) => {
    for (const r of b.records) {
      const worked = r.status === 'present' ? (r.hoursWorked ?? (r.checkIn && r.checkOut ? hoursBetween(r.checkIn, r.checkOut) : std.get(r.workerId)!)) : 0;
      const ot = r.status === 'present' ? (r.overtimeHours ?? Math.max(0, worked - std.get(r.workerId)!)) : 0;
      await client.query(
        `INSERT INTO attendance_records(company_id, worker_id, work_date, status, check_in, check_out, hours_worked, overtime_hours, late_minutes, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (worker_id, work_date) DO UPDATE SET status=EXCLUDED.status, check_in=EXCLUDED.check_in, check_out=EXCLUDED.check_out, hours_worked=EXCLUDED.hours_worked, overtime_hours=EXCLUDED.overtime_hours, late_minutes=EXCLUDED.late_minutes, notes=EXCLUDED.notes`,
        [ctx.companyId, r.workerId, b.workDate, r.status, r.checkIn ?? null, r.checkOut ?? null, worked, ot, r.status === 'present' ? r.lateMinutes ?? 0 : 0, r.notes ?? null, ctx.userId]);
    }
  });
  return { saved: b.records.length, workDate: b.workDate };
}

export async function listAttendance(ctx: RequestContext, q: { date?: string; month?: string; workerId?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.hr.view');
  const rg = q.month ? bounds(q.month) : q.date ? { from: q.date, to: q.date } : (() => { throw new ValidationError('حدّد date أو month'); })();
  return (await pool.query(
    `SELECT a.*, w.code, w.name_ar FROM attendance_records a JOIN textile_workers w ON w.id=a.worker_id AND w.company_id=a.company_id
     WHERE a.company_id=$1 AND a.work_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR a.worker_id=$4) ORDER BY a.work_date, w.code`, [ctx.companyId, rg.from, rg.to, q.workerId ?? null])).rows;
}

export async function createAdjustment(ctx: RequestContext, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.hr.manage');
  try {
    return (await pool.query(`INSERT INTO worker_adjustments(company_id, worker_id, adj_date, kind, amount, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [ctx.companyId, b.workerId, b.adjDate, b.kind, b.amount, b.reason ?? null, ctx.userId])).rows[0];
  } catch (e) { if ((e as { code?: string }).code === '23503') throw new ValidationError('العامل غير موجود'); throw e; }
}
export async function listAdjustments(ctx: RequestContext, q: { month?: string; workerId?: string }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.hr.view');
  const rg = q.month ? bounds(q.month) : { from: '1900-01-01', to: '2999-12-31' };
  return (await pool.query(
    `SELECT a.*, w.code, w.name_ar FROM worker_adjustments a JOIN textile_workers w ON w.id=a.worker_id AND w.company_id=a.company_id
     WHERE a.company_id=$1 AND a.adj_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR a.worker_id=$4) ORDER BY a.adj_date DESC LIMIT 500`, [ctx.companyId, rg.from, rg.to, q.workerId ?? null])).rows;
}
export async function deleteAdjustment(ctx: RequestContext, id: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.hr.manage');
  const a = (await pool.query(`SELECT adj_date FROM worker_adjustments WHERE id=$1 AND company_id=$2`, [id, ctx.companyId])).rows[0];
  if (!a) throw new NotFoundError('البند غير موجود');
  const m = String(a.adj_date.toISOString?.().slice(0, 7) ?? a.adj_date).slice(0, 7);
  const locked = (await pool.query(`SELECT 1 FROM payroll_runs WHERE company_id=$1 AND status='approved' AND to_char(period_month,'YYYY-MM')=$2`, [ctx.companyId, m])).rows[0];
  if (locked) throw new ConflictError('كشف رواتب معتمد لهذا الشهر — لا يُحذف البند');
  await pool.query(`DELETE FROM worker_adjustments WHERE id=$1 AND company_id=$2`, [id, ctx.companyId]);
  return { id, deleted: true };
}

/* ============================== كشف الرواتب ============================== */

async function buildLines(ctx: RequestContext, run: { branch_id: string | null; month: string; working_days: number }) {
  const { from, to } = bounds(run.month);
  const workers = (await pool.query(
    `SELECT * FROM textile_workers WHERE company_id=$1 AND is_active AND base_rate>0 AND ($2::uuid IS NULL OR branch_id=$2) AND (hire_date IS NULL OR hire_date<=$3::date) ORDER BY code`,
    [ctx.companyId, run.branch_id, to])).rows;
  const att = (await pool.query(
    `SELECT worker_id,
       COUNT(*) FILTER (WHERE status='present')::int present, COUNT(*) FILTER (WHERE status='leave_paid')::int leave_paid, COUNT(*) FILTER (WHERE status='sick')::int sick,
       COUNT(*) FILTER (WHERE status='holiday')::int holiday, COUNT(*) FILTER (WHERE status='absent')::int absent, COUNT(*) FILTER (WHERE status='leave_unpaid')::int leave_unpaid,
       COALESCE(SUM(hours_worked),0) hours, COALESCE(SUM(overtime_hours),0) ot, COALESCE(SUM(late_minutes),0)::int late
     FROM attendance_records WHERE company_id=$1 AND work_date BETWEEN $2 AND $3 GROUP BY worker_id`, [ctx.companyId, from, to])).rows;
  const adj = (await pool.query(`SELECT worker_id, kind, SUM(amount) amt FROM worker_adjustments WHERE company_id=$1 AND adj_date BETWEEN $2 AND $3 GROUP BY worker_id, kind`, [ctx.companyId, from, to])).rows;
  const inc = await incentiveReport(ctx, { from, to });
  const incMap = new Map<string, number>(inc.workers.map((x: B) => [x.worker_id, Number(x.incentive)]));
  const lines = workers.map((w) => {
    const a = att.find((x) => x.worker_id === w.id);
    const adjOf = (k: string) => Number(adj.find((x) => x.worker_id === w.id && x.kind === k)?.amt ?? 0);
    const r = computePay(
      { payType: w.pay_type, baseRate: Number(w.base_rate), stdHoursPerDay: Number(w.std_hours_per_day), overtimeMultiplier: Number(w.overtime_multiplier), insurancePercent: Number(w.insurance_percent), employerInsurancePercent: Number(w.employer_insurance_percent) },
      run.working_days,
      { present: a?.present ?? 0, leavePaid: a?.leave_paid ?? 0, sick: a?.sick ?? 0, holiday: a?.holiday ?? 0, absent: a?.absent ?? 0, leaveUnpaid: a?.leave_unpaid ?? 0, hours: Number(a?.hours ?? 0), overtimeHours: Number(a?.ot ?? 0), lateMinutes: a?.late ?? 0 },
      incMap.get(w.id) ?? 0,
      { advance: adjOf('advance'), penalty: adjOf('penalty'), deduction: adjOf('deduction'), bonus: adjOf('bonus'), allowance: adjOf('allowance') });
    return { worker: w, r, hasAttendance: !!a };
  });
  return lines;
}

async function writeLines(client: any, ctx: RequestContext, runId: string, lines: Awaited<ReturnType<typeof buildLines>>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  await client.query(`DELETE FROM payroll_lines WHERE run_id=$1`, [runId]);
  let total = 0;
  for (const { worker: w, r } of lines) {
    total += r.net;
    await client.query(
      `INSERT INTO payroll_lines(company_id, run_id, worker_id, pay_type, base_rate, days_paid, days_absent, hours_worked, overtime_hours, base_pay, overtime_pay, incentive, allowances, gross, insurance, late_deduction, advances, penalties, other_deductions, net, employer_insurance)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [ctx.companyId, runId, w.id, w.pay_type, w.base_rate, r.daysPaid, r.daysAbsent, r.hoursWorked, r.overtimeHours, r.basePay, r.overtimePay, r.incentive, r.allowances, r.gross, r.insurance, r.lateDeduction, r.advances, r.penalties, r.otherDeductions, r.net, r.employerInsurance]);
  }
  await client.query(`UPDATE payroll_runs SET total_net=$2 WHERE id=$1`, [runId, +total.toFixed(2)]);
  return +total.toFixed(2);
}

export async function createRun(ctx: RequestContext, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.payroll.manage');
  const lines = await buildLines(ctx, { branch_id: b.branchId ?? null, month: b.month, working_days: b.workingDays });
  if (!lines.length) throw new ValidationError('لا عمال نشطون بأجر مُعرَّف (حدّد أجر العمال أولاً)');
  return withTransaction(async (client) => {
    let run;
    try {
      run = (await client.query(`INSERT INTO payroll_runs(company_id, branch_id, period_month, working_days, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [ctx.companyId, b.branchId ?? null, `${b.month}-01`, b.workingDays, ctx.userId])).rows[0];
    } catch (e) { if ((e as { code?: string }).code === '23505') throw new ConflictError('يوجد كشف رواتب لهذا الشهر/الفرع (ألغِه أولاً أو أعد حسابه)'); throw e; }
    const total = await writeLines(client, ctx, run.id, lines);
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'create', entityType: 'payroll_run', entityId: run.id, afterJson: { month: b.month, workers: lines.length, total } });
    return { ...run, total_net: total, noAttendance: lines.filter((l) => !l.hasAttendance).map((l) => l.worker.name_ar) };
  });
}

export async function recalcRun(ctx: RequestContext, id: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.payroll.manage');
  const run = (await pool.query(`SELECT *, to_char(period_month,'YYYY-MM') AS month FROM payroll_runs WHERE id=$1 AND company_id=$2`, [id, ctx.companyId])).rows[0];
  if (!run) throw new NotFoundError('الكشف غير موجود');
  if (run.status !== 'draft') throw new ConflictError('يُعاد الحساب للمسودة فقط');
  const lines = await buildLines(ctx, run);
  const total = await withTransaction((client) => writeLines(client, ctx, id, lines));
  return { id, total_net: total, workers: lines.length };
}

export async function approveRun(ctx: RequestContext, id: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.payroll.approve');
  const r = await pool.query(`UPDATE payroll_runs SET status='approved', approved_by=$3, approved_at=now() WHERE id=$1 AND company_id=$2 AND status='draft' RETURNING id, total_net`, [id, ctx.companyId, ctx.userId]);
  if (!r.rows[0]) throw new ConflictError('الكشف غير موجود أو ليس مسودة');
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'payroll_run', entityId: id, afterJson: { status: 'approved' } });
  return r.rows[0];
}
export async function cancelRun(ctx: RequestContext, id: string, reason: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.payroll.approve');
  const posted = (await pool.query(`SELECT 1 FROM payroll_runs WHERE id=$1 AND company_id=$2 AND journal_entry_id IS NOT NULL`, [id, ctx.companyId])).rows[0];
  if (posted) throw new ConflictError('الكشف مُرحَّل بقيد — ألغِ الترحيل أولاً');
  const r = await pool.query(`UPDATE payroll_runs SET status='cancelled', cancelled_reason=$3 WHERE id=$1 AND company_id=$2 AND status IN ('draft','approved') RETURNING id`, [id, ctx.companyId, reason]);
  if (!r.rows[0]) throw new ConflictError('الكشف غير موجود أو ملغى');
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'payroll_run', entityId: id, afterJson: { status: 'cancelled', reason } });
  return { id, status: 'cancelled' };
}
export async function listRuns(ctx: RequestContext) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.payroll.view');
  return (await pool.query(`SELECT r.*, to_char(r.period_month,'YYYY-MM') AS month, (SELECT COUNT(*) FROM payroll_lines l WHERE l.run_id=r.id)::int AS workers, (SELECT COALESCE(SUM(amount),0) FROM payroll_payments p WHERE p.run_id=r.id) AS paid FROM payroll_runs r WHERE company_id=$1 ORDER BY period_month DESC, created_at DESC LIMIT 100`, [ctx.companyId])).rows;
}
export async function getRun(ctx: RequestContext, id: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.payroll.view');
  const run = (await pool.query(`SELECT *, to_char(period_month,'YYYY-MM') AS month FROM payroll_runs WHERE id=$1 AND company_id=$2`, [id, ctx.companyId])).rows[0];
  if (!run) throw new NotFoundError('الكشف غير موجود');
  const lines = (await pool.query(`SELECT l.*, w.code, w.name_ar, w.job_title FROM payroll_lines l JOIN textile_workers w ON w.id=l.worker_id AND w.company_id=l.company_id WHERE l.run_id=$1 ORDER BY w.code`, [id])).rows;
  const payments = (await pool.query(`SELECT id, transaction_id, amount, paid_at FROM payroll_payments WHERE run_id=$1 ORDER BY paid_at`, [id])).rows;
  const paid = payments.reduce((a, x) => a + Number(x.amount), 0);
  return { run, lines, payments, paid: Math.round(paid * 100) / 100, remaining: Math.round((Number(run.total_net) - paid) * 100) / 100 };
}

/* ============================== ترحيل الكشف إلى القيود (0050) ============================== */

const DEFAULT_ACCOUNTS: Array<[string, string, string, string, string]> = [
  ['wages', '5060', 'أجور ومرتبات', 'Wages & Salaries', 'expense'], ['payable', '2060', 'رواتب مستحقة', 'Salaries Payable', 'liability'],
  ['insurance', '2070', 'تأمينات اجتماعية مستحقة', 'Social Insurance Payable', 'liability'], ['advances', '1060', 'سلف العاملين', 'Employee Advances', 'asset'],
];

/** يُنشئ الحسابات الأربعة (إن لم توجد بنفس الكود) وصف الإعداد عند أول استخدام. */
async function ensureSettings(ctx: RequestContext) {
  const ex = (await pool.query(`SELECT * FROM payroll_account_settings WHERE company_id=$1`, [ctx.companyId])).rows[0];
  if (ex) return ex;
  const ids: Record<string, string> = {};
  for (const [key, code, ar, en, type] of DEFAULT_ACCOUNTS) {
    await pool.query(`INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (company_id, code) DO NOTHING`, [ctx.companyId, code, ar, en, type]);
    ids[key] = (await pool.query(`SELECT id FROM accounts WHERE company_id=$1 AND code=$2`, [ctx.companyId, code])).rows[0].id;
  }
  return (await pool.query(
    `INSERT INTO payroll_account_settings(company_id, wages_expense_account_id, salaries_payable_account_id, insurance_payable_account_id, advances_account_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (company_id) DO UPDATE SET company_id=EXCLUDED.company_id RETURNING *`,
    [ctx.companyId, ids.wages, ids.payable, ids.insurance, ids.advances])).rows[0];
}
export async function getPostingSettings(ctx: RequestContext) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.payroll.post');
  return ensureSettings(ctx);
}
export async function updatePostingSettings(ctx: RequestContext, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.payroll.post');
  const ids = [b.wagesExpenseAccountId, b.salariesPayableAccountId, b.insuranceAccountId, b.advancesAccountId];
  const ok = (await pool.query(`SELECT COUNT(DISTINCT id)::int n FROM accounts WHERE company_id=$1 AND id = ANY($2::uuid[])`, [ctx.companyId, ids])).rows[0].n;
  if (ok !== new Set(ids).size) throw new ValidationError('حساب غير موجود');
  await ensureSettings(ctx);
  return (await pool.query(
    `UPDATE payroll_account_settings SET wages_expense_account_id=$2, salaries_payable_account_id=$3, insurance_payable_account_id=$4, advances_account_id=$5, updated_at=now() WHERE company_id=$1 RETURNING *`,
    [ctx.companyId, ...ids])).rows[0];
}

export async function postRun(ctx: RequestContext, id: string, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.payroll.post', b.branchId);
  const run = (await pool.query(`SELECT *, to_char(period_month,'YYYY-MM') AS month FROM payroll_runs WHERE id=$1 AND company_id=$2`, [id, ctx.companyId])).rows[0];
  if (!run) throw new NotFoundError('الكشف غير موجود');
  if (run.status !== 'approved') throw new ConflictError('يُرحَّل الكشف المعتمد فقط');
  if (run.journal_entry_id) throw new ConflictError('الكشف مُرحَّل بالفعل');
  const t = (await pool.query(
    `SELECT COALESCE(SUM(gross),0) gross, COALESCE(SUM(insurance),0) insurance, COALESCE(SUM(late_deduction),0) late, COALESCE(SUM(advances),0) advances,
            COALESCE(SUM(penalties),0) penalties, COALESCE(SUM(other_deductions),0) other, COALESCE(SUM(net),0) net, COALESCE(SUM(employer_insurance),0) emp FROM payroll_lines WHERE run_id=$1`, [id])).rows[0];
  const amounts = payrollEntryAmounts({ gross: Number(t.gross), insurance: Number(t.insurance), lateDeduction: Number(t.late), advances: Number(t.advances), penalties: Number(t.penalties), otherDeductions: Number(t.other), net: Number(t.net), employerInsurance: Number(t.emp) });
  const st = await ensureSettings(ctx);
  const acc: Record<string, string> = { wages: st.wages_expense_account_id, insurance: st.insurance_payable_account_id, advances: st.advances_account_id, payable: st.salaries_payable_account_id };
  const label: Record<string, string> = { wages: 'أجور ومرتبات', insurance: 'تأمينات مستحقة', advances: 'استرداد سلف', payable: 'رواتب مستحقة' };
  const lines = payrollEntryLines(amounts).map((l) => ({ accountId: acc[l.key], debit: l.debit.toFixed(4), credit: l.credit.toFixed(4), description: `${label[l.key]} ${run.month}` }));
  if (!lines.length) throw new ValidationError('الكشف بلا مبالغ للترحيل');
  const cur = (await pool.query(`SELECT base_currency_code FROM companies WHERE id=$1`, [ctx.companyId])).rows[0].base_currency_code;
  const je = await postJournalEntry(ctx, { branchId: b.branchId, fiscalPeriodId: b.fiscalPeriodId, entryDate: b.entryDate, currencyCode: cur, sourceDocumentType: 'payroll_run', sourceDocumentId: id, lines });
  const jeId = (je as B).id ?? (je as B).entryId;
  await pool.query(`UPDATE payroll_runs SET journal_entry_id=$3, posted_at=now(), posted_by=$4 WHERE id=$1 AND company_id=$2`, [id, ctx.companyId, jeId, ctx.userId]);
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'payroll_run', entityId: id, afterJson: { posted: true, journalEntryId: jeId, amounts } });
  return { id, journalEntryId: jeId, amounts };
}

export async function unpostRun(ctx: RequestContext, id: string, reason: string) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.payroll.post');
  const run = (await pool.query(`SELECT journal_entry_id, (SELECT COUNT(*) FROM payroll_payments p WHERE p.run_id=payroll_runs.id)::int AS pays FROM payroll_runs WHERE id=$1 AND company_id=$2`, [id, ctx.companyId])).rows[0];
  if (!run) throw new NotFoundError('الكشف غير موجود');
  if (!run.journal_entry_id) throw new ConflictError('الكشف غير مُرحَّل');
  if (run.pays > 0) throw new ConflictError('على الكشف دفعات صرف — ألغِها أولاً');
  const rev = await reverseJournalEntry(ctx, run.journal_entry_id, reason);
  await pool.query(`UPDATE payroll_runs SET journal_entry_id=NULL, posted_at=NULL, posted_by=NULL WHERE id=$1 AND company_id=$2`, [id, ctx.companyId]);
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'payroll_run', entityId: id, afterJson: { posted: false, reason, reversal: rev } });
  return { id, reversed: true, ...rev };
}

/* ============================== صرف الرواتب على دفعات (0051 + 0053) ============================== */

const paidOf = async (client: { query: (q: string, p?: unknown[]) => Promise<{ rows: B[] }> }, runId: string) =>
  Number((await client.query(`SELECT COALESCE(SUM(amount),0) AS s FROM payroll_payments WHERE run_id=$1`, [runId])).rows[0].s);

/** دفعة صرف (سند خزينة مرحَّل: مدين رواتب مستحقة / دائن الخزينة أو البنك). المبلغ الافتراضي = المتبقي؛ لا يتجاوز المتبقي. */
export async function payRun(ctx: RequestContext, id: string, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.payroll.post', b.branchId);
  return withTransaction(async (client) => {
    const run = (await client.query(`SELECT *, to_char(period_month,'YYYY-MM') AS month FROM payroll_runs WHERE id=$1 AND company_id=$2 FOR UPDATE`, [id, ctx.companyId])).rows[0];
    if (!run) throw new NotFoundError('الكشف غير موجود');
    if (!run.journal_entry_id) throw new ConflictError('رحِّل الكشف إلى القيود أولاً ليتكوّن رصيد الرواتب المستحقة');
    const net = Number(run.total_net);
    if (!(net > 0)) throw new ValidationError('صافي الكشف صفر أو سالب — لا يوجد ما يُصرف');
    const remaining = Math.round((net - (await paidOf(client, id))) * 100) / 100;
    if (remaining <= 0) throw new ConflictError('الكشف مصروف بالكامل');
    const amount = b.amount ?? remaining;
    if (amount > remaining + 0.005) throw new ValidationError(`المبلغ ${amount} يتجاوز المتبقي ${remaining}`);
    const st = await ensureSettings(ctx);
    const cur = (await client.query(`SELECT base_currency_code FROM companies WHERE id=$1`, [ctx.companyId])).rows[0].base_currency_code;
    const tx = await createTreasuryTransaction(ctx, {
      branchId: b.branchId, safeOrBankId: b.safeOrBankId, transactionType: 'payment', counterpartyType: 'other', contraAccountId: st.salaries_payable_account_id,
      amount: Number(amount).toFixed(4), currencyCode: cur, transactionDate: b.transactionDate, fiscalPeriodId: b.fiscalPeriodId, description: `صرف رواتب ${run.month}`,
    }, client);
    await postTreasuryTransaction(ctx, tx.id, client);
    await client.query(`INSERT INTO payroll_payments(company_id, run_id, transaction_id, amount, paid_by) VALUES ($1,$2,$3,$4,$5)`, [ctx.companyId, id, tx.id, amount, ctx.userId]);
    await writeAuditLog(client, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'payroll_run', entityId: id, afterJson: { paid: amount, paymentTransactionId: tx.id } });
    return { id, paymentTransactionId: tx.id, documentNumber: tx.document_number, amount, remaining: Math.round((remaining - amount) * 100) / 100 };
  });
}

export async function unpayRun(ctx: RequestContext, id: string, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.payroll.post');
  const pays = (await pool.query(`SELECT id, transaction_id, amount FROM payroll_payments WHERE run_id=$1 AND company_id=$2 ORDER BY paid_at`, [id, ctx.companyId])).rows;
  if (!pays.length) throw new ConflictError('لا دفعات على هذا الكشف');
  const pay = b.paymentId ? pays.find((x) => x.id === b.paymentId) : pays.length === 1 ? pays[0] : undefined;
  if (!pay) throw new ValidationError(pays.length > 1 ? 'حدّد paymentId لإحدى الدفعات' : 'الدفعة غير موجودة');
  const rev = await reverseTreasuryTransaction(ctx, pay.transaction_id, b.reason);
  await pool.query(`DELETE FROM payroll_payments WHERE id=$1 AND company_id=$2`, [pay.id, ctx.companyId]);
  await writeAuditLog(pool, { tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId, action: 'update', entityType: 'payroll_run', entityId: id, afterJson: { unpaid: Number(pay.amount), reason: b.reason } });
  return { id, reversedAmount: Number(pay.amount), ...(rev as B) };
}

/* ============================== استيراد بصمات الحضور + رصيد الإجازات (0053) ============================== */

/** يستورد بصمات جهاز (CSV/JSON بعد تحويله): أول بصمة دخول وآخر بصمة خروج لكل عامل/يوم، ويحسب الساعات والإضافي والتأخر. dryRun يعرض النتيجة بلا حفظ. */
export async function importPunches(ctx: RequestContext, b: B) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.hr.manage');
  const { days, invalid } = groupPunches(b.punches);
  const codes = [...new Set(days.map((d) => d.workerCode))];
  const ws = (await pool.query(`SELECT id, code FROM textile_workers WHERE company_id=$1 AND code = ANY($2::text[])`, [ctx.companyId, codes])).rows;
  const byCode = new Map<string, string>(ws.map((w) => [w.code, w.id]));
  const unknown = codes.filter((c) => !byCode.has(c));
  const byDate = new Map<string, B[]>();
  const singles: string[] = [];
  for (const d of days) {
    const wid = byCode.get(d.workerCode); if (!wid) continue;
    if (d.singlePunch) singles.push(`${d.workerCode} ${d.date}`);
    const rec: B = { workerId: wid, status: 'present', checkIn: d.checkIn, ...(d.checkOut ? { checkOut: d.checkOut } : {}), ...(b.shiftStart ? { lateMinutes: lateMinutes(d.checkIn, b.shiftStart, b.graceMinutes ?? 0) } : {}) };
    (byDate.get(d.date) ?? byDate.set(d.date, []).get(d.date)!).push(rec);
  }
  let saved = 0;
  if (!b.dryRun) for (const [workDate, records] of byDate) { saved += (await saveAttendance(ctx, { workDate, records })).saved; }
  return { dryRun: !!b.dryRun, daysParsed: days.length, saved, unknownWorkers: unknown, invalidPunches: invalid, singlePunchDays: singles };
}

export async function leaveBalance(ctx: RequestContext, q: { year?: number }) {
  await assertManufacturingEnabled(ctx); ctx.assertPermission('textile.hr.view');
  const year = q.year ?? new Date().getUTCFullYear();
  const rows = (await pool.query(
    `SELECT w.id, w.code, w.name_ar, w.annual_leave_days, to_char(w.hire_date,'YYYY-MM-DD') AS hire_date,
            COUNT(a.id) FILTER (WHERE a.status='leave_paid')::int AS used, COUNT(a.id) FILTER (WHERE a.status='sick')::int AS sick, COUNT(a.id) FILTER (WHERE a.status='leave_unpaid')::int AS unpaid
     FROM textile_workers w LEFT JOIN attendance_records a ON a.worker_id=w.id AND a.company_id=w.company_id AND a.work_date BETWEEN $2 AND $3
     WHERE w.company_id=$1 AND w.is_active GROUP BY w.id ORDER BY w.code`, [ctx.companyId, `${year}-01-01`, `${year}-12-31`])).rows;
  return { year, workers: rows.map((r) => { const ent = leaveEntitlement(Number(r.annual_leave_days), r.hire_date, year); return { ...r, entitlement: ent, remaining: ent - r.used, overdrawn: r.used > ent }; }) };
}

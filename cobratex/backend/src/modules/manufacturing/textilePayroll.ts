/**
 * حساب راتب عامل لشهر — دالة صافية (بلا قاعدة بيانات).
 *  شهري : الأساسي = الراتب − (الراتب ÷ أيام العمل) × (غياب + إجازة بدون أجر)  [لا يقل عن صفر]
 *  يومي : الأساسي = اليومية × (حضور + إجازة مدفوعة + مرضي + عطلة رسمية)
 *  بالساعة: الأساسي = أجر الساعة × ساعات العمل الفعلية (بدون الإضافي)
 *  أجر الساعة المكافئ = شهري: الراتب ÷ أيام العمل ÷ ساعات اليوم | يومي: اليومية ÷ ساعات اليوم | ساعة: الأجر
 *  الإضافي = ساعات إضافية × أجر الساعة × المعامل | خصم التأخير = (دقائق ÷ 60) × أجر الساعة
 *  التأمين = نسبة % من الأساسي فقط (وحصة صاحب العمل % من الأساسي لا تُخصم من العامل) | الصافي = الإجمالي − التأمين − التأخير − السلف − الجزاءات − الخصومات
 */
export interface PayWorker { payType: 'monthly' | 'daily' | 'hourly'; baseRate: number; stdHoursPerDay: number; overtimeMultiplier: number; insurancePercent: number; employerInsurancePercent?: number }
export interface Attendance { present: number; leavePaid: number; sick: number; holiday: number; absent: number; leaveUnpaid: number; hours: number; overtimeHours: number; lateMinutes: number }
export interface Adjustments { advance: number; penalty: number; deduction: number; bonus: number; allowance: number }
export interface PayResult { daysPaid: number; daysAbsent: number; hoursWorked: number; overtimeHours: number; basePay: number; overtimePay: number; incentive: number; allowances: number; gross: number; insurance: number; employerInsurance: number; lateDeduction: number; advances: number; penalties: number; otherDeductions: number; net: number; negativeNet: boolean }

const c = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function hourlyEquivalent(w: PayWorker, workingDays: number): number {
  if (w.payType === 'hourly') return w.baseRate;
  if (w.payType === 'daily') return w.baseRate / w.stdHoursPerDay;
  return w.baseRate / workingDays / w.stdHoursPerDay;
}

export function computePay(w: PayWorker, workingDays: number, a: Attendance, incentive: number, adj: Adjustments): PayResult {
  if (!(workingDays >= 1)) throw new Error('أيام العمل يجب أن تكون 1 على الأقل');
  const paidDays = a.present + a.leavePaid + a.sick + a.holiday;
  const absentDays = a.absent + a.leaveUnpaid;
  let basePay: number;
  if (w.payType === 'monthly') basePay = Math.max(0, w.baseRate - (w.baseRate / workingDays) * absentDays);
  else if (w.payType === 'daily') basePay = w.baseRate * paidDays;
  else basePay = w.baseRate * Math.max(0, a.hours - a.overtimeHours);
  const hr = hourlyEquivalent(w, workingDays);
  const overtimePay = a.overtimeHours * hr * w.overtimeMultiplier;
  const lateDeduction = (a.lateMinutes / 60) * hr;
  const allowances = adj.allowance + adj.bonus;
  const gross = basePay + overtimePay + incentive + allowances;
  const insurance = (basePay * w.insurancePercent) / 100;
  const net = gross - insurance - lateDeduction - adj.advance - adj.penalty - adj.deduction;
  return {
    daysPaid: paidDays, daysAbsent: absentDays, hoursWorked: a.hours, overtimeHours: a.overtimeHours,
    basePay: c(basePay), overtimePay: c(overtimePay), incentive: c(incentive), allowances: c(allowances), gross: c(gross),
    insurance: c(insurance), employerInsurance: c((basePay * (w.employerInsurancePercent ?? 0)) / 100), lateDeduction: c(lateDeduction), advances: c(adj.advance), penalties: c(adj.penalty), otherDeductions: c(adj.deduction),
    net: c(net), negativeNet: net < 0,
  };
}

/** ساعات العمل من توقيتي الدخول والخروج HH:MM (يدعم عبور منتصف الليل للوردية الليلية). */
export function hoursBetween(inT: string, outT: string): number {
  const [h1, m1] = inT.split(':').map(Number); const [h2, m2] = outT.split(':').map(Number);
  let mins = h2 * 60 + m2 - (h1 * 60 + m1);
  if (mins <= 0) mins += 24 * 60;
  return c(mins / 60);
}

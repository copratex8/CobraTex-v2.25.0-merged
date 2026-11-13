/**
 * قيد كشف الرواتب (دالة صافية):
 *   مدين  أجور ومرتبات  = الإجمالي − (خصم التأخير + الجزاءات + الخصومات الأخرى)   [الجزاءات تخفّض مصروف الأجور]
 *   دائن  تأمينات اجتماعية مستحقة =  حصة العامل + حصة صاحب العمل (التي تُضاف أيضًا لمصروف الأجور)
 *   دائن  سلف العاملين = السلف المخصومة (استرداد سلف دُفعت سابقًا بمدين هذا الحساب)
 *   دائن  رواتب مستحقة = الصافي
 * التوازن: (G − L − P − D) = I + A + N لأن N = G − I − L − A − P − D. صافي إجمالي سالب يُنقل لجهة المدين.
 */
export interface PayrollTotals { gross: number; insurance: number; lateDeduction: number; advances: number; penalties: number; otherDeductions: number; net: number; employerInsurance?: number }
export interface EntryAmounts { wagesExpense: number; insurancePayable: number; advancesRecovered: number; salariesPayable: number }
const c = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function payrollEntryAmounts(t: PayrollTotals): EntryAmounts {
  const e = t.employerInsurance ?? 0;
  const wages = c(t.gross - t.lateDeduction - t.penalties - t.otherDeductions + e);
  const a = { wagesExpense: wages, insurancePayable: c(t.insurance + e), advancesRecovered: c(t.advances), salariesPayable: c(t.net) };
  const diff = c(a.wagesExpense - (a.insurancePayable + a.advancesRecovered + a.salariesPayable));
  if (Math.abs(diff) > 0.01) throw new Error(`كشف غير متسق: فرق ${diff} بين الأجور والاستحقاقات`);
  if (Math.abs(diff) > 0) a.salariesPayable = c(a.salariesPayable + diff); // فروق تقريب بالقرش فقط
  return a;
}

export interface Line { key: 'wages' | 'insurance' | 'advances' | 'payable'; debit: number; credit: number }
/** أسطر القيد؛ المبالغ السالبة تنتقل للجهة المقابلة، والأسطر الصفرية تُحذف. */
export function payrollEntryLines(a: EntryAmounts): Line[] {
  const mk = (key: Line['key'], v: number, normal: 'debit' | 'credit'): Line => {
    const abs = Math.abs(v); const flip = v < 0;
    const side = (normal === 'debit') !== flip ? 'debit' : 'credit';
    return { key, debit: side === 'debit' ? abs : 0, credit: side === 'credit' ? abs : 0 };
  };
  return [mk('wages', a.wagesExpense, 'debit'), mk('insurance', a.insurancePayable, 'credit'), mk('advances', a.advancesRecovered, 'credit'), mk('payable', a.salariesPayable, 'credit')].filter((l) => l.debit > 0 || l.credit > 0);
}

import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { classify } from '../src/modules/manufacturing/textileSalesLinkService';
import { simulateLine } from '../src/modules/manufacturing/textileSimulator';
import { computePay, hoursBetween } from '../src/modules/manufacturing/textilePayroll';
import { payrollEntryAmounts, payrollEntryLines } from '../src/modules/manufacturing/textilePayrollPosting';
import { allocate } from '../src/modules/manufacturing/textileUtilitiesService';
import { sumDefectPoints, DEFAULT_DEFECTS } from '../src/modules/manufacturing/textileDeliveryService';

const D = (n: number) => new Decimal(n);
const base = { ordered: D(100), invoiced: D(0), planned: D(100), produced: D(0), promised: '2026-11-30', lastEnd: '2026-11-10' };
const T = '2026-10-30';

describe('classify (متابعة البيع)', () => {
  it('delivered يغلب late', () => expect(classify({ ...base, invoiced: D(100), promised: '2026-10-01' }, T)).toBe('delivered'));
  it('late', () => expect(classify({ ...base, promised: '2026-10-01' }, T)).toBe('late'));
  it('ready', () => expect(classify({ ...base, produced: D(100) }, T)).toBe('ready'));
  it('at_risk عند تأخر الجدولة عن الوعد', () => expect(classify({ ...base, lastEnd: '2026-12-05' }, T)).toBe('at_risk'));
  it('short عند انتهاء كل الأوامر بعجز', () => expect(classify({ ...base, produced: D(98), openOrders: 0, ordersCount: 1 }, T)).toBe('short'));
  it('unplanned', () => expect(classify({ ...base, planned: D(40) }, T)).toBe('unplanned'));
  it('on_track', () => expect(classify(base, T)).toBe('on_track'));
});
describe('عيوب القماش', () => {
  it('sumDefectPoints', () => expect(sumDefectPoints([{ occurrences: 2, points: 4 }, { occurrences: 1, points: 1 }])).toBe(9));
  it('الكتالوج الافتراضي: نقاط 1..4 وأكواد فريدة', () => {
    expect(new Set(DEFAULT_DEFECTS.map((d) => d.code)).size).toBe(DEFAULT_DEFECTS.length);
    expect(DEFAULT_DEFECTS.every((d) => d.points >= 1 && d.points <= 4)).toBe(true);
  });
});
describe('توزيع المرافق', () => {
  it('المجموع يطابق الإجمالي تمامًا', () => { const r = allocate(100, [1, 1, 1])!; expect(Math.round(r.reduce((a, b) => a + b, 0) * 1e4)).toBe(1000000); });
  it('بالأوزان 3:1', () => expect(allocate(4000, [300, 100])).toEqual([3000, 1000]));
  it('أوزان صفرية → null', () => expect(allocate(100, [0, 0])).toBeNull());
});

describe('محاكي الاختناق', () => {
  const st = (name: string, rate: number, units: number, upf: number) => ({ name, ratePerHour: rate, units, efficiencyPercent: 100, hoursPerDay: 10, unitsPerFinal: upf });
  it('أضيق مرحلة تحدّد طاقة الخط', () => {
    const r = simulateLine([st('A', 100, 2, 1), st('B', 50, 1, 1), st('C', 400, 1, 2)], 300, 6000);
    expect(r.lineCapacityPerDay).toBe(500); expect(r.bottleneckStage).toBe('B'); expect(r.daysForDemand).toBe(12);
    expect(r.stages.find((x) => x.name === 'B')!.unitsNeededForTarget).toBe(1);
  });
  it('قيم غير صالحة', () => expect(() => simulateLine([st('X', 0, 1, 1)])).toThrow());
});
describe('حساب الراتب', () => {
  const A = (o = {}) => ({ present: 24, leavePaid: 0, sick: 0, holiday: 0, absent: 0, leaveUnpaid: 0, hours: 192, overtimeHours: 0, lateMinutes: 0, ...o });
  const J = (o = {}) => ({ advance: 0, penalty: 0, deduction: 0, bonus: 0, allowance: 0, ...o });
  it('شهري بغياب وإضافي وتأخير وتأمين وسلفة', () => {
    const r = computePay({ payType: 'monthly', baseRate: 6000, stdHoursPerDay: 8, overtimeMultiplier: 1.5, insurancePercent: 11 }, 25, A({ absent: 1, overtimeHours: 10, lateMinutes: 60 }), 500, J({ advance: 300, allowance: 200 }));
    expect(r.basePay).toBe(5760); expect(r.overtimePay).toBe(450); expect(r.insurance).toBe(633.6); expect(r.lateDeduction).toBe(30); expect(r.net).toBe(5946.4);
  });
  it('يومي', () => { const r = computePay({ payType: 'daily', baseRate: 200, stdHoursPerDay: 8, overtimeMultiplier: 1.5, insurancePercent: 0 }, 26, A({ present: 20, holiday: 1, absent: 2, overtimeHours: 4 }), 0, J()); expect(r.basePay).toBe(4200); expect(r.net).toBe(4350); });
  it('صافٍ سالب يُنبَّه', () => { const r = computePay({ payType: 'monthly', baseRate: 6000, stdHoursPerDay: 8, overtimeMultiplier: 1.5, insurancePercent: 0 }, 25, A({ absent: 30 }), 0, J({ penalty: 100 })); expect(r.basePay).toBe(0); expect(r.negativeNet).toBe(true); });
  it('ساعات عبر منتصف الليل', () => { expect(hoursBetween('08:00', '16:30')).toBe(8.5); expect(hoursBetween('22:00', '06:00')).toBe(8); });
});

describe('قيد الرواتب', () => {
  it('متوازن ويطابق الأرقام', () => {
    const a = payrollEntryAmounts({ gross: 6910, insurance: 633.6, lateDeduction: 30, advances: 300, penalties: 0, otherDeductions: 0, net: 5946.4 });
    expect(a).toEqual({ wagesExpense: 6880, insurancePayable: 633.6, advancesRecovered: 300, salariesPayable: 5946.4 });
    const L = payrollEntryLines(a);
    expect(L.reduce((s, l) => s + l.debit, 0)).toBeCloseTo(L.reduce((s, l) => s + l.credit, 0), 2);
  });
  it('كشف غير متسق يُرفض', () => expect(() => payrollEntryAmounts({ gross: 6910, insurance: 633.6, lateDeduction: 30, advances: 300, penalties: 0, otherDeductions: 0, net: 5000 })).toThrow());
  it('صافٍ سالب ينتقل للمدين', () => {
    const L = payrollEntryLines(payrollEntryAmounts({ gross: 100, insurance: 0, lateDeduction: 0, advances: 0, penalties: 150, otherDeductions: 0, net: -50 }));
    expect(L.find((l) => l.key === 'payable')!.debit).toBe(50);
  });
});

describe('تأمين صاحب العمل', () => {
  it('لا يؤثر على الصافي ويدخل القيد المتوازن', () => {
    const r = computePay({ payType: 'monthly', baseRate: 6000, stdHoursPerDay: 8, overtimeMultiplier: 1.5, insurancePercent: 11, employerInsurancePercent: 18.75 }, 25,
      { present: 24, leavePaid: 0, sick: 0, holiday: 0, absent: 1, leaveUnpaid: 0, hours: 192, overtimeHours: 10, lateMinutes: 60 }, 500, { advance: 300, penalty: 0, deduction: 0, bonus: 0, allowance: 200 });
    expect(r.net).toBe(5946.4); expect(r.employerInsurance).toBe(1080);
    const a = payrollEntryAmounts({ gross: r.gross, insurance: r.insurance, lateDeduction: r.lateDeduction, advances: r.advances, penalties: 0, otherDeductions: 0, net: r.net, employerInsurance: r.employerInsurance });
    expect(a.wagesExpense).toBe(7960); expect(a.insurancePayable).toBe(1713.6);
  });
});

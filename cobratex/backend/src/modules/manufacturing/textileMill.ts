import Decimal from 'decimal.js';
import { ValidationError } from '@/shared/errors';

/* دوال حسابية نقية (بلا قاعدة بيانات) لإضافات مصنع الغزل والنسيج: خلط الألياف، وصفات الصباغة، حساب التشغيل للغير،
 * معدّلات تكلفة التحويل، والوزن التجاري بالرطوبة. */

const D = (v: Decimal.Value) => new Decimal(v);
const r2 = (d: Decimal) => d.toDecimalPlaces(2).toFixed(2);
const r3 = (d: Decimal) => d.toDecimalPlaces(3).toFixed(3);
const r4 = (d: Decimal) => d.toDecimalPlaces(4).toFixed(4);

/* ============================== خلط الألياف ============================== */

export interface MixLine {
  percent: Decimal.Value;
  lotCode: string;
  netWeightKg: Decimal.Value;
  stapleLengthMm?: Decimal.Value | null; micronaire?: Decimal.Value | null; strengthGtex?: Decimal.Value | null;
  uniformityPercent?: Decimal.Value | null; shortFiberPercent?: Decimal.Value | null; trashPercent?: Decimal.Value | null;
  moisturePercent?: Decimal.Value | null; pricePerKg?: Decimal.Value | null;
}

export interface BlendResult {
  totalPercent: string;
  balanced: boolean;
  properties: Record<'stapleLengthMm' | 'micronaire' | 'strengthGtex' | 'uniformityPercent' | 'shortFiberPercent' | 'trashPercent' | 'moisturePercent', string | null>;
  /** أكبر كمية خلطة (كجم) تتيحها اللوطات المتاحة بهذه النسب — اللوط الأضيق يحدّدها. */
  maxMixKg: string | null;
  limitingLot: string | null;
  /** تكلفة كجم الخلطة (null إن نقص سعر أي لوط). */
  costPerKg: string | null;
  warnings: string[];
}

const PROPS = ['stapleLengthMm', 'micronaire', 'strengthGtex', 'uniformityPercent', 'shortFiberPercent', 'trashPercent', 'moisturePercent'] as const;

/** متوسط مرجَّح بالنسب لخصائص الألياف. الخاصية التي تغيب عن بعض اللوطات تُحسب على اللوطات المعروفة وتُعاد موازنة أوزانها. */
export function blendProperties(lines: MixLine[]): BlendResult {
  if (lines.length === 0) throw new ValidationError('خطة الخلط بلا لوطات');
  const total = lines.reduce((s, l) => s.plus(l.percent), D(0));
  const properties = {} as BlendResult['properties'];
  for (const p of PROPS) {
    const known = lines.filter((l) => l[p] !== null && l[p] !== undefined);
    const w = known.reduce((s, l) => s.plus(l.percent), D(0));
    properties[p] = known.length === 0 || w.isZero() ? null : r2(known.reduce((s, l) => s.plus(D(l[p] as Decimal.Value).times(l.percent)), D(0)).dividedBy(w));
  }
  let maxMix: Decimal | null = null; let limiting: string | null = null;
  for (const l of lines) {
    const cap = D(l.netWeightKg).dividedBy(D(l.percent).dividedBy(100));
    if (maxMix === null || cap.lessThan(maxMix)) { maxMix = cap; limiting = l.lotCode; }
  }
  const allPriced = lines.every((l) => l.pricePerKg !== null && l.pricePerKg !== undefined);
  const cost = allPriced ? r4(lines.reduce((s, l) => s.plus(D(l.pricePerKg as Decimal.Value).times(l.percent)), D(0)).dividedBy(100)) : null;

  const warnings: string[] = [];
  const nums = (p: 'stapleLengthMm' | 'micronaire') => lines.filter((l) => l[p] != null).map((l) => D(l[p] as Decimal.Value));
  const st = nums('stapleLengthMm'); const mic = nums('micronaire');
  if (st.length > 1 && Decimal.max(...st).minus(Decimal.min(...st)).greaterThan(3)) warnings.push('فرق طول التيلة بين اللوطات أكبر من 3 مم — راجع تجانس الخلطة');
  if (mic.length > 1 && Decimal.max(...mic).minus(Decimal.min(...mic)).greaterThan(0.5)) warnings.push('فرق الميكرونير بين اللوطات أكبر من 0.5 — قد يظهر تباين صباغة/نعومة');
  if (!total.equals(100)) warnings.push(`مجموع النسب ${total.toFixed(3)}% (يجب 100% للاعتماد)`);

  return { totalPercent: total.toFixed(3), balanced: total.equals(100), properties, maxMixKg: maxMix ? r3(maxMix) : null, limitingLot: limiting, costPerKg: cost, warnings };
}

/* ============================== الصباغة ============================== */

export type DyeBasis = 'percent_owf' | 'g_per_l' | 'kg_per_ton';
export interface DyeLine { itemId: string; amount: Decimal.Value; basis: DyeBasis }

/** كمية كل مادة (كجم) لدفعة وزنها materialKg. g_per_l تعتمد نسبة الحمّام: لترات المحلول = الوزن × liquorRatio. */
export function dyeRequirements(lines: DyeLine[], materialKg: Decimal.Value, liquorRatio: Decimal.Value | null | undefined) {
  const kg = D(materialKg);
  return lines.map((l) => {
    let qty: Decimal;
    if (l.basis === 'percent_owf') qty = kg.times(l.amount).dividedBy(100);
    else if (l.basis === 'kg_per_ton') qty = kg.times(l.amount).dividedBy(1000);
    else {
      if (liquorRatio === null || liquorRatio === undefined) throw new ValidationError('الوصفة تحتوي مادة بوحدة جم/لتر وتحتاج نسبة الحمّام (liquor ratio)');
      qty = kg.times(liquorRatio).times(l.amount).dividedBy(1000);
    }
    return { itemId: l.itemId, basis: l.basis, quantityKg: r3(qty) };
  });
}

/** حكم تلقائي مقترح لمطابقة اللون من ΔE (الحد الافتراضي 1.0 — يضبطه المصنع). */
export function shadeVerdict(deltaE: Decimal.Value, limit: Decimal.Value = 1): 'pass' | 'fail' {
  return D(deltaE).lessThanOrEqualTo(limit) ? 'pass' : 'fail';
}

/* ============================== التشغيل للغير ============================== */

export interface TollTotals { receipt: Decimal.Value; output: Decimal.Value; wasteReturned: Decimal.Value; wasteRetained: Decimal.Value; invoicedAmount: Decimal.Value }
export interface TollJobTerms { feePerUnit: Decimal.Value; feeBasis: 'output' | 'received'; allowedLossPercent: Decimal.Value; materialValuePerUnit: Decimal.Value }

/**
 * كشف حساب أعمال التشغيل للغير.
 * رصيد الخامة لدى المصنع = المستلم − الناتج المسلَّم − الهالك المُعاد − الهالك المحتجَز (حسب العقد).
 * عند الإقفال يُعدّ الرصيد المتبقي فاقدًا؛ الزائد عن المسموح (نسبة من المستلم) يُحمَّل على المصنع بقيمة الخامة.
 */
export function tollStatement(t: TollTotals, terms: TollJobTerms, closing: boolean) {
  const received = D(t.receipt);
  const held = received.minus(t.output).minus(t.wasteReturned).minus(t.wasteRetained);
  if (held.isNegative()) throw new ValidationError('إجمالي المُسلَّم والهالك يتجاوز الخامة المستلمة');
  const allowedQty = received.times(terms.allowedLossPercent).dividedBy(100);
  const lossPercent = received.isZero() ? D(0) : held.dividedBy(received).times(100);
  const excess = Decimal.max(D(0), held.minus(allowedQty));
  const feeBase = terms.feeBasis === 'output' ? D(t.output) : received;
  const feeEarned = feeBase.times(terms.feePerUnit);
  const compensation = closing ? excess.times(terms.materialValuePerUnit) : D(0);
  const feeDue = feeEarned.minus(t.invoicedAmount);
  return {
    received: r3(received), output: r3(D(t.output)), wasteReturned: r3(D(t.wasteReturned)), wasteRetained: r3(D(t.wasteRetained)),
    heldAtMill: r3(held), lossPercent: r3(lossPercent), allowedLossQty: r3(allowedQty), excessLossQty: r3(excess),
    feeEarned: r4(feeEarned), invoiced: r4(D(t.invoicedAmount)), feeDue: r4(feeDue),
    compensation: r4(compensation), netDue: r4(feeDue.minus(compensation)),
    note: closing ? 'بعد الإقفال: الرصيد المتبقي يُعدّ فاقدًا ويُحاسَب الزائد عن المسموح' : 'قبل الإقفال: الرصيد المتبقي ما زال قيد التشغيل لدى المصنع',
  };
}

/* ============================== معدّلات تكلفة التحويل ============================== */

export type RateType = 'labor_per_run_hour' | 'energy_per_kwh' | 'overhead_per_run_hour';
export interface Rate { rateType: RateType; rate: Decimal.Value; stageId: string | null; machineId: string | null }

/** الأخصّ يغلب: معدّل الماكينة ثم معدّل مرحلتها ثم العام. null إن لم يوجد. */
export function pickRate(rates: Rate[], type: RateType, machineId: string, stageId: string | null): Decimal | null {
  const of = rates.filter((r) => r.rateType === type);
  const m = of.find((r) => r.machineId === machineId);
  if (m) return D(m.rate);
  const s = stageId ? of.find((r) => !r.machineId && r.stageId === stageId) : undefined;
  if (s) return D(s.rate);
  const g = of.find((r) => !r.machineId && !r.stageId);
  return g ? D(g.rate) : null;
}

export interface LogForCost { machineId: string; stageId: string | null; runHours: Decimal.Value; energyKwh: Decimal.Value | null }

export function suggestConversion(logs: LogForCost[], rates: Rate[]) {
  let labor = D(0); let energy = D(0); let overhead = D(0); let runHours = D(0); let kwh = D(0);
  const missing = new Set<string>();
  for (const l of logs) {
    runHours = runHours.plus(l.runHours);
    const lr = pickRate(rates, 'labor_per_run_hour', l.machineId, l.stageId);
    const or = pickRate(rates, 'overhead_per_run_hour', l.machineId, l.stageId);
    labor = labor.plus(lr ? lr.times(l.runHours) : 0); if (!lr) missing.add('labor_per_run_hour');
    overhead = overhead.plus(or ? or.times(l.runHours) : 0); if (!or) missing.add('overhead_per_run_hour');
    if (l.energyKwh !== null) {
      kwh = kwh.plus(l.energyKwh);
      const er = pickRate(rates, 'energy_per_kwh', l.machineId, l.stageId);
      energy = energy.plus(er ? er.times(l.energyKwh) : 0); if (!er) missing.add('energy_per_kwh');
    }
  }
  return {
    runHours: r2(runHours), energyKwh: r3(kwh),
    labor: r4(labor), energy: r4(energy), overhead: r4(overhead), total: r4(labor.plus(energy).plus(overhead)),
    missingRates: [...missing],
  };
}

/* ============================== الوزن التجاري بالرطوبة ============================== */

/** نسب الاسترداد التجاري المرجعية % (ASTM D1909) — قيم افتراضية تُستبدل بما يقرّه عقد التوريد. */
export const STANDARD_REGAIN: Record<string, number> = { cotton: 8.5, wool: 13.6, viscose: 11, polyester: 0.4, nylon: 4.5, acrylic: 1.5 };

/**
 * الوزن التجاري = الوزن الجاف × (1 + الاسترداد القياسي).
 * الرطوبة المقاسة (على أساس الوزن الرطب) تُحوَّل لوزن جاف: جاف = فعلي × (1 − الرطوبة).
 */
export function commercialWeight(actualKg: Decimal.Value, moisturePercent: Decimal.Value, regainPercent: Decimal.Value) {
  const actual = D(actualKg);
  const m = D(moisturePercent);
  if (m.isNegative() || m.greaterThanOrEqualTo(100)) throw new ValidationError('الرطوبة بين 0 و100%');
  const dry = actual.times(D(100).minus(m)).dividedBy(100);
  const commercial = dry.times(D(100).plus(regainPercent)).dividedBy(100);
  return { actualKg: r3(actual), dryKg: r3(dry), commercialKg: r3(commercial), differenceKg: r3(commercial.minus(actual)), differencePercent: r3(commercial.minus(actual).dividedBy(actual).times(100)) };
}

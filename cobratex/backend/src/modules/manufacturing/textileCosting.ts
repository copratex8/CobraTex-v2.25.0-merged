import Decimal from 'decimal.js';
import { ValidationError } from '@/shared/errors';

/**
 * حساب تكلفة الهالك وتوزيعها — دوال نقية (بلا قاعدة بيانات) ليسهل اختبارها وتدقيقها محاسبيًا.
 *
 * المبدأ المحاسبي المتبع في المصانع:
 *   • الهالك العادي (حتى النسبة القياسية للمرحلة من وزن الخامة الرئيسية): جزء طبيعي من العملية، فتبقى تكلفته
 *     في تكلفة المنتج السليم (يرتفع سعر الكيلو لأن الناتج أقل من المُدخَل).
 *   • الهالك غير العادي (ما زاد عن القياسي): خسارة فترة تُحمَّل على الأرباح والخسائر (حساب 5040)، لا على المنتج.
 *   • الهالك القابل للاسترداد (يُباع/يُعاد تدويره): يدخل المخزن كصنف هالك بقيمة استرداده فيخفض تكلفة المنتج،
 *     وخسارة الهالك غير العادي = (تكلفة الخامة − قيمة الاسترداد) للكمية الزائدة فقط.
 *   • المخرجات المتعددة (درجة أولى/ثانية): توزَّع التكلفة المتبقية بالوزن النسبي (الكمية × وزن التكلفة).
 *
 * المعادلة المغلقة: مواد + تحويل = مخرجات + استردادات + خسارة غير عادية. القيد يتوازن دائمًا بهذه المساواة.
 */

export interface WasteEntryInput { quantity: Decimal.Value; recoveryUnitValue: Decimal.Value }
export interface OutputEntryInput { quantity: Decimal.Value; costWeight?: Decimal.Value }

export interface TextileCostingInput {
  materialsCost: Decimal.Value;
  conversionCost: Decimal.Value;
  /** كمية الخامة الرئيسية المستهلكة فعليًا (أساس نسبة الهالك). */
  mainConsumedQty: Decimal.Value;
  /** متوسط تكلفة وحدة الخامة الرئيسية وقت الاستهلاك. */
  mainUnitCost: Decimal.Value;
  /** نسبة الهالك القياسي للمرحلة (3 = 3%). */
  standardWastePercent: Decimal.Value;
  wastes: WasteEntryInput[];
  outputs: OutputEntryInput[];
}

export interface TextileCostingResult {
  totalWasteQty: string;
  allowedWasteQty: string;
  abnormalWasteQty: string;
  actualWastePercent: string;
  yieldPercent: string;
  recoveredValueTotal: string;
  abnormalLossTotal: string;
  outputsCost: string;
  wasteLines: Array<{ abnormalQuantity: string; recoveredValue: string; abnormalLoss: string }>;
  outputLines: Array<{ cost: string; unitCost: string; conversionPart: string; materialsPart: string }>;
}

const D = (v: Decimal.Value) => new Decimal(v);
const r4 = (d: Decimal) => d.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

export function computeTextileCosting(input: TextileCostingInput): TextileCostingResult {
  const materials = D(input.materialsCost);
  const conversion = D(input.conversionCost);
  const total = materials.plus(conversion);
  const mainQty = D(input.mainConsumedQty);
  const mainCost = D(input.mainUnitCost);
  if (mainQty.lessThanOrEqualTo(0)) throw new ValidationError('كمية الخامة الرئيسية المستهلكة يجب أن تكون أكبر من صفر');
  if (input.outputs.length === 0) throw new ValidationError('يجب تسجيل مخرَج واحد على الأقل');

  const wasteQtys = input.wastes.map((w) => D(w.quantity));
  const totalWaste = wasteQtys.reduce((a, b) => a.plus(b), D(0));
  const allowed = mainQty.times(D(input.standardWastePercent)).dividedBy(100);
  const abnormalTotal = Decimal.max(totalWaste.minus(allowed), 0);
  // حصة الهالك غير العادي موزَّعة على بنود الهالك بالتناسب مع كمياتها.
  const fraction = totalWaste.greaterThan(0) ? abnormalTotal.dividedBy(totalWaste) : D(0);

  let recoveredTotal = D(0);
  let abnormalLossTotal = D(0);
  const wasteLines = input.wastes.map((w, i) => {
    const q = wasteQtys[i];
    const v = D(w.recoveryUnitValue);
    const recovered = r4(q.times(v));
    const abnormalQty = r4(q.times(fraction));
    const lossPerUnit = Decimal.max(mainCost.minus(v), 0);
    const loss = r4(abnormalQty.times(lossPerUnit));
    recoveredTotal = recoveredTotal.plus(recovered);
    abnormalLossTotal = abnormalLossTotal.plus(loss);
    return { abnormalQuantity: abnormalQty.toFixed(4), recoveredValue: recovered.toFixed(4), abnormalLoss: loss.toFixed(4) };
  });

  const outputsCost = r4(total.minus(recoveredTotal).minus(abnormalLossTotal));
  if (outputsCost.lessThanOrEqualTo(0)) throw new ValidationError('تكلفة المخرجات بعد الهالك والاسترداد صفر أو سالبة — راجع الكميات وقيم الاسترداد');
  if (outputsCost.lessThan(conversion)) throw new ValidationError('قيمة الاسترداد والخسارة تتجاوز تكلفة المواد — راجع قيم الاسترداد');

  const weights = input.outputs.map((o) => D(o.quantity).times(D(o.costWeight ?? 1)));
  const weightSum = weights.reduce((a, b) => a.plus(b), D(0));
  let allocated = D(0);
  let convAllocated = D(0);
  const outputLines = input.outputs.map((o, i) => {
    const last = i === input.outputs.length - 1;
    const cost = last ? outputsCost.minus(allocated) : r4(outputsCost.times(weights[i]).dividedBy(weightSum));
    allocated = allocated.plus(cost);
    const conv = last ? conversion.minus(convAllocated) : r4(conversion.times(cost).dividedBy(outputsCost));
    convAllocated = convAllocated.plus(conv);
    return {
      cost: cost.toFixed(4), unitCost: r4(cost.dividedBy(D(o.quantity))).toFixed(4),
      conversionPart: conv.toFixed(4), materialsPart: cost.minus(conv).toFixed(4),
    };
  });

  const outQty = input.outputs.reduce((a, o) => a.plus(D(o.quantity)), D(0));
  return {
    totalWasteQty: totalWaste.toFixed(4), allowedWasteQty: r4(allowed).toFixed(4), abnormalWasteQty: r4(abnormalTotal).toFixed(4),
    actualWastePercent: r4(totalWaste.dividedBy(mainQty).times(100)).toFixed(4),
    yieldPercent: r4(outQty.dividedBy(mainQty).times(100)).toFixed(4),
    recoveredValueTotal: recoveredTotal.toFixed(4), abnormalLossTotal: abnormalLossTotal.toFixed(4),
    outputsCost: outputsCost.toFixed(4), wasteLines, outputLines,
  };
}

/* ============================== معادلات النسيج والغزل (مرجعية) ============================== */

const TEX_NE = 590.541; // Tex = 590.541 / Ne
const TEX_NM = 1000;    // Tex = 1000 / Nm
const TEX_DEN = 9;      // Tex = Denier / 9

export type CountSystem = 'Ne' | 'Nm' | 'Tex' | 'Denier';

export function toTex(value: number, system: CountSystem): number {
  if (!(value > 0)) throw new ValidationError('رقم الغزل يجب أن يكون أكبر من صفر');
  switch (system) {
    case 'Ne': return TEX_NE / value;
    case 'Nm': return TEX_NM / value;
    case 'Tex': return value;
    case 'Denier': return value / TEX_DEN;
  }
}

export function convertCount(value: number, from: CountSystem): Record<CountSystem, number> {
  const tex = toTex(value, from);
  return { Ne: TEX_NE / tex, Nm: TEX_NM / tex, Tex: tex, Denier: tex * TEX_DEN };
}

export interface FabricEstimateInput {
  epi: number; ppi: number; widthCm: number;
  warpCountNe: number; weftCountNe: number;
  warpCrimpPercent?: number; weftCrimpPercent?: number;
  sizePickupPercent?: number;
}

/** تقدير وزن القماش المنسوج ومتطلبات الخيوط لكل متر طولي. */
export function estimateFabric(i: FabricEstimateInput) {
  const widthM = i.widthCm / 100;
  const endsAcross = i.epi * 39.3701 * widthM;      // عدد خيوط السدى عبر العرض
  const picksPerM = i.ppi * 39.3701;                 // عدد اللحمات في المتر الطولي
  const warpTex = toTex(i.warpCountNe, 'Ne');
  const weftTex = toTex(i.weftCountNe, 'Ne');
  const warpG = (endsAcross * (1 + (i.warpCrimpPercent ?? 0) / 100) * warpTex) / 1000;   // غرام سدى لكل متر قماش
  const weftG = (picksPerM * widthM * (1 + (i.weftCrimpPercent ?? 0) / 100) * weftTex) / 1000;
  const greyG = warpG + weftG;
  const sizedG = warpG * (1 + (i.sizePickupPercent ?? 0) / 100) + weftG;
  return {
    totalEnds: Math.round(endsAcross),
    warpGramsPerMeter: round(warpG), weftGramsPerMeter: round(weftG),
    greyGramsPerMeter: round(greyG), greyGsm: round(greyG / widthM),
    sizedGsm: round(sizedG / widthM),
    warpSharePercent: round((warpG / greyG) * 100),
  };
}

/** الإنتاج النظري للمغزل (كجم لكل مغزل في الساعة) = (لفة/د × 60 × كفاءة) ÷ (TPI × 36 × 840 × Ne) × 0.4536. */
export function spindleKgPerHour(rpm: number, tpi: number, ne: number, efficiencyPercent = 100): number {
  if (!(rpm > 0 && tpi > 0 && ne > 0)) throw new ValidationError('القيم يجب أن تكون أكبر من صفر');
  const lbPerHour = (rpm * 60 * (efficiencyPercent / 100)) / (tpi * 36 * 840 * ne);
  return lbPerHour * 0.45359237;
}

/** نظام 4 نقاط: نقاط العيوب لكل 100 ياردة مربعة. الدرجة: A حتى 20، B حتى 40، وإلا C (ثوابت مرجعية قابلة للتعديل). */
export function fourPointGrade(totalPoints: number, lengthM: number, widthCm: number): { pointsPer100SqYd: number; grade: 'A' | 'B' | 'C' } {
  if (!(lengthM > 0 && widthCm > 0)) throw new ValidationError('الطول والعرض يجب أن يكونا أكبر من صفر');
  const lengthYd = lengthM / 0.9144;
  const widthIn = widthCm / 2.54;
  const p = (totalPoints * 3600) / (lengthYd * widthIn);
  return { pointsPer100SqYd: round(p), grade: p <= 20 ? 'A' : p <= 40 ? 'B' : 'C' };
}

/** إنتاج النول بالمتر/ساعة = (دورة/د × 60 ÷ (ppi × 39.3701)) × الكفاءة. كل دورة = لحمة واحدة. */
export function loomMetersPerHour(rpm: number, ppi: number, efficiencyPercent = 100): number {
  if (!(rpm > 0 && ppi > 0)) throw new ValidationError('القيم يجب أن تكون أكبر من صفر');
  return (rpm * 60 * (efficiencyPercent / 100)) / (ppi * 39.3701);
}

/** معامل البرم TM = TPI ÷ √Ne (للنظام الإنجليزي). قطن سداء عادةً 3.8–4.2، لحمة 3.2–3.6 — مرجع للضبط لا حد قبول. */
export function twistMultiplier(tpi: number, ne: number): number {
  if (!(tpi > 0 && ne > 0)) throw new ValidationError('القيم يجب أن تكون أكبر من صفر');
  return round(tpi / Math.sqrt(ne));
}

function round(n: number): number { return Math.round(n * 100) / 100; }

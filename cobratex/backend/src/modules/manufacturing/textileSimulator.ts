/**
 * محاكي طاقة الخط المتسلسل (Bottleneck): دالة صافية بلا قاعدة بيانات.
 * كل مرحلة: طاقتها بوحدتها الخاصة/ساعة، وعدد الوحدات (ماكينات)، والكفاءة %، وساعات التشغيل/يوم،
 * و setupHoursPerDay (زمن التجهيز/التغيير يوميًا يُطرح من ساعات التشغيل) و breakdownPercent (نسبة الأعطال من الوقت المتبقي)، و unitsPerFinal = كم وحدة من ناتج هذه المرحلة تلزم لكل وحدة نهائية (يشمل الهالك: مثال غزل 1.15 كجم لكل 1 م قماش).
 */
export interface SimStage { name: string; ratePerHour: number; units: number; efficiencyPercent: number; hoursPerDay: number; unitsPerFinal: number; setupHoursPerDay?: number; breakdownPercent?: number }
export interface SimStageResult extends SimStage { finalPerDay: number; utilizationPercent: number; isBottleneck: boolean; unitsNeededForTarget: number | null }

export function simulateLine(stages: SimStage[], targetFinalPerDay?: number, demandQty?: number) {
  if (!stages.length) throw new Error('أضف مرحلة واحدة على الأقل');
  for (const s of stages) {
    if (!(s.ratePerHour > 0 && s.units > 0 && s.hoursPerDay > 0 && s.unitsPerFinal > 0) || s.efficiencyPercent <= 0 || s.efficiencyPercent > 100 || s.hoursPerDay > 24 || (s.setupHoursPerDay ?? 0) < 0 || (s.setupHoursPerDay ?? 0) >= s.hoursPerDay || (s.breakdownPercent ?? 0) < 0 || (s.breakdownPercent ?? 0) >= 100)
      throw new Error(`قيم غير صالحة في المرحلة "${s.name}"`);
  }
  const perDay = stages.map((s) => (s.ratePerHour * s.units * (s.efficiencyPercent / 100) * effHours(s)) / s.unitsPerFinal);
  const lineCapacity = Math.min(...perDay);
  const bi = perDay.indexOf(lineCapacity);
  const results: SimStageResult[] = stages.map((s, i) => {
    const oneUnitPerDay = perDay[i] / s.units; // نهائي/يوم لكل وحدة ماكينة
    const needed = targetFinalPerDay ? Math.ceil(targetFinalPerDay / oneUnitPerDay - 1e-9) : null;
    return { ...s, finalPerDay: round(perDay[i]), utilizationPercent: round((lineCapacity / perDay[i]) * 100), isBottleneck: i === bi, unitsNeededForTarget: needed };
  });
  // أثر رفع الاختناق: السعة بعد تحسين المرحلة الأضيق بوحدة إضافية (يظهر الاختناق التالي)
  const lifted = perDay.slice(); lifted[bi] = perDay[bi] + perDay[bi] / stages[bi].units;
  const nextBi = lifted.indexOf(Math.min(...lifted));
  return {
    lineCapacityPerDay: round(lineCapacity), bottleneckStage: stages[bi].name,
    stages: results,
    withOneMoreUnit: { capacityPerDay: round(Math.min(...lifted)), gainPercent: round((Math.min(...lifted) / lineCapacity - 1) * 100), nextBottleneck: stages[nextBi].name },
    daysForDemand: demandQty ? round(demandQty / lineCapacity) : null,
    target: targetFinalPerDay ? { perDay: targetFinalPerDay, met: lineCapacity >= targetFinalPerDay, shortfallPerDay: round(Math.max(0, targetFinalPerDay - lineCapacity)) } : null,
  };
}
const effHours = (s: SimStage) => (s.hoursPerDay - (s.setupHoursPerDay ?? 0)) * (1 - (s.breakdownPercent ?? 0) / 100);
const round = (n: number) => Math.round(n * 100) / 100;

import Decimal from 'decimal.js';
import { ValidationError } from '@/shared/errors';

/**
 * تخطيط احتياجات المواد (MRP) متعدد المستويات — دوال نقية بلا قاعدة بيانات.
 * المنطق (كـ Odoo "Replenishment" لكن مبسّط): نبدأ بالأصناف المطلوب إنتاجها، ونفكّك كل منها حسب وصفته مع
 * نسبة الهالك لكل مكوّن. لكل مكوّن: نخصم المتاح بالمخزن أولًا (يُستهلك مرة واحدة عبر كل الفروع الشجرية)؛
 * والباقي إن كان له وصفة نشطة → يُصنَّع (ويُفكَّك بدوره)، وإلا → يُشترى.
 */

export interface MrpBomLine { componentItemId: string; quantity: Decimal.Value; wastePercent?: Decimal.Value }
export interface MrpBom { outputQuantity: Decimal.Value; lines: MrpBomLine[] }
export interface MrpRow { itemId: string; level: number; gross: string; fromStock: string; toProduce: string; toPurchase: string }

const D = (v: Decimal.Value) => new Decimal(v);
const MAX_DEPTH = 10;

export function planMaterials(
  targets: Array<{ itemId: string; quantity: Decimal.Value }>,
  boms: Map<string, MrpBom>,
  onHand: Map<string, Decimal.Value>,
): MrpRow[] {
  const avail = new Map<string, Decimal>([...onHand].map(([k, v]) => [k, Decimal.max(D(v), 0)]));
  const acc = new Map<string, { level: number; gross: Decimal; stock: Decimal; produce: Decimal; purchase: Decimal }>();
  const rec = (id: string, level: number) => {
    let r = acc.get(id);
    if (!r) { r = { level, gross: D(0), stock: D(0), produce: D(0), purchase: D(0) }; acc.set(id, r); }
    r.level = Math.max(r.level, level);
    return r;
  };

  function produce(itemId: string, qty: Decimal, level: number, path: string[], countGross: boolean) {
    if (level > MAX_DEPTH) throw new ValidationError('عمق الوصفات يتجاوز الحد المسموح — راجع الوصفات المتداخلة');
    if (path.includes(itemId)) throw new ValidationError('وصفات دائرية: صنف يدخل في تصنيع نفسه');
    const bom = boms.get(itemId);
    if (!bom) throw new ValidationError('لا توجد وصفة نشطة للصنف المطلوب إنتاجه');
    const out = D(bom.outputQuantity);
    if (out.lessThanOrEqualTo(0)) throw new ValidationError('كمية إخراج الوصفة غير صالحة');
    const r = rec(itemId, level);
    if (countGross) r.gross = r.gross.plus(qty); // المكوّنات يُحتسب إجماليها في require_ قبل خصم المخزون
    r.produce = r.produce.plus(qty);
    for (const l of bom.lines) {
      const need = qty.dividedBy(out).times(D(l.quantity)).times(D(1).plus(D(l.wastePercent ?? 0).dividedBy(100)));
      require_(l.componentItemId, need, level + 1, [...path, itemId]);
    }
  }
  function require_(itemId: string, qty: Decimal, level: number, path: string[]) {
    const r = rec(itemId, level);
    r.gross = r.gross.plus(qty);
    const have = avail.get(itemId) ?? D(0);
    const take = Decimal.min(have, qty);
    avail.set(itemId, have.minus(take));
    r.stock = r.stock.plus(take);
    const net = qty.minus(take);
    if (net.lessThanOrEqualTo(0)) return;
    if (boms.has(itemId)) produce(itemId, net, level, path, false);
    else r.purchase = r.purchase.plus(net);
  }

  targets.forEach((t, i) => {
    if (D(t.quantity).lessThanOrEqualTo(0)) throw new ValidationError(`الكمية المطلوبة للسطر ${i + 1} يجب أن تكون أكبر من صفر`);
    produce(t.itemId, D(t.quantity), 0, [], true);
  });

  const f = (d: Decimal) => d.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
  return [...acc.entries()]
    .map(([itemId, r]) => ({ itemId, level: r.level, gross: f(r.gross), fromStock: f(r.stock), toProduce: f(r.produce), toPurchase: f(r.purchase) }))
    .sort((a, b) => a.level - b.level || a.itemId.localeCompare(b.itemId));
}

/** OEE = الإتاحة × الأداء × الجودة (كلها نسب 0..1). الأداء يُقيَّد بـ 1 كي لا تُضخِّم قراءة طاقة اسمية متحفظة النتيجة. */
export function computeOee(runHours: Decimal.Value, downtimeHours: Decimal.Value, output: Decimal.Value, theoreticalOutput: Decimal.Value, waste: Decimal.Value) {
  const run = D(runHours); const total = run.plus(D(downtimeHours));
  const availability = total.greaterThan(0) ? run.dividedBy(total) : null;
  const performance = D(theoreticalOutput).greaterThan(0) ? Decimal.min(D(output).dividedBy(D(theoreticalOutput)), 1) : null;
  const good = D(output).plus(D(waste));
  const quality = good.greaterThan(0) ? D(output).dividedBy(good) : null;
  const oee = availability && performance && quality ? availability.times(performance).times(quality) : null;
  const pct = (x: Decimal | null) => (x ? x.times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null);
  return { availability: pct(availability), performance: pct(performance), quality: pct(quality), oee: pct(oee) };
}

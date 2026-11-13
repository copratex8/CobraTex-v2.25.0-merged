import { describe, it, expect } from 'vitest';
import { pool } from '@/db/pool';
import {
  recordInMovement,
  recordOutMovement,
  getStockBalance,
  rebuildStockBalanceFromLedger,
} from '@/modules/inventory/stockService';
import { createFullTenantStack, createBaseItem } from './helpers';

describe('دفتر المخزون الدائم (Append-Only) وتقييم المتوسط المرجح (Weighted Average)', () => {
  it('يحسب المتوسط المرجح بعد وارد بتكلفتين مختلفتين، وتكلفة الصرف = الكمية × المتوسط', async () => {
    const stack = await createFullTenantStack('val-wavg');
    const { itemId } = await createBaseItem(stack.companyId);

    // وارد 1: 60 وحدة بتكلفة 10 → إجمالي 600
    await recordInMovement(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, itemId,
      quantity: '60', unitCost: '10', movementDate: '2026-01-01', sourceDocumentType: 'test',
    });
    // وارد 2: 40 وحدة بتكلفة 15 → إجمالي 600؛ المتوسط الجديد = (600+600)/100 = 12.0000 بالضبط
    const secondIn = await recordInMovement(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, itemId,
      quantity: '40', unitCost: '15', movementDate: '2026-01-02', sourceDocumentType: 'test',
    });
    expect(secondIn.newWeightedAverageCost).toBe('12.0000');

    // صرف 70 وحدة بالمتوسط 12 → تكلفة = 840.0000 بالضبط
    const out = await recordOutMovement(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, itemId,
      quantity: '70', movementDate: '2026-01-03', sourceDocumentType: 'test',
    });
    expect(out.costOfGoodsConsumed).toBe('840.0000');

    const balanceAfterOut = await getStockBalance(stack.ctx, stack.warehouseId, itemId);
    expect(balanceAfterOut.quantity_on_hand).toBe('30.0000'); // 100 - 70
    expect(balanceAfterOut.weighted_average_cost).toBe('12.0000'); // الصرف لا يغيّر المتوسط

    // وارد 3: 30 وحدة بتكلفة 18 → المتوسط الجديد = (30×12 + 30×18)/60 = 15.0000 بالضبط
    const thirdIn = await recordInMovement(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, itemId,
      quantity: '30', unitCost: '18', movementDate: '2026-01-04', sourceDocumentType: 'test',
    });
    expect(thirdIn.newWeightedAverageCost).toBe('15.0000');
  });

  it('يرفض الصرف إذا تجاوزت الكمية المطلوبة الرصيد المتاح (لا رصيد سالب بلا تفويض)', async () => {
    const stack = await createFullTenantStack('val-neg');
    const { itemId } = await createBaseItem(stack.companyId);
    await recordInMovement(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, itemId,
      quantity: '10', unitCost: '5', movementDate: '2026-01-01', sourceDocumentType: 'test',
    });

    await expect(
      recordOutMovement(stack.ctx, {
        branchId: stack.branchId, warehouseId: stack.warehouseId, itemId,
        quantity: '999', movementDate: '2026-01-02', sourceDocumentType: 'test',
      }),
    ).rejects.toThrow(/الكمية المتاحة غير كافية/);
  });

  it('StockBalance قابل لإعادة البناء الكامل من دفتر الحركات الخام (إعادة تشغيل المتوسط المرجح من الصفر) ويطابق القيمة المحفوظة', async () => {
    const stack = await createFullTenantStack('val-rebuild');
    const { itemId } = await createBaseItem(stack.companyId);
    await recordInMovement(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, itemId,
      quantity: '40', unitCost: '8', movementDate: '2026-01-01', sourceDocumentType: 'test',
    });
    await recordOutMovement(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, itemId,
      quantity: '15', movementDate: '2026-01-02', sourceDocumentType: 'test',
    });

    const beforeRebuild = await getStockBalance(stack.ctx, stack.warehouseId, itemId);

    // نُفسد الكاش عمدًا لإثبات أن rebuild لا يعتمد عليه إطلاقًا، بل يُعيد حسابه من الصفر بإعادة تشغيل الحركات
    await pool.query(
      `UPDATE stock_balances SET quantity_on_hand = '99999.0000', weighted_average_cost='0.0001' WHERE company_id=$1 AND warehouse_id=$2 AND item_id=$3`,
      [stack.companyId, stack.warehouseId, itemId],
    );
    const corrupted = await getStockBalance(stack.ctx, stack.warehouseId, itemId);
    expect(corrupted.quantity_on_hand).toBe('99999.0000');

    const rebuilt = await rebuildStockBalanceFromLedger(stack.ctx, stack.warehouseId, itemId);
    expect(rebuilt.quantityOnHand).toBe(beforeRebuild.quantity_on_hand);
    expect(rebuilt.weightedAverageCost).toBe(beforeRebuild.weighted_average_cost);
    expect(rebuilt.quantityOnHand).toBe('25.0000');
    expect(rebuilt.weightedAverageCost).toBe('8.0000');
  });

  it('دفتر الحركات append-only حقًا: لا يمكن UPDATE أو DELETE مباشرة عبر SQL', async () => {
    const stack = await createFullTenantStack('val-immutable');
    const { itemId } = await createBaseItem(stack.companyId);
    const movement = await recordInMovement(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, itemId,
      quantity: '5', unitCost: '3', movementDate: '2026-01-01', sourceDocumentType: 'test',
    });

    const movementRow = await pool.query(`SELECT id FROM stock_movements WHERE company_id=$1 AND item_id=$2 LIMIT 1`, [stack.companyId, itemId]);
    const movementId = movementRow.rows[0].id;
    expect(movement.movementId).toBe(movementId);

    await expect(
      pool.query(`UPDATE stock_movements SET quantity = '999' WHERE id = $1`, [movementId]),
    ).rejects.toThrow(/append-only/);

    await expect(
      pool.query(`DELETE FROM stock_movements WHERE id = $1`, [movementId]),
    ).rejects.toThrow(/append-only/);
  });
});

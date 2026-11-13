import { PoolClient } from 'pg';
import Decimal from 'decimal.js';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { assertWarehouseScope } from '@/shared/scope';

const IN_TYPES = new Set(['opening', 'in', 'transfer_in', 'adjustment_in']);
const OUT_TYPES = new Set(['out', 'transfer_out', 'adjustment_out', 'loss']);

export interface RecordInMovementInput {
  branchId: string;
  warehouseId: string;
  itemId: string;
  batchId?: string;
  quantity: string;
  unitCost: string;
  movementDate: string;
  effectiveDate?: string;
  movementType?: 'opening' | 'in' | 'transfer_in' | 'adjustment_in' | 'production_output' | 'production_consume';
  sourceDocumentType: string;
  sourceDocumentId?: string;
  activityId?: string;
  projectId?: string;
}

/**
 * حركة وارد — طريقة المتوسط المرجح (Weighted Average، القرار الرسمي في REQUIREMENTS.md §7):
 * المتوسط الجديد = (الكمية القديمة × متوسطها + الكمية الواردة × تكلفتها) ÷ (الكمية القديمة + الواردة).
 * يقفل صف stock_balances (أو ينشئه) ضمن نفس المعاملة لمنع تعارض تزامن مع حركة أخرى على نفس الصنف/المخزن.
 */
export async function recordInMovement(ctx: RequestContext, input: RecordInMovementInput) {
  ctx.assertPermission('inventory.movement.post', input.branchId);
  const quantity = new Decimal(input.quantity);
  const unitCost = new Decimal(input.unitCost);
  if (quantity.lessThanOrEqualTo(0)) throw new ValidationError('الكمية يجب أن تكون موجبة');
  if (unitCost.isNegative()) throw new ValidationError('تكلفة الوحدة لا يمكن أن تكون سالبة');

  return withTransaction(async (client) => {
    const { quantityOnHand, weightedAverageCost, balanceRowId } = await lockOrCreateBalance(
      client, ctx.companyId, input.warehouseId, input.itemId, input.batchId ?? null,
    );

    const newQty = quantityOnHand.plus(quantity);
    const newAvg = quantityOnHand.times(weightedAverageCost).plus(quantity.times(unitCost)).dividedBy(newQty);

    const movement = await client.query(
      `INSERT INTO stock_movements(
        company_id, branch_id, warehouse_id, item_id, batch_id, movement_type, quantity, unit_cost,
        movement_date, effective_date, source_document_type, source_document_id, created_by, activity_id, project_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING id`,
      [
        ctx.companyId, input.branchId, input.warehouseId, input.itemId, input.batchId ?? null,
        input.movementType ?? 'in', quantity.toFixed(4), unitCost.toFixed(4),
        input.movementDate, input.effectiveDate ?? input.movementDate,
        input.sourceDocumentType, input.sourceDocumentId ?? null, ctx.userId,
        input.activityId ?? null, input.projectId ?? null,
      ],
    );
    const movementId = movement.rows[0].id;

    await client.query(
      `UPDATE stock_balances SET quantity_on_hand=$1, weighted_average_cost=$2, last_recalculated_at=now() WHERE id=$3`,
      [newQty.toFixed(4), newAvg.toFixed(4), balanceRowId],
    );

    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'stock_movement', entityId: movementId, action: 'create',
      afterJson: { movementType: input.movementType ?? 'in', quantity: quantity.toFixed(4), unitCost: unitCost.toFixed(4) },
    });

    return { movementId, newWeightedAverageCost: newAvg.toFixed(4) };
  });
}

export interface RecordOutMovementInput {
  branchId: string;
  warehouseId: string;
  itemId: string;
  batchId?: string;
  quantity: string;
  movementDate: string;
  effectiveDate?: string;
  movementType?: 'out' | 'transfer_out' | 'adjustment_out' | 'loss' | 'production_consume' | 'production_output';
  sourceDocumentType: string;
  sourceDocumentId?: string;
  activityId?: string;
  projectId?: string;
}

/**
 * حركة صرف — التكلفة = الكمية المصروفة × متوسط التكلفة الحالي وقت الصرف (لا يتغير المتوسط بالصرف،
 * فقط بالوارد). تُسجَّل قيمة المتوسط المستخدمة على الحركة نفسها (unit_cost) للتدقيق التاريخي.
 */
export async function recordOutMovement(ctx: RequestContext, input: RecordOutMovementInput) {
  ctx.assertPermission('inventory.movement.post', input.branchId);
  const requestedQty = new Decimal(input.quantity);
  if (requestedQty.lessThanOrEqualTo(0)) throw new ValidationError('الكمية يجب أن تكون موجبة');

  return withTransaction(async (client) => {
    const { quantityOnHand, weightedAverageCost, balanceRowId } = await lockOrCreateBalance(
      client, ctx.companyId, input.warehouseId, input.itemId, input.batchId ?? null,
    );

    if (quantityOnHand.lessThan(requestedQty)) {
      throw new ValidationError(
        `الكمية المتاحة غير كافية: المطلوب ${requestedQty.toFixed(4)} والمتاح ${quantityOnHand.toFixed(4)}`,
      );
    }

    const costOfGoods = requestedQty.times(weightedAverageCost);

    const movement = await client.query(
      `INSERT INTO stock_movements(
        company_id, branch_id, warehouse_id, item_id, batch_id, movement_type, quantity, unit_cost,
        movement_date, effective_date, source_document_type, source_document_id, created_by, activity_id, project_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING id`,
      [
        ctx.companyId, input.branchId, input.warehouseId, input.itemId, input.batchId ?? null,
        input.movementType ?? 'out', requestedQty.toFixed(4), weightedAverageCost.toFixed(4),
        input.movementDate, input.effectiveDate ?? input.movementDate,
        input.sourceDocumentType, input.sourceDocumentId ?? null, ctx.userId,
        input.activityId ?? null, input.projectId ?? null,
      ],
    );
    const movementId = movement.rows[0].id;

    const newQty = quantityOnHand.minus(requestedQty);
    await client.query(
      `UPDATE stock_balances SET quantity_on_hand=$1, last_recalculated_at=now() WHERE id=$2`,
      [newQty.toFixed(4), balanceRowId],
    );

    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'stock_movement', entityId: movementId, action: 'create',
      afterJson: { movementType: input.movementType ?? 'out', quantity: requestedQty.toFixed(4), costOfGoods: costOfGoods.toFixed(4) },
    });

    return { movementId, costOfGoodsConsumed: costOfGoods.toFixed(4) };
  });
}

async function lockOrCreateBalance(
  client: PoolClient, companyId: string, warehouseId: string, itemId: string, batchId: string | null,
) {
  const where = batchId ? 'batch_id = $4' : 'batch_id IS NULL';
  const params = batchId ? [companyId, warehouseId, itemId, batchId] : [companyId, warehouseId, itemId];
  const existing = await client.query(
    `SELECT id, quantity_on_hand, weighted_average_cost FROM stock_balances
     WHERE company_id=$1 AND warehouse_id=$2 AND item_id=$3 AND ${where}
     FOR UPDATE`,
    params,
  );
  if (existing.rows.length > 0) {
    return {
      balanceRowId: existing.rows[0].id,
      quantityOnHand: new Decimal(existing.rows[0].quantity_on_hand),
      weightedAverageCost: new Decimal(existing.rows[0].weighted_average_cost),
    };
  }
  const inserted = await client.query(
    `INSERT INTO stock_balances(company_id, warehouse_id, item_id, batch_id, quantity_on_hand, weighted_average_cost)
     VALUES ($1,$2,$3,$4,0,0) RETURNING id`,
    [companyId, warehouseId, itemId, batchId],
  );
  return { balanceRowId: inserted.rows[0].id, quantityOnHand: new Decimal(0), weightedAverageCost: new Decimal(0) };
}

/**
 * إعادة بناء الرصيد بالكامل من الصفر بإعادة تشغيل (replay) كل الحركات المرحّلة بترتيبها الزمني،
 * محتسبًا المتوسط المرجح تراكميًا — دون أي اعتماد على قيمة stock_balances الحالية إطلاقًا.
 * يثبت أن الكاش قابل للاشتقاق الكامل من الدفتر الخام append-only.
 */
export async function rebuildStockBalanceFromLedger(
  ctx: RequestContext,
  warehouseId: string,
  itemId: string,
  batchId: string | null = null,
) {
  ctx.assertPermission('inventory.balance.rebuild'); // فحص على مستوى الشركة فقط في هذه المرحلة (بلا فرع)
  return withTransaction(async (client) => {
    const where = batchId ? 'batch_id = $4' : 'batch_id IS NULL';
    const params = batchId
      ? [ctx.companyId, warehouseId, itemId, batchId]
      : [ctx.companyId, warehouseId, itemId];
    const movements = await client.query(
      `SELECT movement_type, quantity, unit_cost FROM stock_movements
       WHERE company_id=$1 AND warehouse_id=$2 AND item_id=$3 AND ${where} AND status='posted'
       ORDER BY effective_date ASC, created_at ASC, id ASC`,
      params,
    );

    let qty = new Decimal(0);
    let avg = new Decimal(0);
    for (const m of movements.rows) {
      const mQty = new Decimal(m.quantity);
      const mCost = new Decimal(m.unit_cost);
      if (IN_TYPES.has(m.movement_type)) {
        const newQty = qty.plus(mQty);
        avg = newQty.greaterThan(0) ? qty.times(avg).plus(mQty.times(mCost)).dividedBy(newQty) : new Decimal(0);
        qty = newQty;
      } else if (OUT_TYPES.has(m.movement_type)) {
        qty = qty.minus(mQty);
      }
    }

    const existing = await client.query(
      `SELECT id FROM stock_balances WHERE company_id=$1 AND warehouse_id=$2 AND item_id=$3 AND ${where}`,
      params,
    );
    if (existing.rows.length === 0) {
      await client.query(
        `INSERT INTO stock_balances(company_id, warehouse_id, item_id, batch_id, quantity_on_hand, weighted_average_cost, last_recalculated_at)
         VALUES ($1,$2,$3,$4,$5,$6, now())`,
        [ctx.companyId, warehouseId, itemId, batchId, qty.toFixed(4), avg.toFixed(4)],
      );
    } else {
      await client.query(
        `UPDATE stock_balances SET quantity_on_hand=$1, weighted_average_cost=$2, last_recalculated_at=now() WHERE id=$3`,
        [qty.toFixed(4), avg.toFixed(4), existing.rows[0].id],
      );
    }

    return { quantityOnHand: qty.toFixed(4), weightedAverageCost: avg.toFixed(4) };
  });
}

export async function getStockBalance(
  ctx: RequestContext,
  warehouseId: string,
  itemId: string,
  batchId: string | null = null,
) {
  ctx.assertPermission('inventory.balance.view');
  await assertWarehouseScope(ctx, warehouseId);
  const batchCondition = batchId ? 'batch_id = $4' : 'batch_id IS NULL';
  const { rows } = await pool.query(
    `SELECT * FROM stock_balances WHERE company_id=$1 AND warehouse_id=$2 AND item_id=$3 AND ${batchCondition}`,
    batchId ? [ctx.companyId, warehouseId, itemId, batchId] : [ctx.companyId, warehouseId, itemId],
  );
  return rows[0] ?? null;
}

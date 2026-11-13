import Decimal from 'decimal.js';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { getNextDocumentNumber } from '@/modules/sequence/documentSequenceService';
import { buildJournalPreview, createDraftJournalEntry, transitionJournalEntryStatus, reverseJournalEntry } from '@/modules/accounting/accountingService';
import { recordInMovement, recordOutMovement } from '@/modules/inventory/stockService';
import { fetchScopedById } from '@/shared/scope';
import { paginatedList } from '@/shared/pagination';

export interface StocktakeLineInput {
  itemId: string;
  batchId?: string;
  countedQuantity: string;
}

export interface CreateStocktakeInput {
  branchId: string;
  warehouseId: string;
  fiscalPeriodId: string;
  countDate: string;
  activityId?: string;
  projectId?: string;
  costCenterId?: string;
  lines: StocktakeLineInput[];
}

/**
 * إنشاء مسودة جرد: لقطة فورية من stock_balances (الكمية الدفترية ومتوسط التكلفة) لكل صنف مُدرَج،
 * مقابل الكمية المعدودة فعليًا — بلا أي حركة مخزون أو قيد محاسبي بعد. الفصل بين "تسجيل العدّ"
 * و"الترحيل" (postStocktake) يتيح مراجعة الفروق قبل أي أثر فعلي على الأرصدة والدفاتر، تمامًا
 * كنمط الفواتير والمرتجعات في هذا المشروع. صنف بلا رصيد سابق (لم يتحرك إطلاقًا) يُعامَل كرصيد
 * دفتري صفري — أي كمية معدودة له تصبح فائضًا كاملًا، وهذا صحيح منطقيًا.
 */
export async function createStocktake(ctx: RequestContext, input: CreateStocktakeInput) {
  ctx.assertPermission('inventory.stocktake.create', input.branchId);
  if (input.lines.length === 0) throw new ValidationError('الجرد يجب أن يحتوي سطرًا واحدًا على الأقل');

  return withTransaction(async (client) => {
    const company = await client.query(`SELECT base_currency_code FROM companies WHERE id=$1`, [ctx.companyId]);
    if (company.rows.length === 0) throw new NotFoundError('الشركة غير موجودة');

    const documentNumber = await getNextDocumentNumber(
      { companyId: ctx.companyId, branchId: input.branchId, documentType: 'STOCKTAKE', prefix: 'STK-' },
      client,
    );
    const header = await client.query(
      `INSERT INTO stocktakes(
        company_id, branch_id, warehouse_id, fiscal_period_id, document_number, currency_code, count_date,
        created_by, activity_id, project_id, cost_center_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        ctx.companyId, input.branchId, input.warehouseId, input.fiscalPeriodId, documentNumber,
        company.rows[0].base_currency_code, input.countDate, ctx.userId,
        input.activityId ?? null, input.projectId ?? null, input.costCenterId ?? null,
      ],
    );

    for (const line of input.lines) {
      const countedQty = new Decimal(line.countedQuantity);
      if (countedQty.isNegative()) throw new ValidationError('الكمية المعدودة لا يمكن أن تكون سالبة');

      const balanceWhere = line.batchId ? 'batch_id=$4' : 'batch_id IS NULL';
      const balanceParams = line.batchId
        ? [ctx.companyId, input.warehouseId, line.itemId, line.batchId]
        : [ctx.companyId, input.warehouseId, line.itemId];
      const balance = await client.query(
        `SELECT quantity_on_hand, weighted_average_cost FROM stock_balances
         WHERE company_id=$1 AND warehouse_id=$2 AND item_id=$3 AND ${balanceWhere}`,
        balanceParams,
      );
      const systemQty = balance.rows.length > 0 ? new Decimal(balance.rows[0].quantity_on_hand) : new Decimal(0);
      const unitCost = balance.rows.length > 0 ? new Decimal(balance.rows[0].weighted_average_cost) : new Decimal(0);
      const varianceQty = countedQty.minus(systemQty);

      await client.query(
        `INSERT INTO stocktake_lines(
          stocktake_id, company_id, item_id, batch_id, system_quantity, counted_quantity, unit_cost, variance_quantity, variance_value
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          header.rows[0].id, ctx.companyId, line.itemId, line.batchId ?? null,
          systemQty.toFixed(4), countedQty.toFixed(4), unitCost.toFixed(4),
          varianceQty.toFixed(4), varianceQty.times(unitCost).toFixed(4),
        ],
      );
    }

    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'stocktake', entityId: header.rows[0].id, action: 'create',
      afterJson: { documentNumber, lineCount: input.lines.length },
    });
    return header.rows[0];
  });
}

/**
 * ترحيل الجرد: لكل سطر بفرق فعلي (≠0) — حركة مخزون حقيقية (adjustment_in للفائض، adjustment_out
 * للعجز) بالتكلفة اللحظية وقت الترحيل (لا لقطة المسودة، التي قد تكون تقادمت لو تحرَّك الصنف بين
 * الإنشاء والترحيل)، ثم قيد محاسبي: مدين/دائن حساب المخزون مقابل حساب "فروق الجرد" الثابت. سطر
 * بفرق صفري (الكمية المعدودة تطابق الدفاتر تمامًا) يُتخطَّى بلا حركة ولا قيد له — لا داعي لأثر
 * محاسبي على ما هو مطابق أصلًا. رفض صريح لو كانت كل الأسطر مطابقة (لا داعي لمستند جرد بلا أي فرق).
 */
export async function postStocktake(ctx: RequestContext, stocktakeId: string) {
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM stocktakes WHERE id=$1 AND company_id=$2 FOR UPDATE`, [stocktakeId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('الجرد غير موجود');
    const st = found.rows[0];
    ctx.assertPermission('inventory.stocktake.post', st.branch_id);
    if (st.status !== 'draft') throw new ValidationError(`لا يمكن ترحيل جرد بحالة ${st.status}؛ يجب أن يكون draft`);

    const lines = await client.query(
      `SELECT sl.*, i.category_id FROM stocktake_lines sl
       JOIN items i ON i.id = sl.item_id AND i.company_id = sl.company_id
       WHERE sl.stocktake_id = $1`,
      [stocktakeId],
    );
    if (lines.rows.length === 0) throw new ValidationError('لا يمكن ترحيل جرد بلا أسطر');

    const legs: { operationType: string; amount: string; itemCategoryId: string }[] = [];

    for (const line of lines.rows) {
      const varianceQty = new Decimal(line.variance_quantity);
      if (varianceQty.isZero()) continue;
      if (!line.category_id) throw new ValidationError('الصنف بلا مجموعة صنف — لا يمكن تحديد حساب المخزون');

      if (varianceQty.greaterThan(0)) {
        const balanceWhere = line.batch_id ? 'batch_id=$4' : 'batch_id IS NULL';
        const balanceParams = line.batch_id
          ? [ctx.companyId, st.warehouse_id, line.item_id, line.batch_id]
          : [ctx.companyId, st.warehouse_id, line.item_id];
        const balance = await client.query(
          `SELECT weighted_average_cost FROM stock_balances WHERE company_id=$1 AND warehouse_id=$2 AND item_id=$3 AND ${balanceWhere}`,
          balanceParams,
        );
        // فائض: يُقيَّم بمتوسط التكلفة الحالي وقت الترحيل — إضافة كمية بنفس متوسطها الحالي تترك
        // المتوسط المرجَّح كما هو رياضيًا (لا تشويه للمتوسط بفائض "مجاني" القيمة).
        const currentAvg = balance.rows.length > 0 ? new Decimal(balance.rows[0].weighted_average_cost) : new Decimal(0);
        const movement = await recordInMovement(ctx, {
          branchId: st.branch_id, warehouseId: st.warehouse_id, itemId: line.item_id, batchId: line.batch_id ?? undefined,
          quantity: varianceQty.toFixed(4), unitCost: currentAvg.toFixed(4), movementDate: st.count_date,
          movementType: 'adjustment_in', sourceDocumentType: 'stocktake', sourceDocumentId: stocktakeId,
          activityId: st.activity_id ?? undefined, projectId: st.project_id ?? undefined,
        });
        await client.query(
          `UPDATE stocktake_lines SET stock_movement_id=$1, unit_cost=$2 WHERE id=$3`,
          [movement.movementId, currentAvg.toFixed(4), line.id],
        );
        legs.push({ operationType: 'inventory_adjustment_increase', amount: varianceQty.times(currentAvg).toFixed(4), itemCategoryId: line.category_id });
      } else {
        const movement = await recordOutMovement(ctx, {
          branchId: st.branch_id, warehouseId: st.warehouse_id, itemId: line.item_id, batchId: line.batch_id ?? undefined,
          quantity: varianceQty.abs().toFixed(4), movementDate: st.count_date, movementType: 'adjustment_out',
          sourceDocumentType: 'stocktake', sourceDocumentId: stocktakeId,
          activityId: st.activity_id ?? undefined, projectId: st.project_id ?? undefined,
        });
        const actualUnitCost = new Decimal(movement.costOfGoodsConsumed).dividedBy(varianceQty.abs());
        await client.query(
          `UPDATE stocktake_lines SET stock_movement_id=$1, unit_cost=$2 WHERE id=$3`,
          [movement.movementId, actualUnitCost.toFixed(4), line.id],
        );
        legs.push({ operationType: 'inventory_adjustment_decrease', amount: movement.costOfGoodsConsumed, itemCategoryId: line.category_id });
      }
    }

    if (legs.length === 0) {
      throw new ValidationError('لا يوجد أي فرق جرد فعلي في هذا المستند — كل الكميات المعدودة تطابق الدفاتر تمامًا');
    }

    const preview = await buildJournalPreview(ctx, legs, client);
    const linesWithCostCenter = st.cost_center_id
      ? preview.lines.map((l) => ({ ...l, costCenterId: l.costCenterId ?? st.cost_center_id }))
      : preview.lines;
    const draftEntry = await createDraftJournalEntry(ctx, {
      branchId: st.branch_id, fiscalPeriodId: st.fiscal_period_id, entryDate: st.count_date,
      currencyCode: st.currency_code, activityId: st.activity_id ?? undefined, projectId: st.project_id ?? undefined,
      sourceDocumentType: 'stocktake', sourceDocumentId: stocktakeId, lines: linesWithCostCenter,
    }, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'pending_review', undefined, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'approved', undefined, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'posted', undefined, client);

    await client.query(
      `UPDATE stocktakes SET status='posted', journal_entry_id=$2, posted_by=$3, posted_at=now() WHERE id=$1`,
      [stocktakeId, draftEntry.id, ctx.userId],
    );
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'stocktake', entityId: stocktakeId, action: 'post',
      afterJson: { journalEntryId: draftEntry.id, adjustedLineCount: legs.length },
    });
    return { id: stocktakeId, journalEntryId: draftEntry.id, adjustedLineCount: legs.length };
  });
}

/**
 * عكس جرد مرحَّل: لكل سطر تأثَّر فعليًا (له stock_movement_id) — حركة مخزون معاكسة تمامًا (فائض
 * سابق يُصرَف الآن، عجز سابق يُعاد الآن) بالتكلفة الفعلية المُخزَّنة على السطر (وليست لقطة
 * المسودة الأصلية — راجع تعليق unit_cost في migration 0029)، ثم عكس القيد المحاسبي بالكامل.
 */
export async function reverseStocktake(ctx: RequestContext, stocktakeId: string, reason: string) {
  if (!reason?.trim()) throw new ValidationError('سبب العكس إلزامي');
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM stocktakes WHERE id=$1 AND company_id=$2 FOR UPDATE`, [stocktakeId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('الجرد غير موجود');
    const st = found.rows[0];
    ctx.assertPermission('inventory.stocktake.reverse', st.branch_id);
    if (st.status !== 'posted') throw new ValidationError('يجب أن يكون الجرد مرحَّلًا لعكسه');

    const lines = await client.query(`SELECT * FROM stocktake_lines WHERE stocktake_id=$1 AND stock_movement_id IS NOT NULL`, [stocktakeId]);
    for (const line of lines.rows) {
      const varianceQty = new Decimal(line.variance_quantity);
      if (varianceQty.greaterThan(0)) {
        // كان فائضًا مُضافًا — نصرفه الآن خارج المخزن (عكس الإضافة)
        await recordOutMovement(ctx, {
          branchId: st.branch_id, warehouseId: st.warehouse_id, itemId: line.item_id, batchId: line.batch_id ?? undefined,
          quantity: varianceQty.toFixed(4), movementDate: st.count_date, movementType: 'adjustment_out',
          sourceDocumentType: 'stocktake_reversal', sourceDocumentId: stocktakeId,
          activityId: st.activity_id ?? undefined, projectId: st.project_id ?? undefined,
        });
      } else {
        // كان عجزًا مصروفًا — نُعيده الآن للمخزن (عكس الصرف) بنفس التكلفة الفعلية التي صُرِف بها
        await recordInMovement(ctx, {
          branchId: st.branch_id, warehouseId: st.warehouse_id, itemId: line.item_id, batchId: line.batch_id ?? undefined,
          quantity: varianceQty.abs().toFixed(4), unitCost: line.unit_cost, movementDate: st.count_date,
          movementType: 'adjustment_in', sourceDocumentType: 'stocktake_reversal', sourceDocumentId: stocktakeId,
          activityId: st.activity_id ?? undefined, projectId: st.project_id ?? undefined,
        });
      }
    }
    await reverseJournalEntry(ctx, st.journal_entry_id, reason);

    await client.query(
      `UPDATE stocktakes SET status='reversed', cancelled_reason=$2, cancelled_by=$3, cancelled_at=now() WHERE id=$1`,
      [stocktakeId, reason, ctx.userId],
    );
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'stocktake', entityId: stocktakeId, action: 'reverse', reason,
    });
    return { id: stocktakeId, status: 'reversed' };
  });
}

export async function getStocktakeById(ctx: RequestContext, id: string) {
  ctx.assertPermission('inventory.stocktake.view');
  const header = await fetchScopedById<{ id: string; company_id: string; branch_id: string }>('stocktakes', id, ctx, {
    notFoundMessage: 'الجرد غير موجود',
  });
  const lines = await pool.query(`SELECT * FROM stocktake_lines WHERE stocktake_id=$1`, [id]);
  return { ...header, lines: lines.rows };
}

export async function listStocktakes(ctx: RequestContext, page = 1, pageSize = 20, status?: string) {
  ctx.assertPermission('inventory.stocktake.view');
  return paginatedList<unknown>(ctx, 'stocktakes', { page, pageSize, status });
}

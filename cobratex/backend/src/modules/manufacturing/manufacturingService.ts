import Decimal from 'decimal.js';
import { pool, withTransaction } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError, NotFoundError, ConflictError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { getNextDocumentNumber } from '@/modules/sequence/documentSequenceService';
import { buildJournalPreview, createDraftJournalEntry, transitionJournalEntryStatus, reverseJournalEntry } from '@/modules/accounting/accountingService';
import { recordInMovement, recordOutMovement } from '@/modules/inventory/stockService';
import { issueLineLots, reverseLineLots } from '@/modules/manufacturing/textileLotIssue';
import { fetchScopedById } from '@/shared/scope';
import { paginatedList } from '@/shared/pagination';
import { computeTextileCosting } from '@/modules/manufacturing/textileCosting';

/**
 * فحص أن وحدة التصنيع مفعَّلة لهذه الشركة — يُستدعى أول شيء في كل دالة عامة بالملف. عند الإيقاف
 * تتصرف الوحدة كأنها غير موجودة (NotFoundError، لا رسالة "ممنوع" تكشف وجودها) — يطابق تمامًا شكل
 * إزالتها فعليًا من الكود لاحقًا، فلا فرق سلوكي بين "معطَّلة" و"محذوفة" من منظور أي طلب API.
 */
export async function assertManufacturingEnabled(ctx: RequestContext): Promise<void> {
  const { rows } = await pool.query(`SELECT manufacturing_enabled FROM companies WHERE id=$1`, [ctx.companyId]);
  if (rows.length === 0 || !rows[0].manufacturing_enabled) {
    throw new NotFoundError('وحدة التصنيع غير مُفعَّلة لهذه الشركة');
  }
}

/* ============================== قائمة المواد (Bill of Materials) ==============================
 * عمدًا بلا أي قيد على نوع الصنف المُنتَج (raw_material/fabric/thread/finished_good/generic) —
 * وصفة "خيط ← قماش" (نسيج) صحيحة بنفس درجة وصفة "قماش+أزرار ← قميص تام". التسلسل متعدد المراحل
 * (غزل ثم نسيج مثلًا) يتحقق بتسلسل أوامر تصنيع منفصلة، لا بمحرك توجيه (Routing) داخل أمر واحد —
 * راجع تعليق migration 0033 للتفصيل الكامل لهذا القرار.
 */

export interface BomLineInput {
  componentItemId: string;
  quantity: string;
  /** نسبة هالك 0-100، اختيارية (افتراضي 0) — راجع تعليق migration 0035. */
  wastePercent?: string;
  /** الخامة الرئيسية (أساس نسبة الهالك الفعلي في الغزل والنسيج) — اختياري. */
  isMainMaterial?: boolean;
}

export interface CreateBomInput {
  code: string;
  nameAr: string;
  nameEn: string;
  outputItemId: string;
  outputQuantity?: string;
  activityId?: string;
  /** مرحلة الإنتاج (غزل/نسيج/صباغة...) — تحدد نسبة الهالك القياسي. اختياري. */
  stageId?: string;
  lines: BomLineInput[];
  /** مراحل التصنيع وتكلفة تحويل كل منها (عمالة/مصاريف تشغيل) — اختيارية. */
  operations?: BomOperationInput[];
}

export type OperationCostType = 'labor' | 'overhead' | 'other';

export interface BomOperationInput {
  name: string;
  costType: OperationCostType;
  costAmount: string;
}

export async function createBom(ctx: RequestContext, input: CreateBomInput) {
  await assertManufacturingEnabled(ctx);
  ctx.assertPermission('manufacturing.bom.create');
  if (input.lines.length === 0) throw new ValidationError('قائمة المواد يجب أن تحتوي مكوّنًا واحدًا على الأقل');
  if (input.lines.some((l) => l.componentItemId === input.outputItemId)) {
    throw new ValidationError('لا يمكن أن يكون الصنف المُنتَج أحد مكوّناته الخاصة');
  }

  return withTransaction(async (client) => {
    const outputItem = await client.query(`SELECT id FROM items WHERE id=$1 AND company_id=$2`, [input.outputItemId, ctx.companyId]);
    if (outputItem.rows.length === 0) throw new NotFoundError('الصنف المُنتَج غير موجود');

    let header;
    try {
      header = await client.query(
        `INSERT INTO bill_of_materials(company_id, output_item_id, code, name_ar, name_en, output_quantity, activity_id, created_by, stage_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [ctx.companyId, input.outputItemId, input.code, input.nameAr, input.nameEn, input.outputQuantity ?? '1', input.activityId ?? null, ctx.userId, input.stageId ?? null],
      );
    } catch (e) {
      const pgErr = e as { code?: string };
      if (pgErr.code === '23505') throw new ConflictError(`كود قائمة المواد "${input.code}" مُستخدَم بالفعل`);
      throw e;
    }

    for (const [index, line] of input.lines.entries()) {
      const component = await client.query(`SELECT id FROM items WHERE id=$1 AND company_id=$2`, [line.componentItemId, ctx.companyId]);
      if (component.rows.length === 0) throw new NotFoundError(`المكوّن غير موجود: ${line.componentItemId}`);
      const wastePercent = line.wastePercent ?? '0';
      if (new Decimal(wastePercent).isNegative() || new Decimal(wastePercent).greaterThanOrEqualTo(100)) {
        throw new ValidationError('نسبة الهالك يجب أن تكون بين 0 و99.99');
      }
      await client.query(
        `INSERT INTO bom_lines(bom_id, company_id, component_item_id, quantity, sequence, waste_percent, is_main_material) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [header.rows[0].id, ctx.companyId, line.componentItemId, line.quantity, index, wastePercent, line.isMainMaterial ?? false],
      );
    }

    for (const [index, op] of (input.operations ?? []).entries()) {
      if (new Decimal(op.costAmount).isNegative()) throw new ValidationError('تكلفة المرحلة لا يمكن أن تكون سالبة');
      await client.query(
        `INSERT INTO bom_operations(bom_id, company_id, sequence, name, cost_type, cost_amount) VALUES ($1,$2,$3,$4,$5,$6)`,
        [header.rows[0].id, ctx.companyId, index, op.name, op.costType, op.costAmount],
      );
    }

    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'bill_of_materials', entityId: header.rows[0].id, action: 'create',
      afterJson: { code: input.code, outputItemId: input.outputItemId, lineCount: input.lines.length, operationCount: input.operations?.length ?? 0 },
    });
    return header.rows[0];
  });
}

export async function listBoms(ctx: RequestContext) {
  await assertManufacturingEnabled(ctx);
  ctx.assertPermission('manufacturing.bom.view');
  const { rows } = await pool.query(
    `SELECT * FROM bill_of_materials WHERE company_id=$1 AND is_active=true ORDER BY code ASC`,
    [ctx.companyId],
  );
  return rows;
}

export async function getBomById(ctx: RequestContext, id: string) {
  await assertManufacturingEnabled(ctx);
  ctx.assertPermission('manufacturing.bom.view');
  const header = await fetchScopedById<{ id: string; company_id: string }>('bill_of_materials', id, ctx, {
    notFoundMessage: 'قائمة المواد غير موجودة',
  });
  const lines = await pool.query(`SELECT * FROM bom_lines WHERE bom_id=$1 ORDER BY sequence ASC`, [id]);
  const operations = await pool.query(`SELECT * FROM bom_operations WHERE bom_id=$1 ORDER BY sequence ASC`, [id]);
  return { ...header, lines: lines.rows, operations: operations.rows };
}

/* ============================== أوامر التصنيع (Production Orders) ============================== */

export interface CreateProductionOrderInput {
  branchId: string;
  warehouseId: string;
  bomId: string;
  fiscalPeriodId: string;
  orderDate: string;
  plannedOutputQuantity: string;
  activityId?: string;
}

/**
 * إنشاء مسودة أمر تصنيع: لقطة من أسطر الـBOM مضروبة في الكمية المخطَّطة — بلا أي أثر على المخزون
 * أو الدفاتر بعد (الفصل بين "التخطيط" و"الترحيل"، بنفس نمط الجرد والفواتير في هذا المشروع).
 */
export async function createProductionOrder(ctx: RequestContext, input: CreateProductionOrderInput) {
  await assertManufacturingEnabled(ctx);
  ctx.assertPermission('manufacturing.order.create', input.branchId);

  return withTransaction(async (client) => {
    const bom = await client.query(
      `SELECT * FROM bill_of_materials WHERE id=$1 AND company_id=$2 AND is_active=true`,
      [input.bomId, ctx.companyId],
    );
    if (bom.rows.length === 0) throw new NotFoundError('قائمة المواد غير موجودة أو غير مفعَّلة');
    const bomRow = bom.rows[0];

    const bomLines = await client.query(`SELECT * FROM bom_lines WHERE bom_id=$1`, [input.bomId]);
    const company = await client.query(`SELECT base_currency_code FROM companies WHERE id=$1`, [ctx.companyId]);

    const documentNumber = await getNextDocumentNumber(
      { companyId: ctx.companyId, branchId: input.branchId, documentType: 'PRODUCTION_ORDER', prefix: 'PO-MFG-' },
      client,
    );

    const header = await client.query(
      `INSERT INTO production_orders(
        company_id, branch_id, warehouse_id, bom_id, output_item_id, activity_id, document_number,
        fiscal_period_id, order_date, currency_code, planned_output_quantity, created_by, stage_id, standard_waste_percent
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,(SELECT standard_waste_percent FROM textile_stages WHERE id=$13 AND company_id=$1)) RETURNING *`,
      [
        ctx.companyId, input.branchId, input.warehouseId, input.bomId, bomRow.output_item_id,
        input.activityId ?? bomRow.activity_id, documentNumber, input.fiscalPeriodId, input.orderDate,
        company.rows[0].base_currency_code, input.plannedOutputQuantity, ctx.userId, bomRow.stage_id ?? null,
      ],
    );

    // نسبة الكمية المخطَّطة لأمر التصنيع إلى output_quantity الأصلية للوصفة، مضروبة في كمية كل مكوّن.
    const scale = new Decimal(input.plannedOutputQuantity).dividedBy(bomRow.output_quantity);
    for (const line of bomLines.rows) {
      // الكمية المخطَّطة = (الكمية النظرية × نسبة الكمية) × (1 + نسبة الهالك/100).
      const theoreticalQty = new Decimal(line.quantity).times(scale);
      const wasteFactor = new Decimal(1).plus(new Decimal(line.waste_percent).dividedBy(100));
      const plannedQty = theoreticalQty.times(wasteFactor);
      await client.query(
        `INSERT INTO production_order_lines(production_order_id, company_id, component_item_id, planned_quantity, waste_percent, is_main_material)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [header.rows[0].id, ctx.companyId, line.component_item_id, plannedQty.toFixed(4), line.waste_percent, line.is_main_material],
      );
    }

    const bomOps = await client.query(`SELECT * FROM bom_operations WHERE bom_id=$1 ORDER BY sequence ASC`, [input.bomId]);
    for (const op of bomOps.rows) {
      const plannedCost = new Decimal(op.cost_amount).times(scale);
      await client.query(
        `INSERT INTO production_order_operations(production_order_id, company_id, sequence, name, cost_type, planned_cost)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [header.rows[0].id, ctx.companyId, op.sequence, op.name, op.cost_type, plannedCost.toFixed(4)],
      );
    }

    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'production_order', entityId: header.rows[0].id, action: 'create',
      afterJson: { documentNumber, bomId: input.bomId, plannedOutputQuantity: input.plannedOutputQuantity },
    });
    return header.rows[0];
  });
}

/**
 * ترحيل أمر التصنيع: يستهلك كل مكوّن بالتكلفة اللحظية الفعلية وقت الترحيل (لا لقطة المسودة)، ثم
 * يُنتِج الصنف المُنتَج بتكلفة = مجموع تكاليف المكوّنات المُستهلَكة بالضبط (لا هامش/تكلفة تشغيل في
 * هذه المرحلة). القيد المحاسبي يمر عبر حساب "تحت التشغيل - التصنيع" الوسيط (posting rules
 * manufacturing_consume / manufacturing_output): كل مكوّن يُقيَّد مدينًا فيه ودائنًا من مخزونه،
 * ثم الصنف المُنتَج يُقيَّد مدينًا في مخزونه ودائنًا من نفس الحساب الوسيط — يتصفَّر صافيًا تلقائيًا
 * (مجموع مدين الاستهلاك = دائن الإنتاج)، فهو حساب تمريري بحت، مطابق للنمط المحاسبي القياسي
 * لأوامر التصنيع (Work-in-Process clearing account).
 */
export async function postProductionOrder(ctx: RequestContext, orderId: string) {
  await assertManufacturingEnabled(ctx);
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM production_orders WHERE id=$1 AND company_id=$2 FOR UPDATE`, [orderId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('أمر التصنيع غير موجود');
    const order = found.rows[0];
    ctx.assertPermission('manufacturing.order.post', order.branch_id);
    if (order.status !== 'draft') throw new ValidationError(`لا يمكن ترحيل أمر بحالة ${order.status}؛ يجب أن يكون draft`);

    const lines = await client.query(
      `SELECT pol.*, i.category_id FROM production_order_lines pol
       JOIN items i ON i.id = pol.component_item_id AND i.company_id = pol.company_id
       WHERE pol.production_order_id = $1`,
      [orderId],
    );
    if (lines.rows.length === 0) throw new ValidationError('لا يمكن ترحيل أمر تصنيع بلا مكوّنات');

    const outputItem = await client.query(`SELECT category_id FROM items WHERE id=$1 AND company_id=$2`, [order.output_item_id, ctx.companyId]);
    if (!outputItem.rows[0]?.category_id) throw new ValidationError('الصنف المُنتَج بلا مجموعة صنف — لا يمكن تحديد حساب المخزون');

    const legs: { operationType: string; amount: string; itemCategoryId: string; description: string }[] = [];
    let totalCost = new Decimal(0);

    const consumedInfo: Array<{ qty: Decimal; unitCost: Decimal; isMain: boolean }> = [];
    for (const line of lines.rows) {
      if (!line.category_id) throw new ValidationError('أحد المكوّنات بلا مجموعة صنف — لا يمكن تحديد حساب المخزون');
      // الاستهلاك الفعلي (إن سُجِّل على المسودة من شاشة الغزل والنسيج) وإلا المخطَّط كما كان دائمًا.
      const consumeQty: string = line.actual_quantity ?? line.planned_quantity;
      // لوطات محدَّدة للمكوّن (2.10.0): كل لوط بحركة مستقلة بتكلفته؛ بلا تخصيص يعمل المسار القديم كما كان.
      const lotIssue = await issueLineLots(ctx, client, order, line, consumeQty);
      const movement = lotIssue ? { movementId: lotIssue.firstMovementId, costOfGoodsConsumed: lotIssue.lineCost } : await recordOutMovement(ctx, {
        branchId: order.branch_id, warehouseId: order.warehouse_id, itemId: line.component_item_id,
        quantity: consumeQty, movementDate: order.order_date, movementType: 'production_consume',
        sourceDocumentType: 'production_order', sourceDocumentId: orderId, activityId: order.activity_id ?? undefined,
      });
      const lineCost = new Decimal(movement.costOfGoodsConsumed);
      const unitCost = lineCost.dividedBy(consumeQty);
      totalCost = totalCost.plus(lineCost);
      consumedInfo.push({ qty: new Decimal(consumeQty), unitCost, isMain: !!line.is_main_material });

      await client.query(
        `UPDATE production_order_lines SET consumed_quantity=$1, unit_cost=$2, line_cost=$3, stock_movement_id=$4 WHERE id=$5`,
        [consumeQty, unitCost.toFixed(4), lineCost.toFixed(4), movement.movementId, line.id],
      );
      legs.push({
        operationType: 'manufacturing_consume', amount: lineCost.toFixed(4), itemCategoryId: line.category_id,
        description: `استهلاك تصنيع — أمر ${order.document_number}`,
      });
    }

    if (totalCost.isZero()) throw new ValidationError('إجمالي تكلفة الاستهلاك صفر — تحقَّق من أرصدة المكوّنات وتكلفتها');

    // تكلفة التحويل: مجموع (الفعلية إن حُدِّدت وإلا المخطَّطة) لكل مرحلة. تدخل في تكلفة الصنف المُنتَج،
    // وتُقيَّد مدينة في مخزونه ودائنة في حساب "تكاليف تصنيع محمَّلة" (يقابل المصروفات الفعلية المسجَّلة
    // بمستنداتها الأصلية: أجور، كهرباء...). بلا مراحل تبقى التكلفة = المواد فقط كما كانت.
    const operations = await client.query(`SELECT * FROM production_order_operations WHERE production_order_id=$1`, [orderId]);
    const conversionCost = operations.rows.reduce(
      (sum, op) => sum.plus(op.actual_cost ?? op.planned_cost), new Decimal(0),
    );
    const materialsCost = totalCost;
    const fullCost = materialsCost.plus(conversionCost);

    // مخرجات/هالك فعلي (الغزل والنسيج): إن سُجِّلت على المسودة يُحسَب الهالك العادي وغير العادي وتُوزَّع التكلفة على
    // المخرجات بدرجاتها. بدونها يعمل المسار التقليدي أدناه كما كان تمامًا (إنتاج = المخطَّط بتكلفة المواد + التحويل).
    const outs = await client.query(`SELECT * FROM production_order_outputs WHERE production_order_id=$1 ORDER BY id`, [orderId]);
    const wastes = await client.query(`SELECT w.*, t.recovery_item_id AS type_recovery_item_id FROM production_order_waste w JOIN waste_types t ON t.id = w.waste_type_id AND t.company_id = w.company_id WHERE w.production_order_id=$1 ORDER BY w.id`, [orderId]);
    let actualOutputQty = new Decimal(order.planned_output_quantity);
    const extra: { wasteQty?: string; recovered?: string; abnormal?: string } = {};

    if (outs.rows.length === 0 && wastes.rows.length === 0) {
      const outputMovement = await recordInMovement(ctx, {
        branchId: order.branch_id, warehouseId: order.warehouse_id, itemId: order.output_item_id,
        quantity: order.planned_output_quantity, unitCost: fullCost.dividedBy(order.planned_output_quantity).toFixed(4),
        movementDate: order.order_date, movementType: 'production_output',
        sourceDocumentType: 'production_order', sourceDocumentId: orderId, activityId: order.activity_id ?? undefined,
      });
      legs.push({
        operationType: 'manufacturing_output', amount: materialsCost.toFixed(4), itemCategoryId: outputItem.rows[0].category_id,
        description: `إنتاج تصنيع — أمر ${order.document_number}`,
      });
      if (conversionCost.greaterThan(0)) {
        legs.push({
          operationType: 'manufacturing_conversion', amount: conversionCost.toFixed(4), itemCategoryId: outputItem.rows[0].category_id,
          description: `تكلفة تحويل (عمالة/تشغيل) — أمر ${order.document_number}`,
        });
      }
    } else {
      if (outs.rows.length === 0) throw new ValidationError('سجِّل مخرَجًا واحدًا على الأقل مع الهالك (الإنتاج الفعلي)');
      const main = consumedInfo.find((c) => c.isMain) ?? consumedInfo.reduce((a, b) => (b.qty.greaterThan(a.qty) ? b : a));
      const costing = computeTextileCosting({
        materialsCost: materialsCost, conversionCost: conversionCost, mainConsumedQty: main.qty, mainUnitCost: main.unitCost,
        standardWastePercent: order.standard_waste_percent ?? 0,
        wastes: wastes.rows.map((w) => ({ quantity: w.quantity, recoveryUnitValue: w.recovery_unit_value })),
        outputs: outs.rows.map((o) => ({ quantity: o.quantity, costWeight: o.cost_weight })),
      });
      const categoryOf = async (itemId: string): Promise<string> => {
        const r = await client.query(`SELECT category_id FROM items WHERE id=$1 AND company_id=$2`, [itemId, ctx.companyId]);
        if (!r.rows[0]?.category_id) throw new ValidationError('أحد أصناف المخرجات/الهالك بلا مجموعة صنف — لا يمكن تحديد حساب المخزون');
        return r.rows[0].category_id as string;
      };

      for (const [i, o] of outs.rows.entries()) {
        const l = costing.outputLines[i];
        const mv = await recordInMovement(ctx, {
          branchId: order.branch_id, warehouseId: order.warehouse_id, itemId: o.output_item_id,
          quantity: o.quantity, unitCost: l.unitCost, movementDate: order.order_date, movementType: 'production_output',
          sourceDocumentType: 'production_order', sourceDocumentId: orderId, activityId: order.activity_id ?? undefined,
        });
        await client.query(`UPDATE production_order_outputs SET unit_cost=$1, line_cost=$2, stock_movement_id=$3 WHERE id=$4`, [l.unitCost, l.cost, mv.movementId, o.id]);
        const cat = await categoryOf(o.output_item_id);
        if (new Decimal(l.materialsPart).greaterThan(0)) {
          legs.push({ operationType: 'manufacturing_output', amount: l.materialsPart, itemCategoryId: cat, description: `إنتاج درجة ${o.grade} — أمر ${order.document_number}` });
        }
        if (new Decimal(l.conversionPart).greaterThan(0)) {
          legs.push({ operationType: 'manufacturing_conversion', amount: l.conversionPart, itemCategoryId: cat, description: `تكلفة تحويل درجة ${o.grade} — أمر ${order.document_number}` });
        }
      }

      for (const [i, w] of wastes.rows.entries()) {
        const l = costing.wasteLines[i];
        let movementId: string | null = null;
        if (new Decimal(l.recoveredValue).greaterThan(0)) {
          const recItem: string | null = w.recovery_item_id ?? w.type_recovery_item_id;
          if (!recItem) throw new ValidationError('هالك قابل للاسترداد بقيمة بلا صنف استرداد — حدِّد صنف الهالك على نوع الهالك أو على البند');
          const mv = await recordInMovement(ctx, {
            branchId: order.branch_id, warehouseId: order.warehouse_id, itemId: recItem,
            quantity: w.quantity, unitCost: new Decimal(w.recovery_unit_value).toFixed(4), movementDate: order.order_date,
            movementType: 'production_output', sourceDocumentType: 'production_order', sourceDocumentId: orderId, activityId: order.activity_id ?? undefined,
          });
          movementId = mv.movementId;
          legs.push({ operationType: 'manufacturing_waste_recovery', amount: l.recoveredValue, itemCategoryId: await categoryOf(recItem), description: `استرداد هالك — أمر ${order.document_number}` });
        }
        await client.query(
          `UPDATE production_order_waste SET abnormal_quantity=$1, recovered_value=$2, abnormal_loss=$3, stock_movement_id=$4 WHERE id=$5`,
          [l.abnormalQuantity, l.recoveredValue, l.abnormalLoss, movementId, w.id],
        );
      }
      if (new Decimal(costing.abnormalLossTotal).greaterThan(0)) {
        legs.push({ operationType: 'manufacturing_abnormal_loss', amount: costing.abnormalLossTotal, itemCategoryId: await categoryOf(outs.rows[0].output_item_id), description: `خسارة هالك غير عادي — أمر ${order.document_number}` });
      }
      actualOutputQty = outs.rows.reduce((a, o) => a.plus(o.quantity), new Decimal(0));
      extra.wasteQty = costing.totalWasteQty; extra.recovered = costing.recoveredValueTotal; extra.abnormal = costing.abnormalLossTotal;
    }

    const preview = await buildJournalPreview(ctx, legs, client);
    const draftEntry = await createDraftJournalEntry(ctx, {
      branchId: order.branch_id, fiscalPeriodId: order.fiscal_period_id, entryDate: order.order_date,
      currencyCode: order.currency_code, activityId: order.activity_id ?? undefined,
      sourceDocumentType: 'production_order', sourceDocumentId: orderId, lines: preview.lines,
    }, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'pending_review', undefined, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'approved', undefined, client);
    await transitionJournalEntryStatus(ctx, draftEntry.id, 'posted', undefined, client);

    await client.query(
      `UPDATE production_orders SET status='posted', actual_output_quantity=$2, total_cost=$3, materials_cost=$6, conversion_cost=$7,
         journal_entry_id=$4, posted_by=$5, posted_at=now(),
         waste_quantity_total=$8, recovered_value_total=$9, abnormal_loss_total=$10
       WHERE id=$1`,
      [orderId, actualOutputQty.toFixed(4), fullCost.toFixed(4), draftEntry.id, ctx.userId, materialsCost.toFixed(4), conversionCost.toFixed(4),
        extra.wasteQty ?? null, extra.recovered ?? null, extra.abnormal ?? null],
    );
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'production_order', entityId: orderId, action: 'post',
      afterJson: { journalEntryId: draftEntry.id, totalCost: fullCost.toFixed(4), conversionCost: conversionCost.toFixed(4) },
    });
    return { id: orderId, journalEntryId: draftEntry.id, totalCost: fullCost.toFixed(4), materialsCost: materialsCost.toFixed(4), conversionCost: conversionCost.toFixed(4) };
  });
}

/**
 * عكس أمر تصنيع مرحَّل: يُعيد كل مكوّن مُستهلَك للمخزن (بنفس تكلفته الفعلية المُخزَّنة)، يصرف
 * الصنف المُنتَج بالكامل، ويعكس القيد المحاسبي. لا رجوع جزئي — عكس كامل فقط (يطابق نمط الجرد
 * والمرتجعات في هذا المشروع).
 */
export async function reverseProductionOrder(ctx: RequestContext, orderId: string, reason: string) {
  await assertManufacturingEnabled(ctx);
  if (!reason?.trim()) throw new ValidationError('سبب العكس إلزامي');
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM production_orders WHERE id=$1 AND company_id=$2 FOR UPDATE`, [orderId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('أمر التصنيع غير موجود');
    const order = found.rows[0];
    ctx.assertPermission('manufacturing.order.reverse', order.branch_id);
    if (order.status !== 'posted') throw new ValidationError('يجب أن يكون أمر التصنيع مرحَّلًا لعكسه');

    const lines = await client.query(`SELECT * FROM production_order_lines WHERE production_order_id=$1 AND stock_movement_id IS NOT NULL`, [orderId]);
    for (const line of lines.rows) {
      if (await reverseLineLots(ctx, client, order, line)) continue; // لوطات: كل لوط يعود لنفسه بتكلفته
      await recordInMovement(ctx, {
        branchId: order.branch_id, warehouseId: order.warehouse_id, itemId: line.component_item_id,
        quantity: line.consumed_quantity, unitCost: line.unit_cost, movementDate: order.order_date,
        movementType: 'production_consume', sourceDocumentType: 'production_order_reversal', sourceDocumentId: orderId,
        activityId: order.activity_id ?? undefined,
      });
    }
    // أمر بمخرجات/هالك فعلي (الغزل والنسيج): نعكس كل مخرَج وكل هالك مُسترَد أُدخل المخزن. وإلا المسار التقليدي.
    const tOuts = await client.query(`SELECT * FROM production_order_outputs WHERE production_order_id=$1 AND stock_movement_id IS NOT NULL`, [orderId]);
    const tWaste = await client.query(
      `SELECT w.*, COALESCE(w.recovery_item_id, t.recovery_item_id) AS item_id FROM production_order_waste w
       JOIN waste_types t ON t.id = w.waste_type_id AND t.company_id = w.company_id
       WHERE w.production_order_id=$1 AND w.stock_movement_id IS NOT NULL`, [orderId],
    );
    if (tOuts.rows.length === 0) {
      await recordOutMovement(ctx, {
        branchId: order.branch_id, warehouseId: order.warehouse_id, itemId: order.output_item_id,
        quantity: order.actual_output_quantity, movementDate: order.order_date, movementType: 'production_output',
        sourceDocumentType: 'production_order_reversal', sourceDocumentId: orderId, activityId: order.activity_id ?? undefined,
      });
    } else {
      for (const o of tOuts.rows) {
        await recordOutMovement(ctx, {
          branchId: order.branch_id, warehouseId: order.warehouse_id, itemId: o.output_item_id,
          quantity: o.quantity, movementDate: order.order_date, movementType: 'production_output',
          sourceDocumentType: 'production_order_reversal', sourceDocumentId: orderId, activityId: order.activity_id ?? undefined,
        });
      }
      for (const w of tWaste.rows) {
        await recordOutMovement(ctx, {
          branchId: order.branch_id, warehouseId: order.warehouse_id, itemId: w.item_id,
          quantity: w.quantity, movementDate: order.order_date, movementType: 'production_output',
          sourceDocumentType: 'production_order_reversal', sourceDocumentId: orderId, activityId: order.activity_id ?? undefined,
        });
      }
    }

    await reverseJournalEntry(ctx, order.journal_entry_id, reason);

    await client.query(
      `UPDATE production_orders SET status='reversed', cancelled_reason=$2, cancelled_by=$3, cancelled_at=now() WHERE id=$1`,
      [orderId, reason, ctx.userId],
    );
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'production_order', entityId: orderId, action: 'reverse', reason,
    });
    return { id: orderId, status: 'reversed' };
  });
}

export async function getProductionOrderById(ctx: RequestContext, id: string) {
  await assertManufacturingEnabled(ctx);
  ctx.assertPermission('manufacturing.order.view');
  const header = await fetchScopedById<{ id: string; company_id: string; branch_id: string }>('production_orders', id, ctx, {
    notFoundMessage: 'أمر التصنيع غير موجود',
  });
  const lines = await pool.query(`SELECT * FROM production_order_lines WHERE production_order_id=$1`, [id]);
  const operations = await pool.query(`SELECT * FROM production_order_operations WHERE production_order_id=$1 ORDER BY sequence ASC`, [id]);
  const outputs = await pool.query(`SELECT * FROM production_order_outputs WHERE production_order_id=$1 ORDER BY id`, [id]);
  const waste = await pool.query(`SELECT * FROM production_order_waste WHERE production_order_id=$1 ORDER BY id`, [id]);
  return { ...header, lines: lines.rows, operations: operations.rows, outputs: outputs.rows, waste: waste.rows };
}

/**
 * تعديل التكلفة الفعلية لمراحل أمر تصنيع (مسودة فقط) — التكلفة المخطَّطة من الوصفة قد تختلف عن الواقع
 * (ساعات إضافية، فاتورة كهرباء فعلية...). بعد الترحيل تُقفَل، فأي تصحيح يتم بعكس الأمر ثم إعادته.
 */
export async function updateOperationCosts(ctx: RequestContext, orderId: string, updates: { operationId: string; actualCost: string }[]) {
  await assertManufacturingEnabled(ctx);
  return withTransaction(async (client) => {
    const found = await client.query(`SELECT * FROM production_orders WHERE id=$1 AND company_id=$2 FOR UPDATE`, [orderId, ctx.companyId]);
    if (found.rows.length === 0) throw new NotFoundError('أمر التصنيع غير موجود');
    ctx.assertPermission('manufacturing.order.update', found.rows[0].branch_id);
    if (found.rows[0].status !== 'draft') throw new ValidationError('لا يمكن تعديل تكاليف المراحل إلا لأمر في حالة مسودة');

    for (const u of updates) {
      if (new Decimal(u.actualCost).isNegative()) throw new ValidationError('التكلفة لا يمكن أن تكون سالبة');
      const r = await client.query(
        `UPDATE production_order_operations SET actual_cost=$1 WHERE id=$2 AND production_order_id=$3 RETURNING id`,
        [u.actualCost, u.operationId, orderId],
      );
      if (r.rows.length === 0) throw new NotFoundError('مرحلة غير موجودة في هذا الأمر');
    }
    await writeAuditLog(client, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'production_order', entityId: orderId, action: 'update', afterJson: { operationCosts: updates },
    });
    const operations = await client.query(`SELECT * FROM production_order_operations WHERE production_order_id=$1 ORDER BY sequence ASC`, [orderId]);
    return operations.rows;
  });
}

export async function listProductionOrders(ctx: RequestContext, page = 1, pageSize = 20, status?: string) {
  await assertManufacturingEnabled(ctx);
  ctx.assertPermission('manufacturing.order.view');
  return paginatedList<unknown>(ctx, 'production_orders', { page, pageSize, status });
}

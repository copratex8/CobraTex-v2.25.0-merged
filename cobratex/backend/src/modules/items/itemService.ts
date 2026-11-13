import { pool } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { ConflictError, NotFoundError, ValidationError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';
import { fetchScopedById } from '@/shared/scope';
import { paginatedList } from '@/shared/pagination';

export type ItemKind = 'raw_material' | 'fabric' | 'thread' | 'finished_good' | 'generic';

export async function createItemCategory(
  ctx: RequestContext,
  input: {
    nameAr: string; nameEn: string; itemKind: ItemKind; activityId?: string; parentId?: string;
    defaultInventoryAccountId?: string; defaultCogsAccountId?: string;
  },
) {
  ctx.assertPermission('items.category.create');
  const { rows } = await pool.query(
    `INSERT INTO item_categories(company_id, activity_id, name_ar, name_en, item_kind, parent_id, default_inventory_account_id, default_cogs_account_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      ctx.companyId, input.activityId ?? null, input.nameAr, input.nameEn, input.itemKind, input.parentId ?? null,
      input.defaultInventoryAccountId ?? null, input.defaultCogsAccountId ?? null,
    ],
  );
  await writeAuditLog(pool, {
    tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
    entityType: 'item_category', entityId: rows[0].id, action: 'create', afterJson: rows[0],
  });
  return rows[0];
}

export async function createUom(ctx: RequestContext, nameAr: string, nameEn: string, symbol: string) {
  ctx.assertPermission('items.item.create');
  for (const [k, v] of Object.entries({ nameAr, nameEn, symbol })) if (typeof v !== 'string' || !v.trim() || v.length > 60) throw new ValidationError(`الحقل ${k} مطلوب (نص حتى 60 حرفًا)`);
  const { rows } = await pool.query(
    `INSERT INTO uoms(company_id, name_ar, name_en, symbol) VALUES ($1,$2,$3,$4) RETURNING *`,
    [ctx.companyId, nameAr, nameEn, symbol],
  );
  return rows[0];
}

export interface CreateItemInput {
  code: string;
  nameAr: string;
  nameEn: string;
  itemKind: ItemKind;
  baseUomId: string;
  categoryId?: string;
  activityId?: string;
  colorId?: string;
  sizeId?: string;
  materialId?: string;
  isBatchTracked?: boolean;
  barcode?: string;
}

/**
 * كل الأنواع الأربعة (مادة خام/قماش/خيط/منتج تام) + العام تمر من هنا — جدول واحد،
 * لا ثلاث وحدات منفصلة كما كانت في TechTex (راجع DATA_MODEL.md §3).
 */
export async function createItem(ctx: RequestContext, input: CreateItemInput) {
  ctx.assertPermission('items.item.create');
  try {
    const { rows } = await pool.query(
      `INSERT INTO items(
        company_id, activity_id, category_id, item_kind, code, barcode, name_ar, name_en,
        base_uom_id, color_id, size_id, material_id, is_batch_tracked
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *`,
      [
        ctx.companyId,
        input.activityId ?? null,
        input.categoryId ?? null,
        input.itemKind,
        input.code,
        input.barcode ?? null,
        input.nameAr,
        input.nameEn,
        input.baseUomId,
        input.colorId ?? null,
        input.sizeId ?? null,
        input.materialId ?? null,
        input.isBatchTracked ?? false,
      ],
    );
    await writeAuditLog(pool, {
      tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
      entityType: 'item', entityId: rows[0].id, action: 'create', afterJson: rows[0],
    });
    return rows[0];
  } catch (e) {
    const pgErr = e as { code?: string; constraint?: string };
    if (pgErr.code === '23505') {
      throw new ConflictError('كود الصنف أو الباركود مستخدم بالفعل داخل هذه الشركة');
    }
    throw e;
  }
}

export async function getItemById(ctx: RequestContext, itemId: string) {
  ctx.assertPermission('items.item.view');
  try {
    return await fetchScopedById('items', itemId, ctx, { notFoundMessage: 'الصنف غير موجود', checkBranch: false });
  } catch {
    return null; // يحافظ على سلوك الاستدعاءات الحالية التي تتوقع null بدل استثناء عند عدم الوجود
  }
}

export async function listItems(ctx: RequestContext, page = 1, pageSize = 20) {
  ctx.assertPermission('items.item.view');
  return paginatedList<unknown>(ctx, 'items', { page, pageSize, hasBranchColumn: false, orderBy: 'code ASC' });
}

/** راجع تعليق updateCustomerStatus في customerService.ts — نفس المنطق بالضبط (تعطيل لا حذف). */
export async function updateItemStatus(ctx: RequestContext, itemId: string, isActive: boolean) {
  ctx.assertPermission('items.item.update');
  const { rows } = await pool.query(
    `UPDATE items SET is_active = $1 WHERE id = $2 AND company_id = $3 RETURNING *`,
    [isActive, itemId, ctx.companyId],
  );
  if (rows.length === 0) throw new NotFoundError('الصنف غير موجود');
  await writeAuditLog(pool, {
    tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
    entityType: 'item', entityId: itemId, action: 'update', afterJson: { isActive },
  });
  return rows[0];
}

/** قائمة كاملة بلا صفحات — جدول مرجعي صغير عادةً (وحدات قياس)، لا عمود created_at أصلًا. */
export async function listUoms(ctx: RequestContext) {
  ctx.assertPermission('items.item.view');
  const { rows } = await pool.query(`SELECT * FROM uoms WHERE company_id=$1 ORDER BY name_ar`, [ctx.companyId]);
  return rows;
}

/** قائمة كاملة بلا صفحات — جدول مرجعي صغير عادةً (فئات أصناف). */
export async function listItemCategories(ctx: RequestContext) {
  ctx.assertPermission('items.category.view');
  const { rows } = await pool.query(`SELECT * FROM item_categories WHERE company_id=$1 ORDER BY name_ar`, [ctx.companyId]);
  return rows;
}

import { pool } from '@/db/pool';
import { RequestContext } from '@/shared/requestContext';
import { NotFoundError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';

/** فجوة كانت موجودة قبل هذه المرحلة: المخازن لم يكن لها أي خدمة أو مسار API — تُنشأ فقط ضمنيًا
 * عبر /bootstrap عند إعداد الشركة الأول. هذه الخدمة تسدّها بأقل شكل ممكن (إنشاء + قائمة). */
export async function createWarehouse(ctx: RequestContext, input: { branchId: string; nameAr: string; nameEn: string }) {
  ctx.assertPermission('inventory.warehouse.create', input.branchId);
  const { rows } = await pool.query(
    `INSERT INTO warehouses(branch_id, company_id, name_ar, name_en) VALUES ($1,$2,$3,$4) RETURNING *`,
    [input.branchId, ctx.companyId, input.nameAr, input.nameEn],
  );
  await writeAuditLog(pool, {
    tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
    entityType: 'warehouse', entityId: rows[0].id, action: 'create', afterJson: rows[0],
  });
  return rows[0];
}

/** قائمة كاملة بلا صفحات (عادةً عدد قليل من المخازن لكل شركة)، معزولة بفروع المستخدم المرئية. */
export async function listWarehouses(ctx: RequestContext) {
  ctx.assertPermission('inventory.warehouse.view');
  const visible = ctx.visibleBranchIds();
  if (visible === null) {
    const { rows } = await pool.query(`SELECT * FROM warehouses WHERE company_id=$1 ORDER BY name_ar`, [ctx.companyId]);
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT * FROM warehouses WHERE company_id=$1 AND branch_id = ANY($2) ORDER BY name_ar`,
    [ctx.companyId, visible],
  );
  return rows;
}

export async function getWarehouseById(ctx: RequestContext, id: string) {
  ctx.assertPermission('inventory.warehouse.view');
  const { rows } = await pool.query(`SELECT * FROM warehouses WHERE id=$1 AND company_id=$2`, [id, ctx.companyId]);
  if (rows.length === 0) throw new NotFoundError('المخزن غير موجود');
  return rows[0];
}

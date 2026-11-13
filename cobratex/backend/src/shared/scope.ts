import { pool } from '@/db/pool';
import { RequestContext } from './requestContext';
import { NotFoundError } from './errors';

/**
 * تحقق نطاق على مستوى الشركة (Company-level scope). لسجل جُلب بالفعل، يتأكد أنه ينتمي لشركة
 * المستخدم — دفاع إضافي (Defense in Depth) حتى لو نُسي شرط WHERE company_id في استعلام ما.
 * سياسة عدم الإفصاح: سجل تابع لشركة أخرى يُعامَل كأنه غير موجود (404)، لا "ممنوع" (403) — لا نكشف
 * حتى وجوده.
 */
export function assertCompanyScope(ctx: RequestContext, row: { company_id?: string } | null | undefined): void {
  if (!row || row.company_id !== ctx.companyId) {
    throw new NotFoundError('السجل غير موجود');
  }
}

/**
 * تحقق نطاق على مستوى الفرع (Branch-level scope). السجل موجود فعلًا ضمن شركة المستخدم (سياسة
 * الإفصاح هنا مختلفة عمدًا عن assertCompanyScope): تجاوز نطاق الفرع الشخصي يُعامَل كـ"ممنوع"
 * (403)، لأن وجود السجل نفسه ضمن الشركة ليس سرًّا — فقط الوصول إليه من هذا الفرع بالذات ممنوع.
 */
export function assertBranchScope(ctx: RequestContext, branchId: string | null | undefined): void {
  if (!branchId) return;
  ctx.assertBranchInScope(branchId);
}

/**
 * تحقق نطاق على مستوى المخزن (Warehouse-level scope): لا عمود branch_id مباشر على كثير من
 * الاستعلامات (مثل رصيد المخزون)، فنستخرج فرع المخزن أولًا من قاعدة البيانات ثم نطبّق نفس تحقق
 * الفرع. مصدر الحقيقة الوحيد هو جدول warehouses، لا أي قيمة يرسلها العميل.
 */
export async function assertWarehouseScope(ctx: RequestContext, warehouseId: string): Promise<void> {
  const { rows } = await pool.query(`SELECT branch_id, company_id FROM warehouses WHERE id=$1`, [warehouseId]);
  if (rows.length === 0 || rows[0].company_id !== ctx.companyId) {
    throw new NotFoundError('المخزن غير موجود');
  }
  assertBranchScope(ctx, rows[0].branch_id);
}

/**
 * جلب سجل واحد بمعرّفه ضمن نطاق الشركة (وفرعه إن وُجد عمود branch_id)، بدل تكرار نفس شرط
 * WHERE company_id=$2 [+ فحص الفرع يدويًا] في كل خدمة. اسم الجدول دائمًا نص ثابت مكتوب من
 * المطوّر داخل الشيفرة (لا يُشتق أبدًا من مدخلات المستخدم)، فلا خطر حقن SQL من هذا النمط.
 */
export async function fetchScopedById<T extends { company_id: string; branch_id?: string | null }>(
  table: string,
  id: string,
  ctx: RequestContext,
  opts?: { checkBranch?: boolean; notFoundMessage?: string },
): Promise<T> {
  const { rows } = await pool.query(`SELECT * FROM ${table} WHERE id = $1 AND company_id = $2`, [id, ctx.companyId]);
  if (rows.length === 0) {
    throw new NotFoundError(opts?.notFoundMessage ?? 'السجل غير موجود');
  }
  const row = rows[0] as T;
  if ((opts?.checkBranch ?? true) && row.branch_id) {
    assertBranchScope(ctx, row.branch_id);
  }
  return row;
}

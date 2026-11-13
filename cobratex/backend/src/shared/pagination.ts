import { z } from 'zod';
import { pool } from '@/db/pool';
import { RequestContext } from './requestContext';

/** استعلام صفحات موحَّد لكل مسارات القوائم: page يبدأ من 1، pageSize محدود بحد أقصى 100 لمنع طلب كل الجدول دفعة واحدة. */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.string().max(50).optional(),
  // فلاتر الطرف المقابل — تُستخدَم فقط من قوائم فواتير البيع (customerId) والشراء (supplierId)، وتتجاهلها بقية القوائم.
  customerId: z.uuid().optional(),
  supplierId: z.uuid().optional(),
});

export interface PaginatedResult<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/**
 * قائمة مُصفَّحة عامة لأي جدول مستند، بعزل شركة إلزامي عند SQL نفسه (لا فلترة بعد الجلب) وعزل فرع
 * تلقائي عبر ctx.visibleBranchIds() إن كان للجدول عمود branch_id ولم يكن المستخدم all_branches.
 * اسم الجدول دائمًا ثابت نصّي مكتوب من المطوّر داخل الشيفرة عند الاستدعاء (لا يُشتق أبدًا من مدخلات
 * المستخدم)، وnفلتر status الوحيد المسموح من المستخدم يُمرَّر بارامتر مُجهَّز دائمًا (لا تسلسل نصي).
 */
export async function paginatedList<T>(
  ctx: RequestContext,
  table: string,
  opts: {
    page: number; pageSize: number; status?: string; hasBranchColumn?: boolean; orderBy?: string;
    /** فلاتر مساواة إضافية: اسم العمود يُكتَب ثابتًا من المطوّر عند الاستدعاء (لا يُشتق من مدخلات
     * المستخدم أبدًا)، والقيمة وحدها تأتي من المستخدم وتُمرَّر دائمًا بارامترًا مُجهَّزًا. */
    equals?: { column: string; value: string | undefined }[];
  },
): Promise<PaginatedResult<T>> {
  const hasBranchColumn = opts.hasBranchColumn ?? true;
  const visible = ctx.visibleBranchIds();
  const conditions = ['company_id = $1'];
  const params: unknown[] = [ctx.companyId];

  if (hasBranchColumn && visible !== null) {
    params.push(visible);
    conditions.push(`branch_id = ANY($${params.length})`);
  }
  if (opts.status) {
    params.push(opts.status);
    conditions.push(`status = $${params.length}`);
  }
  for (const f of opts.equals ?? []) {
    if (f.value === undefined) continue;
    if (!/^[a-z_]+$/.test(f.column)) throw new Error('اسم عمود فلتر غير صالح');
    params.push(f.value);
    conditions.push(`${f.column} = $${params.length}`);
  }
  const where = conditions.join(' AND ');
  const orderBy = opts.orderBy ?? 'created_at DESC';

  const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM ${table} WHERE ${where}`, params);
  const total = countResult.rows[0].total as number;

  params.push(opts.pageSize, (opts.page - 1) * opts.pageSize);
  const dataResult = await pool.query(
    `SELECT * FROM ${table} WHERE ${where} ORDER BY ${orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return {
    data: dataResult.rows as T[], page: opts.page, pageSize: opts.pageSize, total,
    totalPages: total === 0 ? 0 : Math.ceil(total / opts.pageSize),
  };
}

/** يُستخدَم داخل معالج المسار بعد نجاح validate({query: paginationQuerySchema}) لاستخراج القيم
 * المحوَّلة (page كرقم، إلخ) — لأن req.query في Express 5 عنصر قراءة فقط، فالتحقق في الميدل وير لا
 * يُعيد كتابته، فنُعيد تحليله هنا بأمان (مضمون النجاح لأن الميدل وير سبق أن تحقق من نفس المخطط). */
export function parsePagination(query: Record<string, unknown>) {
  return paginationQuerySchema.parse(query);
}

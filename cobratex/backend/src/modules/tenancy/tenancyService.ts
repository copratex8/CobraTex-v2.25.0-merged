import { assertSeat, tenantOfCompany } from '@/modules/platform/licenseService';
import { PoolClient } from 'pg';
import { pool, withTransaction } from '@/db/pool';
import { NotFoundError } from '@/shared/errors';
import { writeAuditLog } from '@/shared/audit';

export interface CreateCompanyInput {
  tenantId: string;
  legalName: string;
  displayName: string;
  countryCode?: string;
  baseCurrencyCode?: string;
  defaultLanguage?: string;
}

export async function createTenant(name: string) {
  const { rows } = await pool.query(
    `INSERT INTO tenants(name) VALUES ($1) RETURNING id, name, created_at`,
    [name],
  );
  return rows[0];
}

export async function createCompany(input: CreateCompanyInput) {
  const { rows } = await pool.query(
    `INSERT INTO companies(tenant_id, legal_name, display_name, country_code, base_currency_code, default_language)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, tenant_id, legal_name, display_name, country_code, base_currency_code, default_language`,
    [
      input.tenantId,
      input.legalName,
      input.displayName,
      input.countryCode ?? 'EG', // افتراضي أولي قابل للتغيير — راجع REQUIREMENTS.md §2
      input.baseCurrencyCode ?? 'EGP',
      input.defaultLanguage ?? 'ar',
    ],
  );
  return rows[0];
}

export async function createBranch(
  companyId: string,
  nameAr: string,
  nameEn: string,
  client?: PoolClient,
) {
  const tenantId = await tenantOfCompany(companyId);
  if (tenantId) await assertSeat(tenantId, 'branches');
  const runner = client ?? pool;
  const { rows } = await runner.query(
    `INSERT INTO branches(company_id, name_ar, name_en) VALUES ($1,$2,$3)
     RETURNING id, company_id, name_ar, name_en`,
    [companyId, nameAr, nameEn],
  );
  return rows[0];
}

/**
 * تُثبت هذه الدالة بنيويًا استحالة ربط مخزن بفرع من شركة مختلفة: لو مرّرنا companyId لا يطابق
 * الشركة الفعلية لـ branchId، سيفشل الإدراج بخطأ قيد الـ FK المركّب (branch_id, company_id).
 */
export async function createWarehouse(
  branchId: string,
  companyId: string,
  nameAr: string,
  nameEn: string,
) {
  const { rows } = await pool.query(
    `INSERT INTO warehouses(branch_id, company_id, name_ar, name_en) VALUES ($1,$2,$3,$4)
     RETURNING id, branch_id, company_id, name_ar, name_en`,
    [branchId, companyId, nameAr, nameEn],
  );
  return rows[0];
}

export async function getCompanyById(companyId: string) {
  const { rows } = await pool.query(`SELECT * FROM companies WHERE id = $1`, [companyId]);
  if (rows.length === 0) throw new NotFoundError('الشركة غير موجودة');
  return rows[0];
}

/**
 * لا مسار قراءة لبيانات الشركة كان موجودًا إطلاقًا (راجع تعليق migration 0028) — هذه الدالة تُستخدَم
 * الآن من مسار `/company` مباشرة، بصلاحية عرض بدل استدعاء داخلي فقط كما كانت.
 */
export async function getMyCompany(ctx: import('@/shared/requestContext').RequestContext) {
  ctx.assertPermission('tenancy.company.view');
  return getCompanyById(ctx.companyId);
}

/** قائمة كاملة بلا صفحات (عدد الفروع لكل شركة صغير) — لم يكن لها أي مسار قراءة من قبل. */
export async function listBranches(ctx: import('@/shared/requestContext').RequestContext) {
  ctx.assertPermission('tenancy.branch.view');
  const { rows } = await pool.query(
    `SELECT id, company_id, name_ar, name_en, address, is_active FROM branches WHERE company_id = $1 ORDER BY name_ar ASC`,
    [ctx.companyId],
  );
  return rows;
}

/** إعداد أولي كامل (Onboarding): مستأجر + شركة + فرع + مخزن أول، بذرة مصرية افتراضية قابلة للتغيير. */
export async function bootstrapCompany(input: {
  tenantName: string;
  companyLegalName: string;
  companyDisplayName: string;
  firstBranchName: string;
  firstWarehouseName: string;
}) {
  return withTransaction(async (client) => {
    const tenant = await client.query(
      `INSERT INTO tenants(name) VALUES ($1) RETURNING id`,
      [input.tenantName],
    );
    const company = await client.query(
      `INSERT INTO companies(tenant_id, legal_name, display_name)
       VALUES ($1,$2,$3) RETURNING id`,
      [tenant.rows[0].id, input.companyLegalName, input.companyDisplayName],
    );
    const branch = await client.query(
      `INSERT INTO branches(company_id, name_ar, name_en) VALUES ($1,$2,$2) RETURNING id`,
      [company.rows[0].id, input.firstBranchName],
    );
    const warehouse = await client.query(
      `INSERT INTO warehouses(branch_id, company_id, name_ar, name_en) VALUES ($1,$2,$3,$3) RETURNING id`,
      [branch.rows[0].id, company.rows[0].id, input.firstWarehouseName],
    );
    return {
      tenantId: tenant.rows[0].id,
      companyId: company.rows[0].id,
      branchId: branch.rows[0].id,
      warehouseId: warehouse.rows[0].id,
    };
  });
}

/**
 * يضبط حساب فرق العملة (ربح/خسارة) على مستوى الشركة — شرط أساسي لتفعيل فروق العملة في تخصيص
 * الدفعات (راجع customerPaymentService.allocateAdvancePayment / supplierPaymentService المقابلة).
 * حساب واحد فقط لكل الشركة حاليًا (لا فصل ربح عن خسارة) — قرار مبسَّط مقصود لأول تفعيل.
 */
export async function updateFxGainLossAccount(ctx: import('@/shared/requestContext').RequestContext, accountId: string) {
  ctx.assertPermission('company.settings.update');
  const account = await pool.query(`SELECT id FROM accounts WHERE id=$1 AND company_id=$2`, [accountId, ctx.companyId]);
  if (account.rows.length === 0) throw new NotFoundError('الحساب المحدَّد غير موجود ضمن هذه الشركة');
  const { rows } = await pool.query(
    `UPDATE companies SET fx_gain_loss_account_id=$2 WHERE id=$1 RETURNING id, fx_gain_loss_account_id`,
    [ctx.companyId, accountId],
  );
  if (rows.length === 0) throw new NotFoundError('الشركة غير موجودة');
  return rows[0];
}

/**
 * تشغيل/إيقاف وحدة التصنيع لهذه الشركة (بلا حذف أي كود أو بيانات — راجع تعليق migration 0035).
 * الإيقاف يعامل الوحدة كأنها غير موجودة أمام أي طلب API لاحق (manufacturingService.assertManufacturingEnabled)،
 * ويُخفيها من واجهة التنقّل تلقائيًا. أوامر/قوائم مواد سابقة تبقى محفوظة ويمكن قراءتها فور إعادة التفعيل.
 */
export async function updateManufacturingEnabled(ctx: import('@/shared/requestContext').RequestContext, enabled: boolean) {
  ctx.assertPermission('company.settings.update');
  const { rows } = await pool.query(
    `UPDATE companies SET manufacturing_enabled=$2 WHERE id=$1 RETURNING id, manufacturing_enabled`,
    [ctx.companyId, enabled],
  );
  return rows[0];
}

/* ============================== الأنشطة (Activities) ==============================
 * بُعد تصنيفي موجود بنيويًا منذ migration 0001 (activity_id مربوط على حركات المخزون/الجرد/القيود)
 * لكن بلا أي CRUD من قبل. هذا ما يجعل التصنيع (وأي مستند آخر) "يصلح لأي نشاط باختيار النشاط
 * المطلوب" بدل ربط منطق الكود بصناعة بعينها — الشركة تُعرِّف أنشطتها الخاصة هنا (غزل، نسيج، تجميع
 * نوافذ uPVC، أو أي تصنيف آخر) ثم تُصنِّف المستندات عليها اختياريًا. */

export interface CreateActivityInput {
  nameAr: string;
  nameEn: string;
  templateKey?: string;
}

export async function createActivity(ctx: import('@/shared/requestContext').RequestContext, input: CreateActivityInput) {
  ctx.assertPermission('tenancy.activity.create');
  const { rows } = await pool.query(
    `INSERT INTO activities(company_id, name_ar, name_en, template_key) VALUES ($1,$2,$3,$4) RETURNING *`,
    [ctx.companyId, input.nameAr, input.nameEn, input.templateKey ?? 'custom'],
  );
  await writeAuditLog(pool, {
    tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
    entityType: 'activity', entityId: rows[0].id, action: 'create', afterJson: rows[0],
  });
  return rows[0];
}

/** قائمة كاملة بلا صفحات — عدد الأنشطة لكل شركة صغير دائمًا (تصنيف عام، لا سجل معاملات). */
export async function listActivities(ctx: import('@/shared/requestContext').RequestContext) {
  ctx.assertPermission('tenancy.activity.view');
  const { rows } = await pool.query(`SELECT * FROM activities WHERE company_id=$1 ORDER BY name_ar ASC`, [ctx.companyId]);
  return rows;
}

export async function updateActivityStatus(ctx: import('@/shared/requestContext').RequestContext, activityId: string, isActive: boolean) {
  ctx.assertPermission('tenancy.activity.update');
  const { rows } = await pool.query(
    `UPDATE activities SET is_active=$1 WHERE id=$2 AND company_id=$3 RETURNING *`,
    [isActive, activityId, ctx.companyId],
  );
  if (rows.length === 0) throw new NotFoundError('النشاط غير موجود');
  await writeAuditLog(pool, {
    tenantId: ctx.tenantId, companyId: ctx.companyId, userId: ctx.userId,
    entityType: 'activity', entityId: activityId, action: 'update', afterJson: { isActive },
  });
  return rows[0];
}

import { withTransaction } from '@/db/pool';
import { createUser, grantBranchScope, grantOwnerRole } from '@/modules/identity/identityService';

export interface ProvisionInput {
  tenantName: string; companyLegalName: string; companyDisplayName?: string; branchName?: string; warehouseName?: string;
  ownerFullName?: string; ownerEmail: string; ownerPassword: string;
}

/** إنشاء عميل كامل (مستأجر + شركة + فرع + مخزن + دليل حسابات + قواعد ترحيل + مالك). يستخدمه /bootstrap ولوحة المطور. */
export async function provisionTenant(input: ProvisionInput) {
  const { tenantName, companyLegalName, companyDisplayName, branchName, warehouseName, ownerFullName, ownerEmail, ownerPassword } = input;
  const ids = await withTransaction(async (client) => {
    const tenant = await client.query(`INSERT INTO tenants(name) VALUES ($1) RETURNING id`, [tenantName]);
    const company = await client.query(
      `INSERT INTO companies(tenant_id, legal_name, display_name) VALUES ($1,$2,$3) RETURNING id`,
      [tenant.rows[0].id, companyLegalName, companyDisplayName ?? companyLegalName],
    );
    const branch = await client.query(
      `INSERT INTO branches(company_id, name_ar, name_en) VALUES ($1,$2,$2) RETURNING id`,
      [company.rows[0].id, branchName ?? 'الفرع الرئيسي'],
    );
    const warehouse = await client.query(
      `INSERT INTO warehouses(branch_id, company_id, name_ar, name_en) VALUES ($1,$2,$3,$3) RETURNING id`,
      [branch.rows[0].id, company.rows[0].id, warehouseName ?? 'المخزن الرئيسي'],
    );

    // ===== بذرة دليل حسابات + قواعد ترحيل افتراضية (قرار موثَّق في docs/DECISIONS.md لم يكن
    // مُنفَّذًا فعليًا قبل هذه المرحلة — أي شركة جديدة كانت عاجزة عن ترحيل أي مستند إطلاقًا حتى
    // تُعَدّ يدويًا بالكامل عبر استدعاءات API مباشرة). قالب مصري مبسَّط، قابل للتعديل الكامل لاحقًا
    // من الشركة نفسها — هذا حد أدنى تشغيلي، لا قيد نهائي.
    const companyId = company.rows[0].id;
    async function seedAccount(code: string, nameAr: string, nameEn: string, accountType: string) {
      const r = await client.query(
        `INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [companyId, code, nameAr, nameEn, accountType],
      );
      return r.rows[0].id as string;
    }
    const cashAccountId = await seedAccount('1010', 'الخزينة الرئيسية', 'Main Cash', 'asset');
    await seedAccount('1020', 'البنوك', 'Banks', 'asset');
    const inventoryAccountId = await seedAccount('1030', 'المخزون', 'Inventory', 'asset');
    const inputTaxAccountId = await seedAccount('1040', 'ضريبة المشتريات القابلة للخصم', 'Input VAT', 'asset');
    const outputTaxAccountId = await seedAccount('2020', 'ضريبة المبيعات المستحقة', 'Output VAT', 'liability');
    await seedAccount('3000', 'رأس المال', 'Capital', 'equity');
    const revenueAccountId = await seedAccount('4010', 'إيرادات المبيعات', 'Sales Revenue', 'revenue');
    const fxAccountId = await seedAccount('4090', 'فروق العملة', 'FX Gain/Loss', 'revenue');
    const cogsAccountId = await seedAccount('5010', 'تكلفة البضاعة المباعة', 'Cost of Goods Sold', 'expense');
    await seedAccount('5090', 'مصروفات عمومية وإدارية', 'General & Admin Expenses', 'expense');
    const inventoryVarianceAccountId = await seedAccount('5020', 'فروق الجرد', 'Inventory Count Variance', 'expense');
    // حساب تمريري وسيط لأوامر التصنيع (راجع تعليق postProductionOrder في manufacturingService.ts
    // للشرح الكامل لسبب استخدام حساب وسيط بدل قيد مباشر مخزون↔مخزون) — يتصفَّر صافيًا دومًا.
    const manufacturingWipAccountId = await seedAccount('1050', 'تحت التشغيل - التصنيع', 'Manufacturing WIP Clearing', 'asset');
    // حساب تحميل تكاليف التحويل (عمالة/تشغيل) على الإنتاج — رصيده دائن يقابل المصروفات الفعلية المسجَّلة بمستنداتها.
    const manufacturingAbsorptionAccountId = await seedAccount('5030', 'تكاليف تصنيع محمَّلة', 'Manufacturing Costs Absorbed', 'expense');
    // خسائر الهالك غير العادي (ما زاد عن النسبة القياسية للمرحلة) — راجع migration 0039 وtextileCosting.ts.
    const abnormalWasteAccountId = await seedAccount('5040', 'خسائر هالك غير عادي', 'Abnormal Waste Loss', 'expense');

    await client.query(`UPDATE companies SET fx_gain_loss_account_id=$2 WHERE id=$1`, [companyId, fxAccountId]);

    // فئة صنف افتراضية — أي صنف بلا فئة محدَّدة لن تُحسَب له تكلفة بضاعة مباعة عند الترحيل، لذا
    // فئة "عام" الافتراضية جاهزة فورًا لمن لا يحتاج تصنيفًا أدق بعد.
    const defaultCategory = await client.query(
      `INSERT INTO item_categories(company_id, name_ar, name_en, item_kind, default_inventory_account_id, default_cogs_account_id)
       VALUES ($1,'عام','General','generic',$2,$3) RETURNING id`,
      [companyId, inventoryAccountId, cogsAccountId],
    );

    // ضريبة القيمة المضافة الافتراضية 14% — سارية من بداية السنة الميلادية الحالية (تطابق بداية
    // الفترة المالية الافتراضية أدناه)، لا من "اليوم" فقط، حتى لا تُرفَض فواتير بتاريخ سابق لها
    // ضمن نفس السنة المالية بسبب "لا إصدار ضريبة سارٍ بهذا التاريخ".
    const currentYear = new Date().getFullYear();
    const taxType = await client.query(
      `INSERT INTO tax_types(company_id, name_ar, name_en, sales_tax_account_id, purchase_tax_account_id)
       VALUES ($1,'ضريبة القيمة المضافة','VAT',$2,$3) RETURNING id`,
      [companyId, outputTaxAccountId, inputTaxAccountId],
    );
    await client.query(
      `INSERT INTO tax_rates(tax_type_id, company_id, rate_percent, effective_from) VALUES ($1,$2,'14',$3)`,
      [taxType.rows[0].id, companyId, `${currentYear}-01-01`],
    );

    // قواعد الترحيل العشر: 5 لفواتير البيع/الشراء (بضريبة أو بدونها) + 5 لمرتجعاتها (تعكس نفس
    // الاتجاه بالضبط) — كلها لازمة لأي مستند بأصناف من الفئة الافتراضية. غياب قواعد المرتجعات
    // تحديدًا كان فجوة حقيقية اكتُشفت لاحقًا (مرحلة المرتجعات في الواجهة) وسُدَّت هنا رجعيًا.
    async function seedPostingRule(operationType: string, debitType: string, debitFixed: string | null, creditType: string, creditFixed: string | null) {
      await client.query(
        `INSERT INTO posting_rules(company_id, operation_type, debit_account_source_type, debit_fixed_account_id, credit_account_source_type, credit_fixed_account_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [companyId, operationType, debitType, debitFixed, creditType, creditFixed],
      );
    }
    await seedPostingRule('sales_invoice_revenue', 'CUSTOMER_RECEIVABLE', null, 'FIXED_ACCOUNT', revenueAccountId);
    await seedPostingRule('sales_invoice_tax', 'CUSTOMER_RECEIVABLE', null, 'FIXED_ACCOUNT', outputTaxAccountId);
    await seedPostingRule('sales_invoice_cogs', 'ITEM_CATEGORY_COGS', null, 'ITEM_CATEGORY_INVENTORY', null);
    await seedPostingRule('purchase_invoice_inventory', 'ITEM_CATEGORY_INVENTORY', null, 'SUPPLIER_PAYABLE', null);
    await seedPostingRule('purchase_invoice_tax', 'FIXED_ACCOUNT', inputTaxAccountId, 'SUPPLIER_PAYABLE', null);
    // قواعد المرتجعات: تعكس اتجاه القواعد المقابلة للفواتير أعلاه بالضبط (راجع تعليق كل سطر).
    await seedPostingRule('sales_return_revenue', 'FIXED_ACCOUNT', revenueAccountId, 'CUSTOMER_RECEIVABLE', null); // عكس sales_invoice_revenue
    await seedPostingRule('sales_return_tax', 'FIXED_ACCOUNT', outputTaxAccountId, 'CUSTOMER_RECEIVABLE', null); // عكس sales_invoice_tax
    await seedPostingRule('sales_return_cogs', 'ITEM_CATEGORY_INVENTORY', null, 'ITEM_CATEGORY_COGS', null); // عكس sales_invoice_cogs
    await seedPostingRule('purchase_return_inventory', 'SUPPLIER_PAYABLE', null, 'ITEM_CATEGORY_INVENTORY', null); // عكس purchase_invoice_inventory
    await seedPostingRule('purchase_return_tax', 'SUPPLIER_PAYABLE', null, 'FIXED_ACCOUNT', inputTaxAccountId); // عكس purchase_invoice_tax
    // قاعدتا فروق الجرد (راجع migration 0029 للتفاصيل الكاملة والبذرة الرجعية للشركات القائمة):
    await seedPostingRule('inventory_adjustment_increase', 'ITEM_CATEGORY_INVENTORY', null, 'FIXED_ACCOUNT', inventoryVarianceAccountId);
    await seedPostingRule('inventory_adjustment_decrease', 'FIXED_ACCOUNT', inventoryVarianceAccountId, 'ITEM_CATEGORY_INVENTORY', null);
    // قاعدتا التصنيع (راجع migration 0033 وmanufacturingService.ts): حساب تمريري واحد مشترك.
    await seedPostingRule('manufacturing_consume', 'FIXED_ACCOUNT', manufacturingWipAccountId, 'ITEM_CATEGORY_INVENTORY', null);
    await seedPostingRule('manufacturing_output', 'ITEM_CATEGORY_INVENTORY', null, 'FIXED_ACCOUNT', manufacturingWipAccountId);
    await seedPostingRule('manufacturing_conversion', 'ITEM_CATEGORY_INVENTORY', null, 'FIXED_ACCOUNT', manufacturingAbsorptionAccountId);
    await seedPostingRule('manufacturing_waste_recovery', 'ITEM_CATEGORY_INVENTORY', null, 'FIXED_ACCOUNT', manufacturingWipAccountId);
    await seedPostingRule('manufacturing_abnormal_loss', 'FIXED_ACCOUNT', abnormalWasteAccountId, 'FIXED_ACCOUNT', manufacturingWipAccountId);
    // مراحل الغزل والنسيج وأنواع الهالك الشائعة (قيم قياسية قابلة للتعديل من الإعدادات).
    await client.query('SELECT seed_textile_defaults($1)', [companyId]);
    await client.query('SELECT seed_textile_quality_defaults($1)', [companyId]);

    // فترة مالية افتراضية: السنة الميلادية الحالية (يناير–ديسمبر)، قابلة للتغيير من الشركة لاحقًا.
    const fiscalPeriod = await client.query(
      `INSERT INTO fiscal_periods(company_id, start_date, end_date) VALUES ($1,$2,$3) RETURNING id`,
      [companyId, `${currentYear}-01-01`, `${currentYear}-12-31`],
    );

    // خزينة نقدية افتراضية مرتبطة بحساب 1010 — تُتيح تسجيل دفعات/سندات فورًا بلا إعداد إضافي.
    const safe = await client.query(
      `INSERT INTO safe_or_banks(company_id, branch_id, code, name_ar, name_en, kind, linked_account_id, currency_code)
       VALUES ($1,$2,'SAFE-001','الخزينة الرئيسية','Main Safe','safe',$3,'EGP') RETURNING id`,
      [companyId, branch.rows[0].id, cashAccountId],
    );

    return {
      tenantId: tenant.rows[0].id,
      companyId,
      branchId: branch.rows[0].id,
      warehouseId: warehouse.rows[0].id,
      defaultItemCategoryId: defaultCategory.rows[0].id,
      defaultFiscalPeriodId: fiscalPeriod.rows[0].id,
      defaultTaxTypeId: taxType.rows[0].id,
      defaultSafeId: safe.rows[0].id,
    };
  });

  const owner = await createUser({
    tenantId: ids.tenantId,
    companyId: ids.companyId,
    fullName: ownerFullName ?? 'مدير النظام',
    email: ownerEmail,
    password: ownerPassword,
  });
  await grantBranchScope(owner.id, ids.branchId, ids.companyId, 'all');
  await grantOwnerRole(owner.id, ids.companyId); // يمنح كل الصلاحيات المُسجَّلة بنطاق all_branches
  return { ...ids, ownerUserId: owner.id };
}

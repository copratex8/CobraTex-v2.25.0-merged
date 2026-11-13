-- 0001_core_tenancy.sql
-- المستأجر والهيكل التنظيمي: Tenant -> Company -> (Activity/Project/Branch) -> Warehouse
-- كل جدول تابع لشركة يحمل UNIQUE(id, company_id) ليُستخدم كهدف لمفاتيح مركبة تمنع
-- ربط سجل بكيان تابع لشركة أخرى بنيويًا (وليس فقط عبر منطق التطبيق).

CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  legal_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  country_code TEXT NOT NULL DEFAULT 'EG',
  base_currency_code TEXT NOT NULL DEFAULT 'EGP',
  default_language TEXT NOT NULL DEFAULT 'ar',
  number_format_locale TEXT NOT NULL DEFAULT 'ar-EG',
  fiscal_year_start_month INT NOT NULL DEFAULT 1,
  logo_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);

CREATE TABLE activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  template_key TEXT NOT NULL DEFAULT 'custom',
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (id, company_id)
);

CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (id, company_id)
);

CREATE TABLE branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  address TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id)
);

CREATE TABLE warehouses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id UUID NOT NULL,
  company_id UUID NOT NULL,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (id, company_id),
  -- مفتاح مركّب: يمنع بنيويًا ربط مخزن بفرع تابع لشركة أخرى
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id)
);

CREATE INDEX idx_branches_company ON branches(company_id);
CREATE INDEX idx_warehouses_branch ON warehouses(branch_id, company_id);

-- 0011_customers_suppliers.sql
-- وحدتا العملاء والموردين. كل عميل/مورد يُربط بحساب فرعي (Sub-ledger Account) يُنشأ مرة واحدة
-- فقط ضمن نفس معاملة إنشاء العميل/المورد (atomic) — فشل أي طرف يُرجع الطرفين معًا (لا حساب يتيم).

CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  tax_number TEXT,
  credit_limit NUMERIC(18,4) NOT NULL DEFAULT 0,
  payment_term_days INT NOT NULL DEFAULT 0,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  linked_account_id UUID NOT NULL,
  branch_id UUID, -- nullable: عميل عام لكل فروع الشركة إن لم يُحدَّد فرع
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, code),
  FOREIGN KEY (linked_account_id, company_id) REFERENCES accounts (id, company_id),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE TABLE suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  tax_number TEXT,
  payment_term_days INT NOT NULL DEFAULT 0,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  linked_account_id UUID NOT NULL,
  branch_id UUID,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  is_blocked BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, code),
  FOREIGN KEY (linked_account_id, company_id) REFERENCES accounts (id, company_id),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- بذرة صلاحيات العملاء والموردين
INSERT INTO permissions(code) VALUES
  ('sales.customer.create'),
  ('sales.customer.view'),
  ('purchasing.supplier.create'),
  ('purchasing.supplier.view')
ON CONFLICT (code) DO NOTHING;

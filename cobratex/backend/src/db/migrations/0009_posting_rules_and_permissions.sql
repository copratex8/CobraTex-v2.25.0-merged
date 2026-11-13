-- 0009_posting_rules_and_permissions.sql

-- محرك الترحيل القابل للتهيئة (Typed، لا JSON حر) — راجع ARCHITECTURE.md §7
CREATE TABLE posting_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  operation_type TEXT NOT NULL, -- مثال: sales_invoice_revenue, sales_invoice_cogs, purchase_invoice_inventory
  debit_account_source_type TEXT NOT NULL CHECK (debit_account_source_type IN
    ('FIXED_ACCOUNT','CUSTOMER_RECEIVABLE','SUPPLIER_PAYABLE','ITEM_CATEGORY_INVENTORY',
     'ITEM_CATEGORY_COGS','TAX_ACCOUNT','BANK_SAFE_ACCOUNT','COST_CENTER_DEFAULT')),
  debit_fixed_account_id UUID,
  credit_account_source_type TEXT NOT NULL CHECK (credit_account_source_type IN
    ('FIXED_ACCOUNT','CUSTOMER_RECEIVABLE','SUPPLIER_PAYABLE','ITEM_CATEGORY_INVENTORY',
     'ITEM_CATEGORY_COGS','TAX_ACCOUNT','BANK_SAFE_ACCOUNT','COST_CENTER_DEFAULT')),
  credit_fixed_account_id UUID,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- قاعدة ناقصة: FIXED_ACCOUNT بلا معرّف حساب ثابت مرفوضة بنيويًا
  CHECK (debit_account_source_type <> 'FIXED_ACCOUNT' OR debit_fixed_account_id IS NOT NULL),
  CHECK (credit_account_source_type <> 'FIXED_ACCOUNT' OR credit_fixed_account_id IS NOT NULL),
  FOREIGN KEY (debit_fixed_account_id, company_id) REFERENCES accounts (id, company_id),
  FOREIGN KEY (credit_fixed_account_id, company_id) REFERENCES accounts (id, company_id)
);
-- قاعدة متعارضة: لا يمكن وجود قاعدتين نشطتين لنفس العملية في نفس الشركة (فهرس جزئي)
CREATE UNIQUE INDEX uq_posting_rule_active_per_operation
  ON posting_rules(company_id, operation_type) WHERE is_active = true;

-- حسابات افتراضية على مستوى مجموعة الصنف، تُستخدم عند account_source_type = ITEM_CATEGORY_*
ALTER TABLE item_categories ADD COLUMN default_inventory_account_id UUID;
ALTER TABLE item_categories ADD COLUMN default_cogs_account_id UUID;
ALTER TABLE item_categories
  ADD FOREIGN KEY (default_inventory_account_id, company_id) REFERENCES accounts (id, company_id);
ALTER TABLE item_categories
  ADD FOREIGN KEY (default_cogs_account_id, company_id) REFERENCES accounts (id, company_id);

-- بذرة صلاحيات أساسية (يُضاف إليها لاحقًا مع كل وحدة جديدة)
INSERT INTO permissions(code) VALUES
  ('items.item.create'),
  ('items.category.create'),
  ('inventory.movement.post'),
  ('inventory.balance.rebuild'),
  ('accounting.account.create'),
  ('accounting.fiscal_period.create'),
  ('accounting.journal.create'),
  ('accounting.journal.submit'),
  ('accounting.journal.approve'),
  ('accounting.journal.reject'),
  ('accounting.journal.post'),
  ('accounting.journal.reverse'),
  ('accounting.journal.cancel'),
  ('accounting.posting_rule.manage'),
  ('sales.invoice.create')  -- محجوزة لمرحلة المبيعات القادمة؛ مذكورة صراحة في متطلبات هذه المرحلة كمثال RBAC
ON CONFLICT (code) DO NOTHING;

-- توسيع القيم المسموحة لعمود action في سجل التدقيق لتغطية دورة حياة المستند الكاملة
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_action_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_check CHECK (
  action IN ('create','update','delete','submit','approve','reject','post','reverse','cancel','send_back','login','login_failed')
);

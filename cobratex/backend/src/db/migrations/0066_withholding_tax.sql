-- 0066_withholding_tax.sql — ضريبة الخصم والإضافة (الخصم تحت حساب الضريبة) — 2.17.0.
-- لا تعديل في خدمات الدفع: الخصم يُنفَّذ كدفعة نظامية من/إلى حساب ضريبة الخصم فتبقى تخصيصات الفواتير سليمة.
CREATE TABLE wht_settings (
  company_id UUID PRIMARY KEY REFERENCES companies(id),
  is_enabled BOOLEAN NOT NULL DEFAULT false,
  payable_account_id UUID,      -- التزام: ضريبة خصم مستحقة للمصلحة (نخصمها من الموردين)
  receivable_account_id UUID,   -- أصل: ضريبة خصم مدينة (يخصمها عملاؤنا منا)
  exempt_threshold NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (exempt_threshold >= 0), -- لا خصم إن قلّ وعاء العملية عنه
  base_includes_vat BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (payable_account_id, company_id) REFERENCES accounts (id, company_id),
  FOREIGN KEY (receivable_account_id, company_id) REFERENCES accounts (id, company_id)
);
CREATE TABLE wht_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL, name_ar TEXT NOT NULL,
  rate_percent NUMERIC(6,3) NOT NULL CHECK (rate_percent > 0 AND rate_percent <= 100),
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (company_id, code), UNIQUE (id, company_id)
);
CREATE TABLE wht_deductions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('payable','receivable')), -- payable = نخصم من مورد، receivable = يخصم منا عميل
  supplier_invoice_id UUID REFERENCES supplier_invoices(id),
  sales_invoice_id UUID REFERENCES sales_invoices(id),
  party_id UUID NOT NULL,
  category_id UUID NOT NULL, category_code TEXT NOT NULL,
  rate_percent NUMERIC(6,3) NOT NULL,
  base_amount NUMERIC(18,4) NOT NULL, wht_amount NUMERIC(18,4) NOT NULL CHECK (wht_amount > 0),
  currency_code TEXT NOT NULL,
  deduction_date DATE NOT NULL, certificate_no TEXT,
  payment_id UUID NOT NULL, -- supplier_payments.id أو customer_payments.id حسب الاتجاه
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  reverse_reason TEXT, reversed_at TIMESTAMPTZ,
  remitted_at DATE, remittance_entry_id UUID REFERENCES journal_entries(id), -- سداد للمصلحة (payable فقط)
  created_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (category_id, company_id) REFERENCES wht_categories (id, company_id),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  CHECK ((direction='payable' AND supplier_invoice_id IS NOT NULL AND sales_invoice_id IS NULL) OR (direction='receivable' AND sales_invoice_id IS NOT NULL AND supplier_invoice_id IS NULL)),
  CHECK (status <> 'reversed' OR reverse_reason IS NOT NULL)
);
CREATE UNIQUE INDEX uq_wht_active_supplier_inv ON wht_deductions(supplier_invoice_id) WHERE status='posted' AND supplier_invoice_id IS NOT NULL;
CREATE UNIQUE INDEX uq_wht_active_sales_inv ON wht_deductions(sales_invoice_id) WHERE status='posted' AND sales_invoice_id IS NOT NULL;
CREATE INDEX idx_wht_period ON wht_deductions(company_id, direction, deduction_date);
ALTER TABLE wht_settings ENABLE ROW LEVEL SECURITY; ALTER TABLE wht_categories ENABLE ROW LEVEL SECURITY; ALTER TABLE wht_deductions ENABLE ROW LEVEL SECURITY;
INSERT INTO permissions(code) VALUES ('wht.view'), ('wht.settings'), ('wht.apply'), ('wht.reverse'), ('wht.remit') ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_id, permission_id, scope)
SELECT r.id, p.id, 'all_branches' FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Owner' AND r.is_system_role = TRUE AND p.code IN ('wht.view','wht.settings','wht.apply','wht.reverse','wht.remit')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- 0016_payments.sql
-- الدفعات/التحصيلات مع تخصيص لكل فاتورة (PaymentAllocation) — لا تخفيض إجمالي لرصيد العميل/المورد
-- بلا معرفة أي الفواتير سُدِّدت. يُحجَز التخصيص عند الإنشاء (حتى بحالة draft) عبر قفل صف رأس
-- الفاتورة، بنفس نمط منع الفوترة الزائدة المستخدم في supplier_invoice_lines.

CREATE TABLE customer_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  branch_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  fiscal_period_id UUID NOT NULL,
  document_number TEXT NOT NULL,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  exchange_rate NUMERIC(18,6) NOT NULL DEFAULT 1,
  payment_date DATE NOT NULL,
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  receipt_account_id UUID NOT NULL, -- حساب الخزينة/البنك المستلِم (مدين)
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled','reversed')),
  journal_entry_id UUID REFERENCES journal_entries(id),
  reversal_of_payment_id UUID REFERENCES customer_payments(id),
  cancelled_reason TEXT,
  cancelled_by UUID,
  cancelled_at TIMESTAMPTZ,
  created_by UUID,
  posted_by UUID,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, branch_id, document_number),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (customer_id, company_id) REFERENCES customers (id, company_id),
  FOREIGN KEY (fiscal_period_id, company_id) REFERENCES fiscal_periods (id, company_id),
  FOREIGN KEY (receipt_account_id, company_id) REFERENCES accounts (id, company_id)
);

CREATE TABLE customer_payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  customer_payment_id UUID NOT NULL REFERENCES customer_payments(id),
  sales_invoice_id UUID NOT NULL REFERENCES sales_invoices(id),
  allocated_amount NUMERIC(18,4) NOT NULL CHECK (allocated_amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_payment_id, sales_invoice_id)
);
CREATE INDEX idx_cust_pay_alloc_invoice ON customer_payment_allocations(sales_invoice_id);

CREATE TABLE supplier_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  branch_id UUID NOT NULL,
  supplier_id UUID NOT NULL,
  fiscal_period_id UUID NOT NULL,
  document_number TEXT NOT NULL,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  exchange_rate NUMERIC(18,6) NOT NULL DEFAULT 1,
  payment_date DATE NOT NULL,
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  payment_account_id UUID NOT NULL, -- حساب الخزينة/البنك الدافع (دائن)
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled','reversed')),
  journal_entry_id UUID REFERENCES journal_entries(id),
  reversal_of_payment_id UUID REFERENCES supplier_payments(id),
  cancelled_reason TEXT,
  cancelled_by UUID,
  cancelled_at TIMESTAMPTZ,
  created_by UUID,
  posted_by UUID,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, branch_id, document_number),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (supplier_id, company_id) REFERENCES suppliers (id, company_id),
  FOREIGN KEY (fiscal_period_id, company_id) REFERENCES fiscal_periods (id, company_id),
  FOREIGN KEY (payment_account_id, company_id) REFERENCES accounts (id, company_id)
);

CREATE TABLE supplier_payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  supplier_payment_id UUID NOT NULL REFERENCES supplier_payments(id),
  supplier_invoice_id UUID NOT NULL REFERENCES supplier_invoices(id),
  allocated_amount NUMERIC(18,4) NOT NULL CHECK (allocated_amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (supplier_payment_id, supplier_invoice_id)
);
CREATE INDEX idx_supp_pay_alloc_invoice ON supplier_payment_allocations(supplier_invoice_id);

INSERT INTO permissions(code) VALUES
  ('sales.payment.create'), ('sales.payment.view'), ('sales.payment.post'), ('sales.payment.reverse'),
  ('purchasing.payment.create'), ('purchasing.payment.view'), ('purchasing.payment.post'), ('purchasing.payment.reverse')
ON CONFLICT (code) DO NOTHING;

-- 0017_returns.sql
-- مرتجعات جزئية مستقلة (لا عكس فاتورة كاملة): كل سطر مرتجع يشير لسطر الفاتورة الأصلي، ويُحجَز
-- عند الإنشاء (returned_quantity على سطر الفاتورة الأصلي) بنفس نمط منع الفوترة الزائدة المستخدم
-- سابقًا في supplier_invoice_lines.invoiced_quantity — يمنع إرجاع كمية أكبر من المباعة/المفوترة.

ALTER TABLE sales_invoice_lines ADD COLUMN returned_quantity NUMERIC(18,4) NOT NULL DEFAULT 0;
ALTER TABLE supplier_invoice_lines ADD COLUMN returned_quantity NUMERIC(18,4) NOT NULL DEFAULT 0;

CREATE TABLE sales_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  branch_id UUID NOT NULL,
  warehouse_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  sales_invoice_id UUID NOT NULL REFERENCES sales_invoices(id),
  fiscal_period_id UUID NOT NULL,
  document_number TEXT NOT NULL,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  exchange_rate NUMERIC(18,6) NOT NULL DEFAULT 1,
  return_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled','reversed')),
  journal_entry_id UUID REFERENCES journal_entries(id),
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
  FOREIGN KEY (warehouse_id, company_id) REFERENCES warehouses (id, company_id),
  FOREIGN KEY (customer_id, company_id) REFERENCES customers (id, company_id),
  FOREIGN KEY (fiscal_period_id, company_id) REFERENCES fiscal_periods (id, company_id)
);

CREATE TABLE sales_return_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_return_id UUID NOT NULL REFERENCES sales_returns(id),
  company_id UUID NOT NULL,
  sales_invoice_line_id UUID NOT NULL REFERENCES sales_invoice_lines(id),
  item_id UUID NOT NULL,
  quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  subtotal NUMERIC(18,4) NOT NULL,
  tax_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
  line_total NUMERIC(18,4) NOT NULL,
  cost_of_goods NUMERIC(18,4) NOT NULL,
  stock_movement_id UUID
);

CREATE TABLE purchase_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  branch_id UUID NOT NULL,
  warehouse_id UUID NOT NULL,
  supplier_id UUID NOT NULL,
  supplier_invoice_id UUID NOT NULL REFERENCES supplier_invoices(id),
  fiscal_period_id UUID NOT NULL,
  document_number TEXT NOT NULL,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  exchange_rate NUMERIC(18,6) NOT NULL DEFAULT 1,
  return_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled','reversed')),
  journal_entry_id UUID REFERENCES journal_entries(id),
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
  FOREIGN KEY (warehouse_id, company_id) REFERENCES warehouses (id, company_id),
  FOREIGN KEY (supplier_id, company_id) REFERENCES suppliers (id, company_id),
  FOREIGN KEY (fiscal_period_id, company_id) REFERENCES fiscal_periods (id, company_id)
);

CREATE TABLE purchase_return_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_return_id UUID NOT NULL REFERENCES purchase_returns(id),
  company_id UUID NOT NULL,
  supplier_invoice_line_id UUID NOT NULL REFERENCES supplier_invoice_lines(id),
  item_id UUID NOT NULL,
  quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  unit_cost NUMERIC(18,4) NOT NULL,
  subtotal NUMERIC(18,4) NOT NULL,
  tax_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
  line_total NUMERIC(18,4) NOT NULL,
  stock_movement_id UUID
);

INSERT INTO permissions(code) VALUES
  ('sales.return.create'), ('sales.return.view'), ('sales.return.post'), ('sales.return.reverse'),
  ('purchasing.return.create'), ('purchasing.return.view'), ('purchasing.return.post'), ('purchasing.return.reverse')
ON CONFLICT (code) DO NOTHING;

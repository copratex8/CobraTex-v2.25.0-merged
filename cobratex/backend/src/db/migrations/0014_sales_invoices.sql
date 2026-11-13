-- 0014_sales_invoices.sql

CREATE TABLE sales_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  branch_id UUID NOT NULL,
  warehouse_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  sales_order_id UUID REFERENCES sales_orders(id),
  fiscal_period_id UUID NOT NULL,
  document_number TEXT NOT NULL,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  exchange_rate NUMERIC(18,6) NOT NULL DEFAULT 1,
  invoice_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled','reversed')),
  journal_entry_id UUID REFERENCES journal_entries(id),
  reversal_of_invoice_id UUID REFERENCES sales_invoices(id),
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

CREATE TABLE sales_invoice_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_invoice_id UUID NOT NULL REFERENCES sales_invoices(id),
  company_id UUID NOT NULL,
  item_id UUID NOT NULL,
  uom_id UUID NOT NULL,
  quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(18,4) NOT NULL CHECK (unit_price >= 0),
  discount_percent NUMERIC(6,3) NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
  tax_type_id UUID,
  subtotal NUMERIC(18,4) NOT NULL,
  tax_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
  line_total NUMERIC(18,4) NOT NULL,
  cost_of_goods NUMERIC(18,4), -- يُملأ عند الترحيل من نتيجة recordOutMovement (المتوسط المرجح وقت البيع)
  stock_movement_id UUID, -- يُربط عند الترحيل
  FOREIGN KEY (item_id, company_id) REFERENCES items (id, company_id),
  FOREIGN KEY (uom_id, company_id) REFERENCES uoms (id, company_id),
  FOREIGN KEY (tax_type_id, company_id) REFERENCES tax_types (id, company_id)
);

INSERT INTO permissions(code) VALUES
  ('sales.invoice.create'), ('sales.invoice.view'), ('sales.invoice.post'),
  ('sales.invoice.cancel'), ('sales.invoice.reverse')
ON CONFLICT (code) DO NOTHING;

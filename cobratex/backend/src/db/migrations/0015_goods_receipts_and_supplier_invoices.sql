-- 0015_goods_receipts_and_supplier_invoices.sql
-- الفصل المطلوب: الاستلام يُنشئ حركة مخزون فقط (لا قيد)؛ فاتورة المورد تُنشئ القيد فقط
-- (لا حركة مخزون جديدة)، وتتحقق أن الكمية المفوترة لا تتجاوز الكمية المستلمة غير المفوترة بعد.

CREATE TABLE goods_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  branch_id UUID NOT NULL,
  warehouse_id UUID NOT NULL,
  supplier_id UUID NOT NULL,
  purchase_order_id UUID REFERENCES purchase_orders(id),
  document_number TEXT NOT NULL,
  receipt_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled')),
  created_by UUID,
  posted_by UUID,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, branch_id, document_number),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (warehouse_id, company_id) REFERENCES warehouses (id, company_id),
  FOREIGN KEY (supplier_id, company_id) REFERENCES suppliers (id, company_id)
);

CREATE TABLE goods_receipt_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  goods_receipt_id UUID NOT NULL REFERENCES goods_receipts(id),
  company_id UUID NOT NULL,
  item_id UUID NOT NULL,
  uom_id UUID NOT NULL,
  purchase_order_line_id UUID REFERENCES purchase_order_lines(id),
  quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  unit_cost NUMERIC(18,4) NOT NULL CHECK (unit_cost >= 0),
  invoiced_quantity NUMERIC(18,4) NOT NULL DEFAULT 0, -- تُحدَّث من فاتورة المورد لمنع التكرار
  stock_movement_id UUID, -- يُربط عند ترحيل الاستلام
  FOREIGN KEY (item_id, company_id) REFERENCES items (id, company_id),
  FOREIGN KEY (uom_id, company_id) REFERENCES uoms (id, company_id)
);

CREATE TABLE supplier_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  branch_id UUID NOT NULL,
  supplier_id UUID NOT NULL,
  fiscal_period_id UUID NOT NULL,
  document_number TEXT NOT NULL,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  exchange_rate NUMERIC(18,6) NOT NULL DEFAULT 1,
  invoice_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled','reversed')),
  journal_entry_id UUID REFERENCES journal_entries(id),
  reversal_of_invoice_id UUID REFERENCES supplier_invoices(id),
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
  FOREIGN KEY (fiscal_period_id, company_id) REFERENCES fiscal_periods (id, company_id)
);

CREATE TABLE supplier_invoice_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_invoice_id UUID NOT NULL REFERENCES supplier_invoices(id),
  company_id UUID NOT NULL,
  goods_receipt_line_id UUID NOT NULL REFERENCES goods_receipt_lines(id), -- إلزامي: لا فاتورة بلا استلام مرتبط
  item_id UUID NOT NULL,
  quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  unit_cost NUMERIC(18,4) NOT NULL CHECK (unit_cost >= 0),
  tax_type_id UUID,
  subtotal NUMERIC(18,4) NOT NULL,
  tax_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
  line_total NUMERIC(18,4) NOT NULL,
  FOREIGN KEY (item_id, company_id) REFERENCES items (id, company_id),
  FOREIGN KEY (tax_type_id, company_id) REFERENCES tax_types (id, company_id)
);

INSERT INTO permissions(code) VALUES
  ('purchasing.receipt.create'), ('purchasing.receipt.view'), ('purchasing.receipt.post'),
  ('purchasing.invoice.create'), ('purchasing.invoice.view'), ('purchasing.invoice.post'),
  ('purchasing.invoice.cancel'), ('purchasing.invoice.reverse')
ON CONFLICT (code) DO NOTHING;

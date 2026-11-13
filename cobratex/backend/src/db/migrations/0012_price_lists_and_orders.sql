-- 0012_price_lists_and_orders.sql
-- عروض الأسعار وأوامر البيع/الشراء هنا لا تُنتج قيدًا محاسبيًا ولا حركة مخزون على الإطلاق —
-- الأثر المالي/المخزني يبدأ فقط من الاستلام (مخزون) وفاتورة المورد (التزام) وفاتورة البيع
-- (مخزون+قيد)، التي تُبنى في مرحلة لاحقة منفصلة.

CREATE TABLE price_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  is_default BOOLEAN NOT NULL DEFAULT false,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (id, company_id),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
-- قائمة افتراضية واحدة فقط لكل شركة
CREATE UNIQUE INDEX uq_price_list_default_per_company ON price_lists(company_id) WHERE is_default = true;

CREATE TABLE price_list_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  price_list_id UUID NOT NULL,
  company_id UUID NOT NULL,
  item_id UUID NOT NULL,
  uom_id UUID,
  min_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  unit_price NUMERIC(18,4) NOT NULL CHECK (unit_price >= 0),
  UNIQUE (price_list_id, item_id, min_quantity),
  FOREIGN KEY (price_list_id, company_id) REFERENCES price_lists (id, company_id),
  FOREIGN KEY (item_id, company_id) REFERENCES items (id, company_id),
  FOREIGN KEY (uom_id, company_id) REFERENCES uoms (id, company_id)
);

-- ربط العميل بقائمة أسعار مخصصة (اختياري؛ إن غاب يُستخدم افتراضي الشركة)
ALTER TABLE customers ADD COLUMN price_list_id UUID;
ALTER TABLE customers ADD FOREIGN KEY (price_list_id, company_id) REFERENCES price_lists (id, company_id);

/* ============================== عروض الأسعار ============================== */
CREATE TABLE quotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  branch_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  document_number TEXT NOT NULL,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  quotation_date DATE NOT NULL,
  valid_until DATE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','rejected','expired','cancelled')),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, branch_id, document_number),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (customer_id, company_id) REFERENCES customers (id, company_id)
);

CREATE TABLE quotation_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id UUID NOT NULL REFERENCES quotations(id),
  company_id UUID NOT NULL,
  item_id UUID NOT NULL,
  uom_id UUID NOT NULL,
  quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(18,4) NOT NULL CHECK (unit_price >= 0),
  discount_percent NUMERIC(6,3) NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
  FOREIGN KEY (item_id, company_id) REFERENCES items (id, company_id),
  FOREIGN KEY (uom_id, company_id) REFERENCES uoms (id, company_id)
);

/* ============================== أوامر البيع (بلا أثر مالي/مخزني) ============================== */
CREATE TABLE sales_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  branch_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  document_number TEXT NOT NULL,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  order_date DATE NOT NULL,
  source_quotation_id UUID REFERENCES quotations(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','cancelled','invoiced')),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, branch_id, document_number),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (customer_id, company_id) REFERENCES customers (id, company_id)
);

CREATE TABLE sales_order_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id UUID NOT NULL REFERENCES sales_orders(id),
  company_id UUID NOT NULL,
  item_id UUID NOT NULL,
  uom_id UUID NOT NULL,
  quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(18,4) NOT NULL CHECK (unit_price >= 0),
  discount_percent NUMERIC(6,3) NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
  invoiced_quantity NUMERIC(18,4) NOT NULL DEFAULT 0, -- تُحدَّث لاحقًا من مرحلة الفاتورة، ليست أثرًا ماليًا بحد ذاتها
  FOREIGN KEY (item_id, company_id) REFERENCES items (id, company_id),
  FOREIGN KEY (uom_id, company_id) REFERENCES uoms (id, company_id)
);

/* ============================== أوامر الشراء (بلا أثر مالي/مخزني) ============================== */
CREATE TABLE purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  branch_id UUID NOT NULL,
  supplier_id UUID NOT NULL,
  document_number TEXT NOT NULL,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  order_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','cancelled','received')),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, branch_id, document_number),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (supplier_id, company_id) REFERENCES suppliers (id, company_id)
);

CREATE TABLE purchase_order_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id),
  company_id UUID NOT NULL,
  item_id UUID NOT NULL,
  uom_id UUID NOT NULL,
  quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(18,4) NOT NULL CHECK (unit_price >= 0),
  received_quantity NUMERIC(18,4) NOT NULL DEFAULT 0, -- تُحدَّث من مرحلة الاستلام لاحقًا
  FOREIGN KEY (item_id, company_id) REFERENCES items (id, company_id),
  FOREIGN KEY (uom_id, company_id) REFERENCES uoms (id, company_id)
);

INSERT INTO permissions(code) VALUES
  ('sales.pricelist.manage'),
  ('sales.quotation.create'), ('sales.quotation.view'), ('sales.quotation.transition'),
  ('sales.order.create'), ('sales.order.view'), ('sales.order.transition'),
  ('purchasing.order.create'), ('purchasing.order.view'), ('purchasing.order.transition')
ON CONFLICT (code) DO NOTHING;

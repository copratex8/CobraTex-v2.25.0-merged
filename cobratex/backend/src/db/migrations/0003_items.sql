-- 0003_items.sql

CREATE TABLE item_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  activity_id UUID,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('raw_material','fabric','thread','finished_good','generic')),
  parent_id UUID,
  UNIQUE (id, company_id),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (activity_id, company_id) REFERENCES activities (id, company_id)
);

CREATE TABLE uoms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  symbol TEXT NOT NULL,
  UNIQUE (id, company_id),
  UNIQUE (company_id, symbol)
);

CREATE TABLE uom_conversions (
  from_uom_id UUID NOT NULL REFERENCES uoms(id),
  to_uom_id UUID NOT NULL REFERENCES uoms(id),
  factor NUMERIC(18,6) NOT NULL CHECK (factor > 0),
  PRIMARY KEY (from_uom_id, to_uom_id)
);

CREATE TABLE colors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  name_ar TEXT NOT NULL, name_en TEXT NOT NULL, code TEXT NOT NULL,
  UNIQUE (id, company_id), UNIQUE (company_id, code)
);

CREATE TABLE sizes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  name_ar TEXT NOT NULL, name_en TEXT NOT NULL, code TEXT NOT NULL,
  UNIQUE (id, company_id), UNIQUE (company_id, code)
);

CREATE TABLE materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  name_ar TEXT NOT NULL, name_en TEXT NOT NULL, code TEXT NOT NULL,
  UNIQUE (id, company_id), UNIQUE (company_id, code)
);

CREATE TABLE items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  activity_id UUID,
  category_id UUID,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('raw_material','fabric','thread','finished_good','generic')),
  code TEXT NOT NULL,
  barcode TEXT,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  base_uom_id UUID NOT NULL,
  color_id UUID,
  size_id UUID,
  material_id UUID,
  is_batch_tracked BOOLEAN NOT NULL DEFAULT false,
  is_serial_tracked BOOLEAN NOT NULL DEFAULT false,
  reorder_point NUMERIC(18,4) NOT NULL DEFAULT 0,
  reorder_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  standard_cost NUMERIC(18,4),
  image_url TEXT,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, code),
  FOREIGN KEY (activity_id, company_id) REFERENCES activities (id, company_id),
  FOREIGN KEY (category_id, company_id) REFERENCES item_categories (id, company_id),
  FOREIGN KEY (base_uom_id, company_id) REFERENCES uoms (id, company_id),
  FOREIGN KEY (color_id, company_id) REFERENCES colors (id, company_id),
  FOREIGN KEY (size_id, company_id) REFERENCES sizes (id, company_id),
  FOREIGN KEY (material_id, company_id) REFERENCES materials (id, company_id)
);
-- باركود فريد داخل الشركة فقط عند وجوده (فهرس جزئي، وليس Unique تقليدي)
CREATE UNIQUE INDEX uq_items_company_barcode ON items(company_id, barcode) WHERE barcode IS NOT NULL;

CREATE TABLE batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  item_id UUID NOT NULL,
  batch_no TEXT NOT NULL,
  production_date DATE,
  expiry_date DATE,
  supplier_id UUID,
  custom_attrs JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (id, company_id),
  UNIQUE (company_id, item_id, batch_no),
  FOREIGN KEY (item_id, company_id) REFERENCES items (id, company_id)
);

CREATE INDEX idx_items_company_kind ON items(company_id, item_kind);

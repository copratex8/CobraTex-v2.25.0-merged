-- 0046_textile_defects_knit_delivery.sql
-- (١) كتالوج عيوب القماش + تسجيل العيوب بالنوع في فحص الرول (نظام 4 نقاط).
-- (٢) مواصفات الترايكو (قطر/جيج/طول الغرزة/إبر/مغذّيات/تركيب).
-- (٣) إذن تسليم (بوليصة تعبئة) يربط وحدات التعبئة ورولات القماش بعميل ويُخرجها من المخزون الجاهز.
-- أعمدة وجداول إضافية فقط؛ لا يمسّ الترحيل المالي ولا المخزني.

CREATE TABLE textile_defect_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('warp','weft','knit','dye','finish','yarn','other')),
  points SMALLINT NOT NULL CHECK (points BETWEEN 1 AND 4),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (company_id, code),
  UNIQUE (id, company_id)
);
CREATE TABLE fabric_roll_defects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  roll_id UUID NOT NULL REFERENCES fabric_rolls(id) ON DELETE CASCADE,
  defect_type_id UUID NOT NULL,
  occurrences INT NOT NULL CHECK (occurrences > 0),
  points_each SMALLINT NOT NULL CHECK (points_each BETWEEN 1 AND 4),  -- نسخة وقت الفحص (ثبات تاريخي)
  position_m NUMERIC(10,2),
  FOREIGN KEY (defect_type_id, company_id) REFERENCES textile_defect_types (id, company_id)
);
CREATE INDEX idx_roll_defects_roll ON fabric_roll_defects(roll_id);
CREATE INDEX idx_roll_defects_type ON fabric_roll_defects(company_id, defect_type_id);

ALTER TABLE item_textile_specs
  ADD COLUMN knit_structure TEXT CHECK (knit_structure IN ('single_jersey','rib','interlock','fleece','pique','jacquard','other')),
  ADD COLUMN knit_gauge NUMERIC(6,2) CHECK (knit_gauge IS NULL OR knit_gauge > 0),
  ADD COLUMN machine_diameter_in NUMERIC(6,2) CHECK (machine_diameter_in IS NULL OR machine_diameter_in > 0),
  ADD COLUMN stitch_length_mm NUMERIC(6,3) CHECK (stitch_length_mm IS NULL OR stitch_length_mm > 0),
  ADD COLUMN needles_count INT CHECK (needles_count IS NULL OR needles_count > 0),
  ADD COLUMN feeders_count INT CHECK (feeders_count IS NULL OR feeders_count > 0);

CREATE TABLE delivery_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID NOT NULL,
  note_no TEXT NOT NULL,
  customer_id UUID NOT NULL,
  sales_order_id UUID,
  note_date DATE NOT NULL,
  vehicle_no TEXT, driver_name TEXT, notes TEXT,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','cancelled')),
  cancelled_reason TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, note_no),
  UNIQUE (id, company_id),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (customer_id, company_id) REFERENCES customers (id, company_id)
);
CREATE TABLE delivery_note_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  delivery_note_id UUID NOT NULL REFERENCES delivery_notes(id) ON DELETE CASCADE,
  packing_unit_id UUID REFERENCES packing_units(id),
  fabric_roll_id UUID REFERENCES fabric_rolls(id),
  CHECK ((packing_unit_id IS NOT NULL) <> (fabric_roll_id IS NOT NULL))
);
CREATE UNIQUE INDEX uq_dn_line_packing ON delivery_note_lines(packing_unit_id) WHERE packing_unit_id IS NOT NULL;
CREATE UNIQUE INDEX uq_dn_line_roll ON delivery_note_lines(fabric_roll_id) WHERE fabric_roll_id IS NOT NULL;
CREATE INDEX idx_dn_customer ON delivery_notes(company_id, customer_id, note_date DESC);

ALTER TABLE textile_defect_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE fabric_roll_defects ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_note_lines ENABLE ROW LEVEL SECURITY;

INSERT INTO permissions(code) VALUES ('textile.delivery.view'), ('textile.delivery.manage')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_id, permission_id, scope)
SELECT r.id, p.id, 'all_branches' FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Owner' AND r.is_system_role = TRUE AND p.code IN ('textile.delivery.view','textile.delivery.manage')
ON CONFLICT (role_id, permission_id) DO NOTHING;

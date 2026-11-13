-- 0041_textile_advanced.sql
-- إضافات مصنع الغزل والنسيج (تكملة 0039/0040): (١) استهلاك الطاقة وعدد العمال بسجل الوردية، (٢) بيمات السدى والأنوال،
-- (٣) وحدات التعبئة (بالات/باليتات/كراتين) بوزن القائم والصافي. كلها اختيارية ولا تغيّر ترحيل أمر التصنيع ولا القيود.

-- ===== ١) طاقة وعمالة الوردية (لحساب kWh/كجم وإنتاجية العامل) =====
ALTER TABLE machine_production_logs ADD COLUMN energy_kwh NUMERIC(14,3) CHECK (energy_kwh IS NULL OR energy_kwh >= 0);
ALTER TABLE machine_production_logs ADD COLUMN operators_count INT CHECK (operators_count IS NULL OR operators_count >= 0);

-- ===== ٢) بيمات السدى =====
-- البيم يُجهَّز (تسدية/نشا)، يُركَّب على نول، ويُنسَج منه أمتار حتى ينتهي. نول واحد لا يحمل أكثر من بيم نشط.
CREATE TABLE weaving_beams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID NOT NULL,
  beam_no TEXT NOT NULL,
  beam_type TEXT NOT NULL DEFAULT 'warp' CHECK (beam_type IN ('warp','sectional')),
  yarn_item_id UUID,
  lot_number TEXT,
  yarn_count_ne NUMERIC(10,3) CHECK (yarn_count_ne IS NULL OR yarn_count_ne > 0),
  total_ends INT NOT NULL CHECK (total_ends > 0),
  length_m NUMERIC(12,3) NOT NULL CHECK (length_m > 0),
  weight_kg NUMERIC(12,3) CHECK (weight_kg IS NULL OR weight_kg > 0),
  sizing_pickup_percent NUMERIC(5,2) CHECK (sizing_pickup_percent IS NULL OR sizing_pickup_percent >= 0),
  status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','on_loom','finished','scrapped')),
  machine_id UUID,
  mounted_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  meters_woven NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (meters_woven >= 0),
  production_order_id UUID,
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (meters_woven <= length_m),
  UNIQUE (id, company_id),
  UNIQUE (company_id, beam_no),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (yarn_item_id, company_id) REFERENCES items (id, company_id),
  FOREIGN KEY (machine_id, company_id) REFERENCES machines (id, company_id),
  FOREIGN KEY (production_order_id, company_id) REFERENCES production_orders (id, company_id)
);
CREATE UNIQUE INDEX uq_beam_one_active_per_loom ON weaving_beams(machine_id) WHERE status = 'on_loom';
CREATE INDEX idx_weaving_beams_status ON weaving_beams(company_id, status);

-- ===== ٣) وحدات التعبئة =====
CREATE TABLE packing_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID NOT NULL,
  packing_no TEXT NOT NULL,
  unit_type TEXT NOT NULL CHECK (unit_type IN ('bale','pallet','carton','bag','roll_pack')),
  item_id UUID NOT NULL,
  lot_number TEXT,
  production_order_id UUID,
  packages_count INT NOT NULL DEFAULT 0 CHECK (packages_count >= 0),   -- عدد الكونات/الشلل/الرولات داخل الوحدة
  gross_kg NUMERIC(12,3) NOT NULL CHECK (gross_kg > 0),
  tare_kg NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (tare_kg >= 0),      -- وزن الغلاف/الباليت/الكرتون الفارغ
  net_kg NUMERIC(12,3) GENERATED ALWAYS AS (gross_kg - tare_kg) STORED,
  status TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock','shipped')),
  shipped_at TIMESTAMPTZ,
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (tare_kg < gross_kg),
  UNIQUE (company_id, packing_no),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (item_id, company_id) REFERENCES items (id, company_id),
  FOREIGN KEY (production_order_id, company_id) REFERENCES production_orders (id, company_id)
);
CREATE INDEX idx_packing_lot ON packing_units(company_id, lot_number);
CREATE INDEX idx_packing_status ON packing_units(company_id, status);

ALTER TABLE weaving_beams ENABLE ROW LEVEL SECURITY;
ALTER TABLE packing_units ENABLE ROW LEVEL SECURITY;

-- ===== صلاحيات (للمالك تلقائيًا) =====
INSERT INTO permissions(code) VALUES ('textile.beam.manage'), ('textile.packing.manage'), ('textile.planning.view')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_id, permission_id, scope)
SELECT r.id, p.id, 'all_branches'
FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Owner' AND r.is_system_role = TRUE AND p.code IN ('textile.beam.manage','textile.packing.manage','textile.planning.view')
ON CONFLICT (role_id, permission_id) DO NOTHING;

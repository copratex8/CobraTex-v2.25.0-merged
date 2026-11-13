-- 0042_textile_mill_extras.sql
-- استكمال احتياجات مصنع غزل ونسيج فوق 0039–0041 (إضافات فقط، لا تعديل في سلوك أي جدول قائم):
--  (١) لوطات الألياف (قطن/بوليستر…) بخصائص HVI + خطط الخلط (Mixing/Laydown) بمتوسطات مرجَّحة وأقصى كمية ممكنة.
--  (٢) الصباغة: درجات الألوان، وصفات الصباغة، ودفعات الصباغة بنتائج مطابقة اللون والثباتية.
--  (٣) التشغيل للغير (خامات العميل): أعمال بالأجر مع رصيد الخامة لدى المصنع ونسبة الفاقد المسموح وتعويض الزائد.
--  (٤) معدّلات تكلفة التحويل (عمالة/كهرباء/مصاريف) تُطبَّق على أمر التصنيع من سجل ساعات الماكينات.
-- خامات العميل لا تدخل مخزون الشركة ولا قيودها: الرصيد بيانات تشغيلية، والأجر يُفوتَر بفاتورة بيع عادية (invoice_ref).

-- ===== ١) لوطات الألياف =====
CREATE TABLE fiber_lots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  lot_code TEXT NOT NULL,
  fiber_type TEXT NOT NULL CHECK (fiber_type IN ('cotton','polyester','viscose','acrylic','wool','nylon','blend','other')),
  variety TEXT,                    -- الصنف: جيزة 86، أمريكي، هندي S6...
  origin TEXT,
  supplier_name TEXT,
  item_id UUID,
  bales_count INT CHECK (bales_count IS NULL OR bales_count >= 0),
  net_weight_kg NUMERIC(14,3) NOT NULL CHECK (net_weight_kg > 0),
  staple_length_mm NUMERIC(6,2) CHECK (staple_length_mm IS NULL OR staple_length_mm > 0),
  micronaire NUMERIC(5,2),
  strength_gtex NUMERIC(6,2),
  uniformity_percent NUMERIC(5,2) CHECK (uniformity_percent IS NULL OR uniformity_percent BETWEEN 0 AND 100),
  short_fiber_percent NUMERIC(5,2) CHECK (short_fiber_percent IS NULL OR short_fiber_percent BETWEEN 0 AND 100),
  trash_percent NUMERIC(5,2) CHECK (trash_percent IS NULL OR trash_percent BETWEEN 0 AND 100),
  moisture_percent NUMERIC(5,2) CHECK (moisture_percent IS NULL OR moisture_percent BETWEEN 0 AND 100),
  color_grade TEXT,
  price_per_kg NUMERIC(18,4) CHECK (price_per_kg IS NULL OR price_per_kg >= 0),
  received_date DATE,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','in_use','consumed','rejected')),
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, lot_code),
  FOREIGN KEY (item_id, company_id) REFERENCES items (id, company_id)
);

CREATE TABLE mixing_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  plan_no TEXT NOT NULL,
  name TEXT NOT NULL,
  target_count_ne NUMERIC(10,3) CHECK (target_count_ne IS NULL OR target_count_ne > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, plan_no)
);
CREATE TABLE mixing_plan_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES mixing_plans(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id),
  lot_id UUID NOT NULL,
  percent NUMERIC(6,3) NOT NULL CHECK (percent > 0 AND percent <= 100),
  UNIQUE (plan_id, lot_id),
  FOREIGN KEY (lot_id, company_id) REFERENCES fiber_lots (id, company_id)
);

-- ===== ٢) الصباغة =====
CREATE TABLE shades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  color_hex TEXT CHECK (color_hex IS NULL OR color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  pantone TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, code)
);
CREATE TABLE dye_recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL,
  shade_id UUID,
  fiber_type TEXT,
  process_type TEXT NOT NULL DEFAULT 'exhaust' CHECK (process_type IN ('exhaust','continuous','pad_batch','reactive','disperse','vat','other')),
  liquor_ratio NUMERIC(6,2) CHECK (liquor_ratio IS NULL OR liquor_ratio > 0),   -- 1 : L
  temperature_c NUMERIC(5,1),
  duration_min INT CHECK (duration_min IS NULL OR duration_min > 0),
  ph NUMERIC(4,2),
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, code),
  FOREIGN KEY (shade_id, company_id) REFERENCES shades (id, company_id)
);
CREATE TABLE dye_recipe_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id UUID NOT NULL REFERENCES dye_recipes(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id),
  item_id UUID NOT NULL,
  amount NUMERIC(14,4) NOT NULL CHECK (amount > 0),
  -- percent_owf: % من وزن المادة (on weight of fibre) | g_per_l: جم/لتر محلول | kg_per_ton: كجم/طن مادة
  basis TEXT NOT NULL CHECK (basis IN ('percent_owf','g_per_l','kg_per_ton')),
  sequence INT NOT NULL DEFAULT 0,
  FOREIGN KEY (item_id, company_id) REFERENCES items (id, company_id)
);
CREATE TABLE dye_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID NOT NULL,
  batch_no TEXT NOT NULL,
  recipe_id UUID NOT NULL,
  shade_id UUID,
  machine_id UUID,
  production_order_id UUID,
  material_kg NUMERIC(14,3) NOT NULL CHECK (material_kg > 0),
  batch_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','running','done','rework','rejected')),
  delta_e NUMERIC(6,2) CHECK (delta_e IS NULL OR delta_e >= 0),
  shade_result TEXT NOT NULL DEFAULT 'pending' CHECK (shade_result IN ('pending','pass','fail')),
  fastness_wash NUMERIC(3,1) CHECK (fastness_wash IS NULL OR fastness_wash BETWEEN 1 AND 5),
  fastness_rub NUMERIC(3,1) CHECK (fastness_rub IS NULL OR fastness_rub BETWEEN 1 AND 5),
  fastness_light NUMERIC(3,1) CHECK (fastness_light IS NULL OR fastness_light BETWEEN 1 AND 8),
  water_liters NUMERIC(14,2) CHECK (water_liters IS NULL OR water_liters >= 0),
  steam_kg NUMERIC(14,2) CHECK (steam_kg IS NULL OR steam_kg >= 0),
  energy_kwh NUMERIC(14,3) CHECK (energy_kwh IS NULL OR energy_kwh >= 0),
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, batch_no),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (recipe_id, company_id) REFERENCES dye_recipes (id, company_id),
  FOREIGN KEY (shade_id, company_id) REFERENCES shades (id, company_id),
  FOREIGN KEY (machine_id, company_id) REFERENCES machines (id, company_id),
  FOREIGN KEY (production_order_id, company_id) REFERENCES production_orders (id, company_id)
);
CREATE INDEX idx_dye_batches_date ON dye_batches(company_id, batch_date);

-- ===== ٣) التشغيل للغير =====
CREATE TABLE toll_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID NOT NULL,
  job_no TEXT NOT NULL,
  customer_id UUID NOT NULL,
  service_type TEXT NOT NULL CHECK (service_type IN ('spinning','weaving','dyeing','finishing','printing','other')),
  material_description TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'kg',
  fee_per_unit NUMERIC(18,4) NOT NULL CHECK (fee_per_unit >= 0),
  fee_basis TEXT NOT NULL DEFAULT 'output' CHECK (fee_basis IN ('output','received')),
  allowed_loss_percent NUMERIC(6,3) NOT NULL DEFAULT 0 CHECK (allowed_loss_percent >= 0 AND allowed_loss_percent < 100),
  material_value_per_unit NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (material_value_per_unit >= 0),  -- لتعويض الفاقد الزائد
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  UNIQUE (id, company_id),
  UNIQUE (company_id, job_no),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (customer_id, company_id) REFERENCES customers (id, company_id)
);
CREATE TABLE toll_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL,
  company_id UUID NOT NULL REFERENCES companies(id),
  movement_type TEXT NOT NULL CHECK (movement_type IN ('receipt','output','waste_returned','waste_retained','invoice')),
  movement_date DATE NOT NULL,
  quantity NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  amount NUMERIC(18,4) CHECK (amount IS NULL OR amount >= 0),     -- لنوع invoice فقط: قيمة الأجر المفوتَر
  reference TEXT,                                                 -- رقم إذن/فاتورة
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((movement_type = 'invoice' AND amount IS NOT NULL) OR (movement_type <> 'invoice' AND quantity > 0)),
  FOREIGN KEY (job_id, company_id) REFERENCES toll_jobs (id, company_id)
);
CREATE INDEX idx_toll_movements_job ON toll_movements(job_id);

-- ===== ٤) معدّلات تكلفة التحويل =====
CREATE TABLE textile_cost_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  stage_id UUID,
  machine_id UUID,
  rate_type TEXT NOT NULL CHECK (rate_type IN ('labor_per_run_hour','energy_per_kwh','overhead_per_run_hour')),
  rate NUMERIC(18,4) NOT NULL CHECK (rate >= 0),
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (stage_id, company_id) REFERENCES textile_stages (id, company_id),
  FOREIGN KEY (machine_id, company_id) REFERENCES machines (id, company_id)
);
-- معدّل واحد نشط لكل (نوع، مرحلة، ماكينة): NULL يُعامَل كقيمة واحدة (معدّل عام).
CREATE UNIQUE INDEX uq_cost_rate_scope ON textile_cost_rates (
  company_id, rate_type, COALESCE(stage_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(machine_id, '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE is_active;

-- ===== RLS + صلاحيات =====
ALTER TABLE fiber_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE mixing_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE mixing_plan_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE shades ENABLE ROW LEVEL SECURITY;
ALTER TABLE dye_recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE dye_recipe_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE dye_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE toll_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE toll_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE textile_cost_rates ENABLE ROW LEVEL SECURITY;

INSERT INTO permissions(code) VALUES
  ('textile.fiber.manage'), ('textile.fiber.view'),
  ('textile.dyeing.manage'), ('textile.dyeing.view'),
  ('textile.toll.manage'), ('textile.toll.view'),
  ('textile.rates.manage')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_id, permission_id, scope)
SELECT r.id, p.id, 'all_branches'
FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Owner' AND r.is_system_role = TRUE
  AND p.code IN ('textile.fiber.manage','textile.fiber.view','textile.dyeing.manage','textile.dyeing.view','textile.toll.manage','textile.toll.view','textile.rates.manage')
ON CONFLICT (role_id, permission_id) DO NOTHING;

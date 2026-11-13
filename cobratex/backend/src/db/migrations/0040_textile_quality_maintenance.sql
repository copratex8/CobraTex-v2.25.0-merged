-- 0040_textile_quality_maintenance.sql
-- إضافات مصنع الغزل والنسيج (تكملة 0039): (١) أرقام اللوطات للتتبع، (٢) اختبارات الجودة المعملية، (٣) صيانة الماكينات.
-- كلها أعمدة/جداول اختيارية: لا تغيّر ترحيل أمر التصنيع ولا القيود ولا المخزون.

-- ===== ١) تتبّع اللوطات: رقم لوط المُنتَج على المخرجات، وأرقام لوطات الخامات المستهلكة على سطر الأمر (نص حر، مفصول بفواصل) =====
ALTER TABLE production_order_outputs ADD COLUMN lot_number TEXT;
ALTER TABLE production_order_lines ADD COLUMN input_lot_numbers TEXT;
CREATE INDEX idx_po_outputs_lot ON production_order_outputs(company_id, lot_number) WHERE lot_number IS NOT NULL;

-- ===== ٢) اختبارات الجودة =====
CREATE TABLE quality_test_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  applies_to TEXT NOT NULL CHECK (applies_to IN ('fiber','yarn','fabric','other')),
  unit TEXT,
  -- حدود القبول: NULL = بلا حد. تُضبط من إدارة المصنع حسب مواصفات كل عميل/صنف (لا قيم افتراضية تُدَّعى عالميًا).
  min_value NUMERIC(14,4),
  max_value NUMERIC(14,4),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (min_value IS NULL OR max_value IS NULL OR min_value <= max_value),
  UNIQUE (id, company_id),
  UNIQUE (company_id, code)
);

CREATE TABLE quality_test_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  test_type_id UUID NOT NULL,
  production_order_id UUID,
  item_id UUID,
  lot_number TEXT,
  value NUMERIC(14,4) NOT NULL,
  -- النتيجة تُحسب وقت الإدخال مقابل حدود النوع وقتها وتُحفظ (تغيير الحدود لاحقًا لا يغيّر نتائج قديمة).
  passed BOOLEAN NOT NULL,
  min_applied NUMERIC(14,4),
  max_applied NUMERIC(14,4),
  notes TEXT,
  tested_by UUID,
  tested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (test_type_id, company_id) REFERENCES quality_test_types (id, company_id),
  FOREIGN KEY (production_order_id, company_id) REFERENCES production_orders (id, company_id),
  FOREIGN KEY (item_id, company_id) REFERENCES items (id, company_id)
);
CREATE INDEX idx_quality_results_lot ON quality_test_results(company_id, lot_number);
CREATE INDEX idx_quality_results_order ON quality_test_results(production_order_id);

-- ===== ٣) صيانة الماكينات =====
CREATE TABLE maintenance_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  machine_id UUID NOT NULL,
  task_name TEXT NOT NULL,
  interval_days INT NOT NULL CHECK (interval_days > 0),
  last_done_date DATE,
  next_due_date DATE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  FOREIGN KEY (machine_id, company_id) REFERENCES machines (id, company_id)
);
CREATE INDEX idx_maint_plans_due ON maintenance_plans(company_id, next_due_date) WHERE is_active;

CREATE TABLE maintenance_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  machine_id UUID NOT NULL,
  plan_id UUID,
  log_type TEXT NOT NULL CHECK (log_type IN ('preventive','breakdown','inspection')),
  log_date DATE NOT NULL,
  downtime_hours NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (downtime_hours >= 0),
  cost NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  description TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (machine_id, company_id) REFERENCES machines (id, company_id),
  FOREIGN KEY (plan_id, company_id) REFERENCES maintenance_plans (id, company_id)
);
CREATE INDEX idx_maint_logs_machine ON maintenance_logs(company_id, machine_id, log_date DESC);

-- ===== صلاحيات (للمالك تلقائيًا) =====
INSERT INTO permissions(code) VALUES
  ('textile.quality.manage'), ('textile.quality.view'),
  ('textile.maintenance.manage'), ('textile.maintenance.view')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_id, permission_id, scope)
SELECT r.id, p.id, 'all_branches'
FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Owner' AND r.is_system_role = TRUE
  AND p.code IN ('textile.quality.manage','textile.quality.view','textile.maintenance.manage','textile.maintenance.view')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- بذور أنواع الاختبارات الشائعة (بلا حدود: تُضبط من الإدارة). تُستدعى هنا للشركات القائمة ومن /bootstrap للجديدة.
CREATE OR REPLACE FUNCTION seed_textile_quality_defaults(p_company UUID) RETURNS VOID AS $f$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('Y-CNT-CV','تباين رقم الغزل (CV%)','Count CV%','yarn','%'),
    ('Y-U','عدم انتظام (U%)','Evenness U%','yarn','%'),
    ('Y-STR','متانة الخيط','Yarn Strength','yarn','cN/tex'),
    ('Y-CSP','متانة الشلة (CSP)','Count Strength Product','yarn',''),
    ('Y-THIN','أماكن رفيعة (-50%)','Thin places -50%','yarn','/km'),
    ('Y-THICK','أماكن سميكة (+50%)','Thick places +50%','yarn','/km'),
    ('Y-NEPS','عقد (Neps +200%)','Neps +200%','yarn','/km'),
    ('Y-HAIR','زغب (Hairiness H)','Hairiness','yarn',''),
    ('Y-TPI','عدد اللفات TPI','Twist TPI','yarn','tpi'),
    ('F-SHR-W','انكماش طولي','Shrinkage Warp','fabric','%'),
    ('F-SHR-F','انكماش عرضي','Shrinkage Weft','fabric','%'),
    ('F-GSM','وزن المتر المربع GSM','GSM','fabric','g/m2'),
    ('F-TENS','قوة الشد','Tensile Strength','fabric','N'),
    ('F-TEAR','قوة التمزق','Tear Strength','fabric','N'),
    ('F-CF','ثبات اللون (1-5)','Colour Fastness','fabric','grade'),
    ('F-PILL','تكوّر السطح Pilling (1-5)','Pilling','fabric','grade'),
    ('FB-MIC','ميكرونير الألياف','Micronaire','fiber',''),
    ('FB-LEN','طول التيلة','Staple Length','fiber','mm'),
    ('FB-MOIST','نسبة الرطوبة','Moisture','fiber','%')
  ) AS t(code,name_ar,name_en,applies,unit) LOOP
    INSERT INTO quality_test_types(company_id, code, name_ar, name_en, applies_to, unit)
    VALUES (p_company, r.code, r.name_ar, r.name_en, r.applies, NULLIF(r.unit,''))
    ON CONFLICT (company_id, code) DO NOTHING;
  END LOOP;
END;
$f$ LANGUAGE plpgsql;

DO $$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT id FROM companies LOOP PERFORM seed_textile_quality_defaults(c.id); END LOOP;
END $$;

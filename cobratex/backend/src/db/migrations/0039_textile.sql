-- 0039_textile.sql
-- إضافات مصنع الغزل والنسيج فوق وحدة التصنيع (0033–0035) دون المساس بسلوكها: كل الأعمدة الجديدة اختيارية،
-- وأمر تصنيع بلا بيانات نسيج يُرحَّل ويُعكس تمامًا كما كان.
-- المحتوى: (١) مراحل الإنتاج بنسب هالك قياسية، (٢) أنواع الهالك وقيمة استرداده، (٣) مواصفات الغزل/القماش على الصنف،
-- (٤) الماكينات وسجل إنتاجها بالورديات، (٥) الاستهلاك الفعلي + مخرجات متعددة بدرجات + هالك فعلي على أمر التصنيع،
-- (٦) فحص رولات القماش، (٧) حسابات وقواعد ترحيل الهالك غير العادي واسترداد الهوالك.

-- ===== ١) مراحل الإنتاج =====
CREATE TABLE textile_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  stage_type TEXT NOT NULL CHECK (stage_type IN
    ('blowroom','carding','combing','drawing','roving','ring_spinning','open_end','winding',
     'warping','sizing','weaving','knitting','dyeing','printing','finishing','inspection','packing','other')),
  -- نسبة الهالك العادي المسموح بها كنسبة من وزن الخامة الرئيسية المستهلكة (3 تعني 3%). ما زاد عنها = هالك غير عادي.
  standard_waste_percent NUMERIC(6,3) NOT NULL DEFAULT 0 CHECK (standard_waste_percent >= 0 AND standard_waste_percent < 100),
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, code)
);

-- ===== ٢) أنواع الهالك =====
CREATE TABLE waste_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  stage_id UUID,
  -- قابل للاسترداد: يُدخَل للمخزن كصنف هالك (يُباع أو يُعاد تدويره) بقيمة استرداد، فيخفض تكلفة المنتج.
  is_recoverable BOOLEAN NOT NULL DEFAULT false,
  recovery_item_id UUID,
  recovery_unit_value NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (recovery_unit_value >= 0),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, code),
  FOREIGN KEY (stage_id, company_id) REFERENCES textile_stages (id, company_id),
  FOREIGN KEY (recovery_item_id, company_id) REFERENCES items (id, company_id)
);

-- ===== ٣) مواصفات الغزل/القماش (امتداد 1:1 للصنف) =====
CREATE TABLE item_textile_specs (
  item_id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id),
  count_system TEXT CHECK (count_system IN ('Ne','Nm','Tex','Denier')),
  yarn_count NUMERIC(10,3) CHECK (yarn_count IS NULL OR yarn_count > 0),
  ply INT NOT NULL DEFAULT 1 CHECK (ply >= 1),
  twist_tpi NUMERIC(8,2),
  fiber_composition TEXT,
  spinning_type TEXT CHECK (spinning_type IN ('ring','compact','open_end','air_jet','vortex','other')),
  weave_type TEXT CHECK (weave_type IN ('plain','twill','satin','dobby','jacquard','knit_single','knit_double','nonwoven','other')),
  fabric_gsm NUMERIC(8,2),
  fabric_width_cm NUMERIC(8,2),
  epi NUMERIC(8,2),
  ppi NUMERIC(8,2),
  warp_count_ne NUMERIC(10,3),
  weft_count_ne NUMERIC(10,3),
  shrinkage_percent NUMERIC(5,2),
  notes TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (item_id, company_id) REFERENCES items (id, company_id)
);

-- ===== ٤) الماكينات وسجل الإنتاج =====
CREATE TABLE machines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID,
  code TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  stage_id UUID,
  machine_type TEXT,
  -- عدد وحدات الماكينة (مغازل/أنوال/رؤوس) والطاقة الاسمية في الساعة بوحدة output_unit.
  units_count INT NOT NULL DEFAULT 1 CHECK (units_count >= 1),
  rated_output_per_hour NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (rated_output_per_hour >= 0),
  output_unit TEXT NOT NULL DEFAULT 'kg',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, code),
  FOREIGN KEY (stage_id, company_id) REFERENCES textile_stages (id, company_id),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id)
);

CREATE TABLE machine_production_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID NOT NULL,
  machine_id UUID NOT NULL,
  shift TEXT NOT NULL CHECK (shift IN ('morning','evening','night')),
  log_date DATE NOT NULL,
  production_order_id UUID,
  run_hours NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (run_hours >= 0),
  downtime_hours NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (downtime_hours >= 0),
  downtime_reason TEXT,
  output_quantity NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (output_quantity >= 0),
  waste_quantity NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (waste_quantity >= 0),
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (run_hours + downtime_hours <= 24),
  UNIQUE (machine_id, log_date, shift),
  FOREIGN KEY (machine_id, company_id) REFERENCES machines (id, company_id),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (production_order_id, company_id) REFERENCES production_orders (id, company_id)
);
CREATE INDEX idx_machine_logs_date ON machine_production_logs(company_id, log_date);

-- ===== ٥) أمر التصنيع: مرحلة + استهلاك فعلي + مخرجات + هالك =====
ALTER TABLE bill_of_materials ADD COLUMN stage_id UUID;
ALTER TABLE bill_of_materials ADD FOREIGN KEY (stage_id, company_id) REFERENCES textile_stages (id, company_id);
-- الخامة الرئيسية للسطر: أساس حساب الهالك (قطن خام في الغزل، خيط السداء في النسيج...). إن لم يُحدَّد أي سطر تُؤخذ الأكبر كمية.
ALTER TABLE bom_lines ADD COLUMN is_main_material BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE production_orders ADD COLUMN stage_id UUID;
ALTER TABLE production_orders ADD COLUMN machine_id UUID;
ALTER TABLE production_orders ADD COLUMN standard_waste_percent NUMERIC(6,3);
ALTER TABLE production_orders ADD COLUMN waste_quantity_total NUMERIC(18,4);
ALTER TABLE production_orders ADD COLUMN recovered_value_total NUMERIC(18,4);
ALTER TABLE production_orders ADD COLUMN abnormal_loss_total NUMERIC(18,4);
ALTER TABLE production_orders ADD FOREIGN KEY (stage_id, company_id) REFERENCES textile_stages (id, company_id);
ALTER TABLE production_orders ADD FOREIGN KEY (machine_id, company_id) REFERENCES machines (id, company_id);

ALTER TABLE production_order_lines ADD COLUMN is_main_material BOOLEAN NOT NULL DEFAULT false;
-- الاستهلاك الفعلي يُسجَّل في المسودة؛ إن بقي NULL يُستهلَك المخطَّط كما كان.
ALTER TABLE production_order_lines ADD COLUMN actual_quantity NUMERIC(18,4) CHECK (actual_quantity IS NULL OR actual_quantity > 0);

-- مخرجات الأمر: صنف أول + أصناف درجة ثانية/ثالثة. cost_weight وزن توزيع التكلفة (الدرجة الثانية مثلًا 0.7 من الأولى).
CREATE TABLE production_order_outputs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_order_id UUID NOT NULL REFERENCES production_orders(id),
  company_id UUID NOT NULL REFERENCES companies(id),
  output_item_id UUID NOT NULL,
  grade TEXT NOT NULL DEFAULT 'A',
  quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  cost_weight NUMERIC(8,4) NOT NULL DEFAULT 1 CHECK (cost_weight > 0),
  unit_cost NUMERIC(18,4),
  line_cost NUMERIC(18,4),
  stock_movement_id UUID,
  FOREIGN KEY (output_item_id, company_id) REFERENCES items (id, company_id)
);
CREATE INDEX idx_po_outputs_order ON production_order_outputs(production_order_id);

CREATE TABLE production_order_waste (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_order_id UUID NOT NULL REFERENCES production_orders(id),
  company_id UUID NOT NULL REFERENCES companies(id),
  waste_type_id UUID NOT NULL,
  quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  recovery_item_id UUID,
  recovery_unit_value NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (recovery_unit_value >= 0),
  -- تُملأ وقت الترحيل
  abnormal_quantity NUMERIC(18,4),
  recovered_value NUMERIC(18,4),
  abnormal_loss NUMERIC(18,4),
  stock_movement_id UUID,
  notes TEXT,
  FOREIGN KEY (waste_type_id, company_id) REFERENCES waste_types (id, company_id),
  FOREIGN KEY (recovery_item_id, company_id) REFERENCES items (id, company_id)
);
CREATE INDEX idx_po_waste_order ON production_order_waste(production_order_id);

-- ===== ٦) فحص رولات القماش (نظام 4 نقاط) =====
CREATE TABLE fabric_rolls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  production_order_id UUID,
  item_id UUID,
  roll_no TEXT NOT NULL,
  length_m NUMERIC(12,3) NOT NULL CHECK (length_m > 0),
  width_cm NUMERIC(8,2) NOT NULL CHECK (width_cm > 0),
  weight_kg NUMERIC(12,3),
  defect_points NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (defect_points >= 0),
  points_per_100sqyd NUMERIC(10,2) NOT NULL,
  grade TEXT NOT NULL CHECK (grade IN ('A','B','C')),
  inspected_by UUID,
  inspected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, roll_no),
  FOREIGN KEY (production_order_id, company_id) REFERENCES production_orders (id, company_id),
  FOREIGN KEY (item_id, company_id) REFERENCES items (id, company_id)
);
CREATE INDEX idx_fabric_rolls_order ON fabric_rolls(production_order_id);

-- ===== ٧) صلاحيات (للمالك تلقائيًا) =====
INSERT INTO permissions(code) VALUES
  ('textile.master.view'), ('textile.master.manage'),
  ('textile.completion.manage'),
  ('textile.log.view'), ('textile.log.create'),
  ('textile.inspection.manage'),
  ('textile.report.view')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_id, permission_id, scope)
SELECT r.id, p.id, 'all_branches'
FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Owner' AND r.is_system_role = TRUE AND p.code LIKE 'textile.%'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- دالة بذر افتراضية (مراحل + أنواع هالك شائعة) — idempotent، تُستدعى هنا للشركات القائمة ومن /bootstrap للجديدة.
-- النسب القياسية قيم مرجعية شائعة في الغزل القطني ويجب أن تعايرها إدارة المصنع على بياناتها الفعلية (الإعدادات ← المراحل).
CREATE OR REPLACE FUNCTION seed_textile_defaults(p_company UUID) RETURNS VOID AS $f$
DECLARE
  r RECORD;
  sid UUID;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('BLOW','فتح وتنظيف (بلو روم)','Blowroom','blowroom',5.0,10),
    ('CARD','كرد','Carding','carding',3.0,20),
    ('COMB','تسريح (مشط)','Combing','combing',15.0,30),
    ('DRAW','سحب','Drawing','drawing',0.5,40),
    ('ROVE','فتيل','Roving','roving',0.5,50),
    ('RING','غزل رينج','Ring Spinning','ring_spinning',1.5,60),
    ('OE','غزل أوبن إند','Open-End Spinning','open_end',1.5,65),
    ('WIND','تدوير وكونات','Winding','winding',0.7,70),
    ('WARP','تسدية','Warping','warping',0.5,80),
    ('SIZE','نشا (تحضير السدى)','Sizing','sizing',0.3,90),
    ('WEAVE','نسيج','Weaving','weaving',2.0,100),
    ('KNIT','تريكو','Knitting','knitting',2.0,105),
    ('DYE','صباغة','Dyeing','dyeing',4.0,110),
    ('PRINT','طباعة','Printing','printing',3.0,115),
    ('FINISH','تجهيز وتشطيب','Finishing','finishing',3.0,120),
    ('INSP','فحص وتقييم','Inspection','inspection',0.5,130),
    ('PACK','تعبئة','Packing','packing',0.2,140)
  ) AS t(code,name_ar,name_en,stype,std,ord) LOOP
    INSERT INTO textile_stages(company_id, code, name_ar, name_en, stage_type, standard_waste_percent, sort_order)
    VALUES (p_company, r.code, r.name_ar, r.name_en, r.stype, r.std, r.ord)
    ON CONFLICT (company_id, code) DO NOTHING;
  END LOOP;

  FOR r IN SELECT * FROM (VALUES
    ('BR-WASTE','نفاضة فتح وتنظيف','Blowroom Waste','BLOW',true),
    ('CARD-FLAT','شرائح كرد (فلات)','Card Flat Strips','CARD',true),
    ('CARD-WASTE','هالك كرد','Card Waste','CARD',true),
    ('COMB-NOIL','نفايات مشط (نويل)','Comber Noil','COMB',true),
    ('DRAW-SLIVER','هالك سحب (شرائط)','Drawing Sliver Waste','DRAW',true),
    ('ROVING-WASTE','هالك فتيل','Roving Waste','ROVE',true),
    ('SOFT-YARN','هالك غزل ناعم','Soft Yarn Waste','RING',true),
    ('HARD-YARN','هالك غزل مفتول (قاسي)','Hard Yarn Waste','WIND',true),
    ('SWEEP','كنس وزغب','Sweepings & Fly','BLOW',false),
    ('INVISIBLE','فاقد غير مرئي (رطوبة/غبار)','Invisible Loss','BLOW',false),
    ('WARP-ENDS','قصاقيص سداء','Warp Ends','WARP',true),
    ('WEFT-ENDS','قصاقيص لحمة','Weft Ends','WEAVE',true),
    ('SELVAGE','حواف نسيج','Selvage Waste','WEAVE',true),
    ('SIZE-WASTE','هالك نشا','Size Waste','SIZE',false),
    ('FABRIC-RAGS','بقايا وقصاصات قماش','Fabric Rags','FINISH',true),
    ('DYE-LOSS','فاقد صباغة وغسيل','Dyeing Loss','DYE',false),
    ('FINISH-LOSS','فاقد تجهيز','Finishing Loss','FINISH',false)
  ) AS t(code,name_ar,name_en,stage,rec) LOOP
    SELECT id INTO sid FROM textile_stages WHERE company_id = p_company AND code = r.stage;
    INSERT INTO waste_types(company_id, code, name_ar, name_en, stage_id, is_recoverable)
    VALUES (p_company, r.code, r.name_ar, r.name_en, sid, r.rec)
    ON CONFLICT (company_id, code) DO NOTHING;
  END LOOP;
END;
$f$ LANGUAGE plpgsql;

-- ===== ٨) حسابات وقواعد ترحيل + بذور المراحل وأنواع الهالك لكل شركة موجودة =====
-- (الشركات الجديدة تُزرع من /bootstrap بالكود). الحسابات 1050/5030 قد لا تكون موجودة في شركات أُنشئت قبل التصنيع.
DO $$
DECLARE
  c RECORD;
  wip UUID; absorb UUID; abn UUID;
BEGIN
  FOR c IN SELECT id FROM companies LOOP
    SELECT id INTO wip FROM accounts WHERE company_id = c.id AND code = '1050';
    IF wip IS NULL THEN
      INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES (c.id,'1050','تحت التشغيل - التصنيع','Manufacturing WIP Clearing','asset') RETURNING id INTO wip;
    END IF;
    SELECT id INTO absorb FROM accounts WHERE company_id = c.id AND code = '5030';
    IF absorb IS NULL THEN
      INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES (c.id,'5030','تكاليف تصنيع محمَّلة','Manufacturing Costs Absorbed','expense') RETURNING id INTO absorb;
    END IF;
    SELECT id INTO abn FROM accounts WHERE company_id = c.id AND code = '5040';
    IF abn IS NULL THEN
      INSERT INTO accounts(company_id, code, name_ar, name_en, account_type) VALUES (c.id,'5040','خسائر هالك غير عادي','Abnormal Waste Loss','expense') RETURNING id INTO abn;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM posting_rules WHERE company_id=c.id AND operation_type='manufacturing_consume') THEN
      INSERT INTO posting_rules(company_id, operation_type, debit_account_source_type, debit_fixed_account_id, credit_account_source_type, credit_fixed_account_id)
      VALUES (c.id,'manufacturing_consume','FIXED_ACCOUNT',wip,'ITEM_CATEGORY_INVENTORY',NULL);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM posting_rules WHERE company_id=c.id AND operation_type='manufacturing_output') THEN
      INSERT INTO posting_rules(company_id, operation_type, debit_account_source_type, debit_fixed_account_id, credit_account_source_type, credit_fixed_account_id)
      VALUES (c.id,'manufacturing_output','ITEM_CATEGORY_INVENTORY',NULL,'FIXED_ACCOUNT',wip);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM posting_rules WHERE company_id=c.id AND operation_type='manufacturing_conversion') THEN
      INSERT INTO posting_rules(company_id, operation_type, debit_account_source_type, debit_fixed_account_id, credit_account_source_type, credit_fixed_account_id)
      VALUES (c.id,'manufacturing_conversion','ITEM_CATEGORY_INVENTORY',NULL,'FIXED_ACCOUNT',absorb);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM posting_rules WHERE company_id=c.id AND operation_type='manufacturing_waste_recovery') THEN
      INSERT INTO posting_rules(company_id, operation_type, debit_account_source_type, debit_fixed_account_id, credit_account_source_type, credit_fixed_account_id)
      VALUES (c.id,'manufacturing_waste_recovery','ITEM_CATEGORY_INVENTORY',NULL,'FIXED_ACCOUNT',wip);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM posting_rules WHERE company_id=c.id AND operation_type='manufacturing_abnormal_loss') THEN
      INSERT INTO posting_rules(company_id, operation_type, debit_account_source_type, debit_fixed_account_id, credit_account_source_type, credit_fixed_account_id)
      VALUES (c.id,'manufacturing_abnormal_loss','FIXED_ACCOUNT',abn,'FIXED_ACCOUNT',wip);
    END IF;

    PERFORM seed_textile_defaults(c.id);
  END LOOP;
END $$;

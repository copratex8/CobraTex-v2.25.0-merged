-- 0033_activities_and_manufacturing.sql

-- فجوة أساسية مُكتشَفة عند بناء التصنيع: بُعد "النشاط" (activities) موجود بنيويًا منذ migration
-- 0001 ومربوط بالفعل على حركات المخزون والجرد والقيود (activity_id)، لكن بلا أي CRUD إطلاقًا —
-- لا مسار لإنشاء أو عرض الأنشطة نفسها. هذا هو الأساس الذي يجعل التصنيع "يصلح لأي نشاط باختيار
-- النشاط المطلوب" بدل ربطه بصنف/صناعة بعينها: الشركة تُعرِّف أنشطتها الخاصة (غزل، نسيج، تجميع
-- نوافذ، أي شيء) ثم تُصنِّف أوامر التصنيع والمستندات عليها، بلا أي منطق مكتوب بالكود خاص بصناعة معيّنة.
INSERT INTO permissions(code) VALUES
  ('tenancy.activity.create'),
  ('tenancy.activity.view'),
  ('tenancy.activity.update')
ON CONFLICT (code) DO NOTHING;

-- التصنيع: قائمة مواد (BOM) + أمر تصنيع بمرحلة واحدة (استهلاك مكوّنات → إنتاج صنف واحد). عمدًا
-- بلا قيد على نوع الصنف المُنتَج (raw_material/fabric/thread/finished_good/generic) — أمر تصنيع
-- واحد يستهلك خيوطًا وينتج قماشًا (نسيج) مطابق تمامًا لأمر يستهلك قماشًا وأزرارًا وينتج قميصًا
-- تامًا؛ التسلسل متعدد المراحل (غزل ثم نسيج مثلًا) يتحقق بتسلسل أوامر منفصلة يُغذّي مُخرَج كل
-- منها أمر الإدخال التالي — لا حاجة لمحرك توجيه (Routing) منفصل في هذه المرحلة.
CREATE TABLE bill_of_materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  output_item_id UUID NOT NULL,
  code TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  -- الكمية المُنتَجة من هذه الوصفة دفعةً واحدة (غالبًا 1، لكن قد تكون أكبر — مثال: دفعة غزل 100 كجم).
  output_quantity NUMERIC(18,4) NOT NULL DEFAULT 1 CHECK (output_quantity > 0),
  activity_id UUID,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, code),
  FOREIGN KEY (output_item_id, company_id) REFERENCES items (id, company_id),
  FOREIGN KEY (activity_id, company_id) REFERENCES activities (id, company_id)
);

CREATE TABLE bom_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bom_id UUID NOT NULL REFERENCES bill_of_materials(id),
  company_id UUID NOT NULL REFERENCES companies(id),
  component_item_id UUID NOT NULL,
  -- الكمية اللازمة من هذا المكوّن لإنتاج output_quantity كاملة من الوصفة (لا لوحدة واحدة).
  quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  sequence INT NOT NULL DEFAULT 0,
  FOREIGN KEY (component_item_id, company_id) REFERENCES items (id, company_id)
);

CREATE INDEX idx_bom_lines_bom ON bom_lines(bom_id);

CREATE TABLE production_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID NOT NULL,
  -- نفس المخزن للاستهلاك والإنتاج تبسيطًا لهذه المرحلة (لا تحويل بين مخزنين ضمن نفس الأمر).
  warehouse_id UUID NOT NULL,
  bom_id UUID NOT NULL,
  output_item_id UUID NOT NULL, -- نسخة من bom.output_item_id وقت الإنشاء (ثبات تاريخي لو تغيَّر الـBOM لاحقًا)
  activity_id UUID,
  document_number TEXT NOT NULL,
  fiscal_period_id UUID NOT NULL,
  order_date DATE NOT NULL,
  currency_code TEXT NOT NULL,
  planned_output_quantity NUMERIC(18,4) NOT NULL CHECK (planned_output_quantity > 0),
  actual_output_quantity NUMERIC(18,4), -- يُملأ وقت الترحيل فقط
  total_cost NUMERIC(18,4), -- يُملأ وقت الترحيل — مجموع تكلفة المكوّنات المُستهلَكة فعليًا
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'reversed')),
  journal_entry_id UUID,
  cancelled_reason TEXT,
  created_by UUID,
  posted_by UUID,
  posted_at TIMESTAMPTZ,
  cancelled_by UUID,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, document_number),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (warehouse_id, company_id) REFERENCES warehouses (id, company_id),
  FOREIGN KEY (output_item_id, company_id) REFERENCES items (id, company_id),
  FOREIGN KEY (bom_id, company_id) REFERENCES bill_of_materials (id, company_id),
  FOREIGN KEY (activity_id, company_id) REFERENCES activities (id, company_id)
);

CREATE INDEX idx_production_orders_branch ON production_orders(branch_id);

CREATE TABLE production_order_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_order_id UUID NOT NULL REFERENCES production_orders(id),
  company_id UUID NOT NULL REFERENCES companies(id),
  component_item_id UUID NOT NULL,
  planned_quantity NUMERIC(18,4) NOT NULL,
  consumed_quantity NUMERIC(18,4), -- يُملأ وقت الترحيل
  unit_cost NUMERIC(18,4), -- متوسط التكلفة الفعلي وقت الاستهلاك (لا لقطة المسودة)
  line_cost NUMERIC(18,4), -- consumed_quantity * unit_cost
  stock_movement_id UUID,
  FOREIGN KEY (component_item_id, company_id) REFERENCES items (id, company_id)
);

CREATE INDEX idx_production_order_lines_order ON production_order_lines(production_order_id);

-- نوعا حركة مخزون جديدان للتصنيع (بدل إعادة استخدام adjustment_in/out — تمييز واضح في تقارير
-- حركة المخزون بين "فرق جرد" و"استهلاك/إنتاج تصنيع"، سببان مختلفان تمامًا).
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_movement_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check CHECK (movement_type IN
  ('opening', 'in', 'out', 'transfer_in', 'transfer_out', 'adjustment_in', 'adjustment_out', 'loss',
   'production_consume', 'production_output'));

INSERT INTO permissions(code) VALUES
  ('manufacturing.bom.create'),
  ('manufacturing.bom.view'),
  ('manufacturing.order.create'),
  ('manufacturing.order.view'),
  ('manufacturing.order.post'),
  ('manufacturing.order.reverse')
ON CONFLICT (code) DO NOTHING;

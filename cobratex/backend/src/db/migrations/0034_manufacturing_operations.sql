-- 0034_manufacturing_operations.sql
-- مراحل التصنيع (Routing) وتكاليف التحويل (عمالة/مصاريف تشغيل) — تكملة migration 0033.
--
-- قرار التصميم: تدفُّق المواد متعدد المراحل (غزل ثم نسيج) يتحقق أصلًا بتسلسل أوامر يُغذّي ناتج كل منها
-- الآخر (مُثبَت باختبار). ما كان ناقصًا فعلًا هو **مراحل داخل الأمر الواحد تحمل تكلفتها**: قائمة المواد
-- تعرِّف مراحل (تحضير، غزل، نسيج، تشطيب... أو أي أسماء) لكل منها تكلفة تحويل قياسية، تُنسَخ لأمر
-- التصنيع كتكلفة مخطَّطة يمكن تعديلها إلى فعلية أثناء المسودة، وتدخل في تكلفة الصنف المُنتَج.
CREATE TABLE bom_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bom_id UUID NOT NULL REFERENCES bill_of_materials(id),
  company_id UUID NOT NULL REFERENCES companies(id),
  sequence INT NOT NULL,
  name TEXT NOT NULL,
  cost_type TEXT NOT NULL CHECK (cost_type IN ('labor', 'overhead', 'other')),
  -- تكلفة المرحلة لإنتاج output_quantity كاملة من الوصفة (تُضرَب في نسبة الكمية عند إنشاء الأمر، كالمكوّنات).
  cost_amount NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (cost_amount >= 0)
);
CREATE INDEX idx_bom_operations_bom ON bom_operations(bom_id);

CREATE TABLE production_order_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_order_id UUID NOT NULL REFERENCES production_orders(id),
  company_id UUID NOT NULL REFERENCES companies(id),
  sequence INT NOT NULL,
  name TEXT NOT NULL,
  cost_type TEXT NOT NULL CHECK (cost_type IN ('labor', 'overhead', 'other')),
  planned_cost NUMERIC(18,4) NOT NULL CHECK (planned_cost >= 0),
  -- تُعبَّأ اختياريًا في المسودة؛ إن بقيت NULL تُستخدَم planned_cost وقت الترحيل.
  actual_cost NUMERIC(18,4) CHECK (actual_cost IS NULL OR actual_cost >= 0)
);
CREATE INDEX idx_production_order_operations_order ON production_order_operations(production_order_id);

-- فصل تكلفة المواد عن تكلفة التحويل في رأس الأمر (total_cost يبقى مجموعهما).
ALTER TABLE production_orders ADD COLUMN materials_cost NUMERIC(18,4);
ALTER TABLE production_orders ADD COLUMN conversion_cost NUMERIC(18,4);

INSERT INTO permissions(code) VALUES ('manufacturing.order.update') ON CONFLICT (code) DO NOTHING;

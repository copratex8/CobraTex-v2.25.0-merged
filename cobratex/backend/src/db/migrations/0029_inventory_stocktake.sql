-- 0029_inventory_stocktake.sql
-- مستند جرد مخزني (Stocktake) — كان غائبًا كليًا رغم أن محرك حركات المخزون يدعم أنواع
-- adjustment_in/adjustment_out أصلًا منذ البداية بلا أي مستند يستخدمها فعليًا. بدونه، أي فرق بين
-- الكمية الدفترية والفعلية (تلف، سرقة، خطأ عدّ) لا يمكن تصحيحه في النظام إطلاقًا، فتبقى قيمة
-- المخزون خاطئة بشكل دائم مع الوقت — هذا أخطر فجوة تشغيلية متبقية لعمل مصنعي فعلي.

INSERT INTO permissions(code) VALUES
  ('inventory.stocktake.create'),
  ('inventory.stocktake.post'),
  ('inventory.stocktake.view'),
  ('inventory.stocktake.reverse')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE stocktakes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  branch_id UUID NOT NULL,
  warehouse_id UUID NOT NULL,
  fiscal_period_id UUID NOT NULL,
  document_number TEXT NOT NULL,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  count_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','reversed')),
  journal_entry_id UUID REFERENCES journal_entries(id),
  cancelled_reason TEXT,
  cancelled_by UUID,
  cancelled_at TIMESTAMPTZ,
  created_by UUID,
  posted_by UUID,
  posted_at TIMESTAMPTZ,
  activity_id UUID,
  project_id UUID,
  cost_center_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, branch_id, document_number),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (warehouse_id, company_id) REFERENCES warehouses (id, company_id),
  FOREIGN KEY (fiscal_period_id, company_id) REFERENCES fiscal_periods (id, company_id)
);
CREATE INDEX idx_stocktakes_company ON stocktakes(company_id);
CREATE INDEX idx_stocktakes_branch ON stocktakes(branch_id);

-- system_quantity/unit_cost: لقطة (snapshot) من stock_balances وقت إنشاء المسودة، لعرضها للمراجعة
-- قبل الترحيل. عند الترحيل الفعلي (postStocktake) يُعاد اشتقاق التكلفة الفعلية المُستخدَمة حيًّا
-- من الرصيد اللحظي (قد يختلف عن اللقطة لو تحرَّك الصنف بين إنشاء المسودة والترحيل)، وتُحدَّث
-- unit_cost هنا لتعكس القيمة الفعلية المُستخدَمة — لازمة لعكس (reverse) دقيق لاحقًا.
CREATE TABLE stocktake_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stocktake_id UUID NOT NULL REFERENCES stocktakes(id),
  company_id UUID NOT NULL,
  item_id UUID NOT NULL,
  batch_id UUID,
  system_quantity NUMERIC(18,4) NOT NULL,
  counted_quantity NUMERIC(18,4) NOT NULL CHECK (counted_quantity >= 0),
  unit_cost NUMERIC(18,4) NOT NULL,
  variance_quantity NUMERIC(18,4) NOT NULL,
  variance_value NUMERIC(18,4) NOT NULL,
  stock_movement_id UUID
);
CREATE INDEX idx_stocktake_lines_stocktake ON stocktake_lines(stocktake_id);

-- ===== بذرة حساب + قاعدتا ترحيل لفروق الجرد، لكل شركة موجودة فعليًا (رجعيًا) =====
-- (الشركات الجديدة تُزرع لها هذه البذرة من الآن فصاعدًا داخل مسار /bootstrap نفسه بالكود).
-- ملاحظة موثَّقة: لو كانت شركة ما قد أنشأت يدويًا حسابًا بالكود '5020' لغرض آخر تمامًا، سيُستخدَم
-- هذا الحساب خطأً كحساب فروق الجرد — احتمال ضعيف جدًا لكنه وارد؛ قالب مبسَّط قابل للتعديل الكامل
-- لاحقًا من الشركة نفسها (نفس فلسفة بذرة /bootstrap الموثَّقة هناك).
DO $$
DECLARE
  c RECORD;
  variance_account_id UUID;
BEGIN
  FOR c IN SELECT id FROM companies LOOP
    SELECT id INTO variance_account_id FROM accounts WHERE company_id = c.id AND code = '5020';
    IF variance_account_id IS NULL THEN
      INSERT INTO accounts(company_id, code, name_ar, name_en, account_type)
      VALUES (c.id, '5020', 'فروق الجرد', 'Inventory Count Variance', 'expense')
      RETURNING id INTO variance_account_id;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM posting_rules WHERE company_id = c.id AND operation_type = 'inventory_adjustment_increase') THEN
      INSERT INTO posting_rules(company_id, operation_type, debit_account_source_type, debit_fixed_account_id, credit_account_source_type, credit_fixed_account_id)
      VALUES (c.id, 'inventory_adjustment_increase', 'ITEM_CATEGORY_INVENTORY', NULL, 'FIXED_ACCOUNT', variance_account_id);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM posting_rules WHERE company_id = c.id AND operation_type = 'inventory_adjustment_decrease') THEN
      INSERT INTO posting_rules(company_id, operation_type, debit_account_source_type, debit_fixed_account_id, credit_account_source_type, credit_fixed_account_id)
      VALUES (c.id, 'inventory_adjustment_decrease', 'FIXED_ACCOUNT', variance_account_id, 'ITEM_CATEGORY_INVENTORY', NULL);
    END IF;
  END LOOP;
END $$;

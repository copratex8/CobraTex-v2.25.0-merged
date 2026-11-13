-- 0018_document_dimensions.sql
-- أبعاد تأسيسية (النشاط/المشروع/مركز التكلفة) على كل مستندات المبيعات والمشتريات وحركة المخزون،
-- لضمان بناء المرتجعات والتقارير والتصنيع لاحقًا على نموذج مستند مكتمل، لا ناقص يُعاد تعديله.
-- كل عمود Nullable (لا يكسر البيانات القائمة)، لكن مفتاح مركّب FK صريح يمنع بنيويًا ربط مستند
-- بنشاط/مشروع/مركز تكلفة تابع لشركة أخرى — بنفس نمط العزل المُستخدم في كل الجداول السابقة.

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'quotations', 'sales_orders', 'purchase_orders',
    'sales_invoices', 'supplier_invoices', 'goods_receipts',
    'sales_returns', 'purchase_returns'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN activity_id UUID', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN project_id UUID', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN cost_center_id UUID', t);
    EXECUTE format(
      'ALTER TABLE %I ADD FOREIGN KEY (activity_id, company_id) REFERENCES activities (id, company_id)', t
    );
    EXECUTE format(
      'ALTER TABLE %I ADD FOREIGN KEY (project_id, company_id) REFERENCES projects (id, company_id)', t
    );
    EXECUTE format(
      'ALTER TABLE %I ADD FOREIGN KEY (cost_center_id, company_id) REFERENCES cost_centers (id, company_id)', t
    );
  END LOOP;
END $$;

-- حركة المخزون: تحمل النشاط والمشروع أيضًا (لا مركز تكلفة — المخزون ليس مصروفًا/إيرادًا مباشرًا)
ALTER TABLE stock_movements ADD COLUMN activity_id UUID;
ALTER TABLE stock_movements ADD COLUMN project_id UUID;
ALTER TABLE stock_movements ADD FOREIGN KEY (activity_id, company_id) REFERENCES activities (id, company_id);
ALTER TABLE stock_movements ADD FOREIGN KEY (project_id, company_id) REFERENCES projects (id, company_id);

-- فهارس أداء للتصفية اللاحقة بالتقارير حسب البُعد
CREATE INDEX idx_sales_invoices_dimensions ON sales_invoices(company_id, activity_id, project_id);
CREATE INDEX idx_purchase_orders_dimensions ON purchase_orders(company_id, activity_id, project_id);
CREATE INDEX idx_stock_movements_dimensions ON stock_movements(company_id, activity_id, project_id);

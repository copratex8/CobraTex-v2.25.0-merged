-- 0024_warehouses_and_fiscal_period_view.sql
-- المرحلة: دعم الواجهة الأمامية لفواتير البيع — اكتُشف أثناء بناء نموذج الفاتورة أن لا خدمة ولا
-- مسار API للمخازن إطلاقًا (تُنشأ فقط ضمنيًا عبر /bootstrap)، ولا صلاحية/مسار لعرض قائمة الفترات
-- المالية (كان create فقط). كلاهما إلزامي لأي نموذج فاتورة بيع/شراء حقيقي في الواجهة.
INSERT INTO permissions(code) VALUES
  ('inventory.warehouse.create'),
  ('inventory.warehouse.view'),
  ('accounting.fiscal_period.view')
ON CONFLICT (code) DO NOTHING;

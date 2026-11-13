-- 0045_sales_production_link.sql
-- ربط أمر البيع بأمر التصنيع ووعد التسليم (مصنع الغزل والنسيج):
--   • sales_order_lines.requested_date  = ما طلبه العميل،  promised_date = ما وعدنا به.
--   • production_orders.sales_order_line_id = سطر البيع الذي يخدمه أمر التصنيع (اختياري؛ يجوز عدّة أوامر لسطر واحد).
--   • delivery_promise_changes = سجل تعديلات الوعد وأسبابها (للمساءلة وخدمة العميل).
-- لا يمسّ منطق الترحيل المالي أو المخزني إطلاقًا؛ أعمدة وجداول إضافية فقط.
ALTER TABLE sales_order_lines ADD COLUMN requested_date DATE;
ALTER TABLE sales_order_lines ADD COLUMN promised_date DATE;
ALTER TABLE production_orders ADD COLUMN sales_order_line_id UUID REFERENCES sales_order_lines(id);
CREATE INDEX idx_production_orders_sales_line ON production_orders(company_id, sales_order_line_id) WHERE sales_order_line_id IS NOT NULL;

CREATE TABLE delivery_promise_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  sales_order_line_id UUID NOT NULL REFERENCES sales_order_lines(id),
  old_date DATE,
  new_date DATE NOT NULL,
  reason TEXT,
  changed_by UUID,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_delivery_promise_changes_line ON delivery_promise_changes(company_id, sales_order_line_id, changed_at DESC);
ALTER TABLE delivery_promise_changes ENABLE ROW LEVEL SECURITY;

INSERT INTO permissions(code) VALUES ('textile.sales_link.view'), ('textile.sales_link.manage')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_id, permission_id, scope)
SELECT r.id, p.id, 'all_branches' FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Owner' AND r.is_system_role = TRUE
  AND p.code IN ('textile.sales_link.view','textile.sales_link.manage')
ON CONFLICT (role_id, permission_id) DO NOTHING;

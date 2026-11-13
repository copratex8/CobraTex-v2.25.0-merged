-- 0061_production_line_lots.sql
-- صرف خامات أمر التصنيع بالدفعة (اللوط): لكل مكوّن (نوع غزل) يُحدَّد أي لوطات تُصرف وبأي كمية، وتُصرف كل لوط بحركة مستقلة
-- بتكلفتها هي (المتوسط المرجّح للوط) فتبقى اللوتات منفصلة في المخزون والتكلفة والتتبّع. الأوامر بلا تخصيص تعمل كما كانت.
CREATE TABLE production_line_lots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  production_order_id UUID NOT NULL,
  production_order_line_id UUID NOT NULL REFERENCES production_order_lines(id) ON DELETE CASCADE,
  batch_id UUID NOT NULL,
  quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  unit_cost NUMERIC(18,4),
  line_cost NUMERIC(18,4),
  stock_movement_id UUID REFERENCES stock_movements(id),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (production_order_line_id, batch_id),
  FOREIGN KEY (production_order_id, company_id) REFERENCES production_orders (id, company_id),
  FOREIGN KEY (batch_id, company_id) REFERENCES batches (id, company_id)
);
CREATE INDEX idx_pll_order ON production_line_lots(company_id, production_order_id);
CREATE INDEX idx_pll_batch ON production_line_lots(company_id, batch_id);
ALTER TABLE production_line_lots ENABLE ROW LEVEL SECURITY;
INSERT INTO permissions(code) VALUES ('textile.lots.view'), ('textile.lots.manage') ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_id, permission_id, scope)
SELECT r.id, p.id, 'all_branches' FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Owner' AND r.is_system_role = TRUE AND p.code IN ('textile.lots.view','textile.lots.manage')
ON CONFLICT (role_id, permission_id) DO NOTHING;

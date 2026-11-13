-- 0067_carry_forward.sql — ترحيل الأرصدة إلى السنة الجديدة (2.18.0).
-- لقطة افتتاحية موثّقة لأرصدة حسابات الميزانية والعملاء والموردين والمخزون عند إقفال السنة. الإيرادات والمصروفات لا تُرحَّل (تُقفَل في الأرباح المرحَّلة).
-- لا قيود جديدة في دفتر الأستاذ: الدفتر تراكمي فأي قيد افتتاحي كان سيُضاعف الأرصدة.
CREATE TABLE carry_forward_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  from_date DATE NOT NULL, to_date DATE NOT NULL, opening_date DATE NOT NULL,
  next_period_id UUID,
  year_end_closing_id UUID REFERENCES year_end_closings(id),
  totals JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  reverse_reason TEXT, reversed_at TIMESTAMPTZ,
  created_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (to_date < opening_date),
  CHECK (status <> 'reversed' OR reverse_reason IS NOT NULL)
);
CREATE UNIQUE INDEX uq_carry_forward_active ON carry_forward_snapshots(company_id, to_date) WHERE status='posted';
CREATE TABLE carry_forward_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id UUID NOT NULL REFERENCES carry_forward_snapshots(id) ON DELETE CASCADE,
  company_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('account','customer','supplier','inventory')),
  ref_id UUID, warehouse_id UUID, code TEXT, name TEXT,
  debit NUMERIC(18,4) NOT NULL DEFAULT 0, credit NUMERIC(18,4) NOT NULL DEFAULT 0,
  quantity NUMERIC(18,4), amount NUMERIC(18,4) NOT NULL DEFAULT 0,
  detail JSONB
);
CREATE INDEX idx_cf_lines_snapshot ON carry_forward_lines(snapshot_id, kind);
ALTER TABLE carry_forward_snapshots ENABLE ROW LEVEL SECURITY; ALTER TABLE carry_forward_lines ENABLE ROW LEVEL SECURITY;
INSERT INTO permissions(code) VALUES ('carryforward.view'), ('carryforward.create'), ('carryforward.reverse') ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_id, permission_id, scope)
SELECT r.id, p.id, 'all_branches' FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Owner' AND r.is_system_role = TRUE AND p.code IN ('carryforward.view','carryforward.create','carryforward.reverse')
ON CONFLICT (role_id, permission_id) DO NOTHING;

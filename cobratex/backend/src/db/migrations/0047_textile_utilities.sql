-- 0047_textile_utilities.sql
-- فواتير المرافق (كهرباء/بخار/ماء/غاز/هواء مضغوط) وتوزيعها على مراحل الإنتاج حسب محرّك التوزيع
-- (kWh الفعلي من سجل الماكينة، أو ساعات التشغيل، أو كمية الإنتاج). تقرير تحليلي فقط — لا قيود ولا ترحيل.
CREATE TABLE utility_bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('electricity','steam','water','gas','compressed_air','other')),
  period_from DATE NOT NULL,
  period_to DATE NOT NULL,
  quantity NUMERIC(18,3),
  unit TEXT,
  total_cost NUMERIC(18,4) NOT NULL CHECK (total_cost > 0),
  driver TEXT NOT NULL DEFAULT 'run_hours' CHECK (driver IN ('energy_kwh','run_hours','output')),
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_to >= period_from),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id)
);
CREATE INDEX idx_utility_bills_period ON utility_bills(company_id, period_to);
ALTER TABLE utility_bills ENABLE ROW LEVEL SECURITY;
INSERT INTO permissions(code) VALUES ('textile.utilities.view'), ('textile.utilities.manage') ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_id, permission_id, scope)
SELECT r.id, p.id, 'all_branches' FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Owner' AND r.is_system_role = TRUE AND p.code IN ('textile.utilities.view','textile.utilities.manage')
ON CONFLICT (role_id, permission_id) DO NOTHING;

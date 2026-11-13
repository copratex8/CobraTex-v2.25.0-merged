-- 0049_textile_hr_payroll.sql — الحضور والرواتب لعمالة المصنع (آخر مرحلة).
-- سجل تشغيلي: يحسب كشف الرواتب (أساسي + إضافي + حوافز − تأمينات/سلف/جزاءات) ولا يُرحِّل قيودًا ولا يلمس دفتر الأستاذ.
ALTER TABLE textile_workers
  ADD COLUMN pay_type TEXT NOT NULL DEFAULT 'monthly' CHECK (pay_type IN ('monthly','daily','hourly')),
  ADD COLUMN base_rate NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (base_rate >= 0),   -- راتب شهري | يومية | أجر ساعة
  ADD COLUMN std_hours_per_day NUMERIC(4,2) NOT NULL DEFAULT 8 CHECK (std_hours_per_day > 0 AND std_hours_per_day <= 24),
  ADD COLUMN overtime_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.5 CHECK (overtime_multiplier >= 1),
  ADD COLUMN insurance_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (insurance_percent >= 0 AND insurance_percent <= 100),
  ADD COLUMN hire_date DATE;

CREATE TABLE attendance_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  worker_id UUID NOT NULL,
  work_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('present','absent','leave_paid','leave_unpaid','sick','holiday','weekly_off')),
  check_in TIME, check_out TIME,
  hours_worked NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (hours_worked >= 0 AND hours_worked <= 24),
  overtime_hours NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (overtime_hours >= 0 AND overtime_hours <= 24),
  late_minutes INT NOT NULL DEFAULT 0 CHECK (late_minutes >= 0 AND late_minutes <= 1440),
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (worker_id, work_date),
  FOREIGN KEY (worker_id, company_id) REFERENCES textile_workers (id, company_id)
);
CREATE INDEX idx_attendance_date ON attendance_records(company_id, work_date);

CREATE TABLE worker_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  worker_id UUID NOT NULL,
  adj_date DATE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('advance','penalty','deduction','bonus','allowance')),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  reason TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (worker_id, company_id) REFERENCES textile_workers (id, company_id)
);
CREATE INDEX idx_worker_adj_date ON worker_adjustments(company_id, adj_date);

CREATE TABLE payroll_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID,
  period_month DATE NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  working_days INT NOT NULL CHECK (working_days BETWEEN 1 AND 31),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','cancelled')),
  total_net NUMERIC(16,2) NOT NULL DEFAULT 0,
  created_by UUID, approved_by UUID, approved_at TIMESTAMPTZ,
  cancelled_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id)
);
CREATE UNIQUE INDEX uq_payroll_month ON payroll_runs(company_id, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), period_month) WHERE status <> 'cancelled';

CREATE TABLE payroll_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  run_id UUID NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  worker_id UUID NOT NULL,
  pay_type TEXT NOT NULL, base_rate NUMERIC(14,4) NOT NULL,
  days_paid NUMERIC(6,2) NOT NULL DEFAULT 0, days_absent NUMERIC(6,2) NOT NULL DEFAULT 0,
  hours_worked NUMERIC(8,2) NOT NULL DEFAULT 0, overtime_hours NUMERIC(8,2) NOT NULL DEFAULT 0,
  base_pay NUMERIC(14,2) NOT NULL DEFAULT 0, overtime_pay NUMERIC(14,2) NOT NULL DEFAULT 0, incentive NUMERIC(14,2) NOT NULL DEFAULT 0,
  allowances NUMERIC(14,2) NOT NULL DEFAULT 0, gross NUMERIC(14,2) NOT NULL DEFAULT 0,
  insurance NUMERIC(14,2) NOT NULL DEFAULT 0, late_deduction NUMERIC(14,2) NOT NULL DEFAULT 0,
  advances NUMERIC(14,2) NOT NULL DEFAULT 0, penalties NUMERIC(14,2) NOT NULL DEFAULT 0, other_deductions NUMERIC(14,2) NOT NULL DEFAULT 0,
  net NUMERIC(14,2) NOT NULL DEFAULT 0,
  UNIQUE (run_id, worker_id),
  FOREIGN KEY (worker_id, company_id) REFERENCES textile_workers (id, company_id)
);

ALTER TABLE attendance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_lines ENABLE ROW LEVEL SECURITY;
INSERT INTO permissions(code) VALUES ('textile.hr.view'), ('textile.hr.manage'), ('textile.payroll.view'), ('textile.payroll.manage'), ('textile.payroll.approve')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_id, permission_id, scope)
SELECT r.id, p.id, 'all_branches' FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Owner' AND r.is_system_role = TRUE AND p.code IN ('textile.hr.view','textile.hr.manage','textile.payroll.view','textile.payroll.manage','textile.payroll.approve')
ON CONFLICT (role_id, permission_id) DO NOTHING;

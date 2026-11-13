-- 0044_textile_workforce_schedule.sql
-- (١) جدولة الإنتاج: تاريخ بدء/انتهاء مخطَّط لأمر التصنيع على ماكينة، مع كشف تعارض الماكينة الواحدة.
-- (٢) العمالة والحوافز: عمال الإنتاج، تسجيل إنتاج العامل بالوردية، ومعدّلات حافز بالوحدة (مع حافز زيادة بعد حدّ).
--     دفتر تشغيلي لحساب الحافز؛ الأجور الفعلية والقيود تبقى في نظام الرواتب الخارجي (لا ترحيل مالي هنا).
ALTER TABLE production_orders ADD COLUMN planned_start DATE;
ALTER TABLE production_orders ADD COLUMN planned_end DATE;
ALTER TABLE production_orders ADD CONSTRAINT production_orders_planned_range_check CHECK (planned_end IS NULL OR planned_start IS NULL OR planned_end >= planned_start);
CREATE INDEX idx_production_orders_schedule ON production_orders(company_id, machine_id, planned_start) WHERE planned_start IS NOT NULL;

CREATE TABLE textile_workers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID,
  code TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  job_title TEXT,
  stage_id UUID,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, code),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (stage_id, company_id) REFERENCES textile_stages (id, company_id)
);

CREATE TABLE incentive_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  stage_id UUID,                       -- NULL = يسري على كل المراحل (المرحلة المحددة تتقدّم عليه)
  unit TEXT NOT NULL DEFAULT 'kg',
  rate_per_unit NUMERIC(18,4) NOT NULL CHECK (rate_per_unit >= 0),
  -- حدّ الوردية: ما زاد على الحدّ (الصافي بعد المعيب) يُحتسب بمعدّل الزيادة بدل المعدّل الأساسي.
  bonus_threshold NUMERIC(18,4) CHECK (bonus_threshold IS NULL OR bonus_threshold > 0),
  bonus_rate_per_unit NUMERIC(18,4) CHECK (bonus_rate_per_unit IS NULL OR bonus_rate_per_unit >= 0),
  effective_from DATE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (bonus_rate_per_unit IS NULL OR bonus_threshold IS NOT NULL),
  UNIQUE (id, company_id),
  FOREIGN KEY (stage_id, company_id) REFERENCES textile_stages (id, company_id)
);

CREATE TABLE worker_output_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID NOT NULL,
  worker_id UUID NOT NULL,
  machine_id UUID,
  stage_id UUID,
  production_order_id UUID,
  log_date DATE NOT NULL,
  shift TEXT NOT NULL CHECK (shift IN ('morning','evening','night')),
  quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  defective_quantity NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (defective_quantity >= 0),
  unit TEXT NOT NULL DEFAULT 'kg',
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (defective_quantity <= quantity),
  FOREIGN KEY (worker_id, company_id) REFERENCES textile_workers (id, company_id),
  FOREIGN KEY (machine_id, company_id) REFERENCES machines (id, company_id),
  FOREIGN KEY (stage_id, company_id) REFERENCES textile_stages (id, company_id),
  FOREIGN KEY (production_order_id, company_id) REFERENCES production_orders (id, company_id),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id)
);
-- عامل واحد لا يُسجَّل مرتين على نفس الماكينة والوردية واليوم.
CREATE UNIQUE INDEX uq_worker_output_shift ON worker_output_logs(worker_id, log_date, shift, COALESCE(machine_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX idx_worker_output_date ON worker_output_logs(company_id, log_date);

ALTER TABLE textile_workers ENABLE ROW LEVEL SECURITY;
ALTER TABLE incentive_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_output_logs ENABLE ROW LEVEL SECURITY;

INSERT INTO permissions(code) VALUES
  ('textile.schedule.view'), ('textile.schedule.manage'),
  ('textile.workforce.view'), ('textile.workforce.manage'),
  ('textile.labels.view')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_id, permission_id, scope)
SELECT r.id, p.id, 'all_branches' FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Owner' AND r.is_system_role = TRUE
  AND p.code IN ('textile.schedule.view','textile.schedule.manage','textile.workforce.view','textile.workforce.manage','textile.labels.view')
ON CONFLICT (role_id, permission_id) DO NOTHING;

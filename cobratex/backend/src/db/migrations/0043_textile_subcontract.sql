-- 0043_textile_subcontract.sql
-- التصنيع لدى الغير (Outward Subcontracting): إرسال خامة/غزل/قماش إلى مصنع أو مصبغة خارجية (صباغة، تجهيز، نسيج، طباعة…)
-- واستلام المنتج المعالج. مقابل «التشغيل للغير» (0042) حيث نحن المُصنِّع. دفتر تشغيلي بلا ترحيل مخزون/قيود:
-- رصيد الخامة لدى المقاول، الفاقد المسموح، الأجر المستحق له، وتحميله الزائد عن المسموح بقيمة الخامة.
-- الفاتورة الفعلية تُسجَّل كفاتورة شراء عادية ويُدخَل رقمها/مبلغها هنا كحركة invoice.
CREATE TABLE subcontract_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID NOT NULL,
  job_no TEXT NOT NULL,
  supplier_id UUID NOT NULL,
  service_type TEXT NOT NULL CHECK (service_type IN ('spinning','weaving','dyeing','finishing','printing','other')),
  material_description TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'kg',
  fee_per_unit NUMERIC(18,4) NOT NULL CHECK (fee_per_unit >= 0),
  fee_basis TEXT NOT NULL DEFAULT 'received' CHECK (fee_basis IN ('received','sent')),   -- received = المستلم المعالج، sent = المرسل
  allowed_loss_percent NUMERIC(6,3) NOT NULL DEFAULT 0 CHECK (allowed_loss_percent >= 0 AND allowed_loss_percent < 100),
  material_value_per_unit NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (material_value_per_unit >= 0),
  production_order_id UUID,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  UNIQUE (id, company_id),
  UNIQUE (company_id, job_no),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (supplier_id, company_id) REFERENCES suppliers (id, company_id),
  FOREIGN KEY (production_order_id, company_id) REFERENCES production_orders (id, company_id)
);
CREATE TABLE subcontract_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL,
  company_id UUID NOT NULL REFERENCES companies(id),
  movement_type TEXT NOT NULL CHECK (movement_type IN ('sent','received','waste_returned','waste_retained','invoice')),
  movement_date DATE NOT NULL,
  quantity NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  amount NUMERIC(18,4) CHECK (amount IS NULL OR amount >= 0),
  reference TEXT,
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((movement_type = 'invoice' AND amount IS NOT NULL) OR (movement_type <> 'invoice' AND quantity > 0)),
  FOREIGN KEY (job_id, company_id) REFERENCES subcontract_jobs (id, company_id)
);
CREATE INDEX idx_subcontract_movements_job ON subcontract_movements(job_id);
ALTER TABLE subcontract_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE subcontract_movements ENABLE ROW LEVEL SECURITY;

INSERT INTO permissions(code) VALUES ('textile.subcontract.manage'), ('textile.subcontract.view') ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_id, permission_id, scope)
SELECT r.id, p.id, 'all_branches' FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Owner' AND r.is_system_role = TRUE AND p.code IN ('textile.subcontract.manage','textile.subcontract.view')
ON CONFLICT (role_id, permission_id) DO NOTHING;

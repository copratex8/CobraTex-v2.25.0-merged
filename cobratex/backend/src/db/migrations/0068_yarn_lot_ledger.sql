-- 0068_yarn_lot_ledger.sql — دفتر لوطات الخيوط والهالك (2.19.0): وارد بالوط + تشغيل ماكينات بخلط لوطات متعددة + هالك لكل خيط.
-- منطق شيت «Textile Yarn Inventory»: الرصيد = الوارد − الصافي − الهالك؛ هالك الخيط = كمية القماش × نسبة الهالك × نسبة الخلط.
CREATE TABLE yarn_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  receipt_date DATE NOT NULL, receipt_no TEXT,
  lot_no TEXT NOT NULL CHECK (length(btrim(lot_no)) > 0),
  item_name TEXT NOT NULL CHECK (length(btrim(item_name)) > 0), item_id UUID,
  quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')), cancel_reason TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import')),
  created_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL)
);
CREATE INDEX idx_yarn_receipts_lot ON yarn_receipts(company_id, lot_no);
CREATE UNIQUE INDEX uq_yarn_receipt_no ON yarn_receipts(company_id, receipt_no, lot_no) WHERE receipt_no IS NOT NULL AND status='active';
CREATE TABLE yarn_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  run_date DATE NOT NULL,
  machine_code TEXT, machine_id UUID,
  fabric_kg NUMERIC(14,3) NOT NULL CHECK (fabric_kg > 0),
  waste_percent NUMERIC(7,4) NOT NULL DEFAULT 0 CHECK (waste_percent >= 0 AND waste_percent <= 100),
  waste_override_kg NUMERIC(14,3) CHECK (waste_override_kg IS NULL OR waste_override_kg >= 0), -- هالك فعلي موزون يحلّ محل النسبة
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')), cancel_reason TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import')),
  created_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL)
);
CREATE INDEX idx_yarn_runs_date ON yarn_runs(company_id, run_date);
CREATE TABLE yarn_run_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES yarn_runs(id) ON DELETE CASCADE,
  company_id UUID NOT NULL,
  lot_no TEXT NOT NULL, item_name TEXT,
  blend_percent NUMERIC(7,4) NOT NULL CHECK (blend_percent > 0 AND blend_percent <= 100),
  net_kg NUMERIC(14,4) NOT NULL, waste_kg NUMERIC(14,4) NOT NULL,
  UNIQUE (run_id, lot_no)
);
CREATE INDEX idx_yarn_run_lines_lot ON yarn_run_lines(company_id, lot_no);
ALTER TABLE yarn_receipts ENABLE ROW LEVEL SECURITY; ALTER TABLE yarn_runs ENABLE ROW LEVEL SECURITY; ALTER TABLE yarn_run_lines ENABLE ROW LEVEL SECURITY;
INSERT INTO permissions(code) VALUES ('yarnlot.view'), ('yarnlot.manage'), ('yarnlot.import'), ('yarnlot.cancel') ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_id, permission_id, scope)
SELECT r.id, p.id, 'all_branches' FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Owner' AND r.is_system_role = TRUE AND p.code IN ('yarnlot.view','yarnlot.manage','yarnlot.import','yarnlot.cancel')
ON CONFLICT (role_id, permission_id) DO NOTHING;

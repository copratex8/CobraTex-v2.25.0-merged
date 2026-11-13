-- 0062_fixed_assets.sql — الأصول الثابتة والإهلاك (2.12.0): سجل أصول، إهلاك شهري بقيد مرحَّل، عكس شهر، استبعاد/بيع بقيد ربح/خسارة.
CREATE TABLE fixed_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID NOT NULL,
  code TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  acquisition_date DATE NOT NULL,
  cost NUMERIC(18,4) NOT NULL CHECK (cost > 0),
  salvage_value NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (salvage_value >= 0),
  useful_life_months INT NOT NULL CHECK (useful_life_months > 0),
  method TEXT NOT NULL DEFAULT 'straight_line' CHECK (method IN ('straight_line','declining_balance')),
  asset_account_id UUID NOT NULL,
  accumulated_account_id UUID NOT NULL,
  expense_account_id UUID NOT NULL,
  accumulated_depreciation NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (accumulated_depreciation >= 0),
  depreciated_through DATE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','fully_depreciated','disposed')),
  disposed_at DATE, disposal_proceeds NUMERIC(18,4), disposal_entry_id UUID REFERENCES journal_entries(id),
  notes TEXT, created_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id), UNIQUE (company_id, code),
  CHECK (salvage_value < cost),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (asset_account_id, company_id) REFERENCES accounts (id, company_id),
  FOREIGN KEY (accumulated_account_id, company_id) REFERENCES accounts (id, company_id),
  FOREIGN KEY (expense_account_id, company_id) REFERENCES accounts (id, company_id)
);
CREATE TABLE fixed_asset_depreciations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  asset_id UUID NOT NULL REFERENCES fixed_assets(id),
  period_end DATE NOT NULL,
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  journal_entry_id UUID NOT NULL REFERENCES journal_entries(id),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  reversal_entry_id UUID REFERENCES journal_entries(id), reverse_reason TEXT,
  created_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'reversed' OR (reversal_entry_id IS NOT NULL AND reverse_reason IS NOT NULL))
);
CREATE UNIQUE INDEX uq_fa_dep_active ON fixed_asset_depreciations(asset_id, period_end) WHERE status = 'posted';
CREATE INDEX idx_fa_dep_period ON fixed_asset_depreciations(company_id, period_end);
ALTER TABLE fixed_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_asset_depreciations ENABLE ROW LEVEL SECURITY;

INSERT INTO permissions(code) VALUES ('assets.view'), ('assets.manage'), ('assets.depreciate'), ('assets.dispose') ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_id, permission_id, scope)
SELECT r.id, p.id, 'all_branches' FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Owner' AND r.is_system_role = TRUE AND p.code IN ('assets.view','assets.manage','assets.depreciate','assets.dispose')
ON CONFLICT (role_id, permission_id) DO NOTHING;

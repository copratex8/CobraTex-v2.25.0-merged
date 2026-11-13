-- 0064_landed_costs.sql — التكاليف الإضافية على المشتريات (2.14.0). خيارات كل شركة في landed_cost_settings.
CREATE TABLE landed_cost_settings (
  company_id UUID PRIMARY KEY REFERENCES companies(id),
  default_method TEXT NOT NULL DEFAULT 'value' CHECK (default_method IN ('value','quantity','weight','volume','equal','manual')),
  allowed_methods TEXT[] NOT NULL DEFAULT ARRAY['value','quantity','weight','volume','equal','manual'],
  consumed_policy TEXT NOT NULL DEFAULT 'expense_consumed' CHECK (consumed_policy IN ('expense_consumed','capitalize_remaining')),
  inventory_account_id UUID, variance_account_id UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (inventory_account_id, company_id) REFERENCES accounts (id, company_id),
  FOREIGN KEY (variance_account_id, company_id) REFERENCES accounts (id, company_id)
);
CREATE TABLE landed_cost_docs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID NOT NULL,
  doc_no TEXT NOT NULL,
  doc_date DATE NOT NULL,
  default_method TEXT NOT NULL,
  consumed_policy TEXT NOT NULL,
  total_amount NUMERIC(18,4) NOT NULL CHECK (total_amount > 0),
  capitalized_total NUMERIC(18,4) NOT NULL DEFAULT 0,
  expensed_total NUMERIC(18,4) NOT NULL DEFAULT 0,
  journal_entry_id UUID NOT NULL REFERENCES journal_entries(id),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  reversal_entry_id UUID REFERENCES journal_entries(id), reverse_reason TEXT, reversed_at TIMESTAMPTZ,
  notes TEXT, created_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, doc_no),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  CHECK (status <> 'reversed' OR (reversal_entry_id IS NOT NULL AND reverse_reason IS NOT NULL))
);
CREATE TABLE landed_cost_components (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id UUID NOT NULL REFERENCES landed_cost_docs(id),
  company_id UUID NOT NULL,
  name TEXT NOT NULL,
  method TEXT NOT NULL,
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  currency_code TEXT NOT NULL, exchange_rate NUMERIC(18,6) NOT NULL DEFAULT 1,
  amount_base NUMERIC(18,4) NOT NULL CHECK (amount_base > 0),
  credit_account_id UUID NOT NULL, supplier_id UUID, reference TEXT
);
CREATE TABLE landed_cost_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id UUID NOT NULL REFERENCES landed_cost_docs(id),
  company_id UUID NOT NULL,
  goods_receipt_line_id UUID NOT NULL REFERENCES goods_receipt_lines(id),
  item_id UUID NOT NULL, warehouse_id UUID NOT NULL, batch_id UUID,
  received_qty NUMERIC(18,4) NOT NULL, on_hand_at_post NUMERIC(18,4) NOT NULL,
  line_value NUMERIC(18,4) NOT NULL, weight NUMERIC(18,4), volume NUMERIC(18,4), manual_percent NUMERIC(8,4),
  allocated_amount NUMERIC(18,4) NOT NULL, capitalized_amount NUMERIC(18,4) NOT NULL, expensed_amount NUMERIC(18,4) NOT NULL,
  wac_before NUMERIC(18,4) NOT NULL, wac_after NUMERIC(18,4) NOT NULL
);
CREATE INDEX idx_lc_lines_receipt ON landed_cost_lines(goods_receipt_line_id);
CREATE INDEX idx_lc_lines_doc ON landed_cost_lines(doc_id);
ALTER TABLE landed_cost_settings ENABLE ROW LEVEL SECURITY; ALTER TABLE landed_cost_docs ENABLE ROW LEVEL SECURITY;
ALTER TABLE landed_cost_components ENABLE ROW LEVEL SECURITY; ALTER TABLE landed_cost_lines ENABLE ROW LEVEL SECURITY;
INSERT INTO permissions(code) VALUES ('landed.view'), ('landed.settings'), ('landed.post'), ('landed.reverse') ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_id, permission_id, scope)
SELECT r.id, p.id, 'all_branches' FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Owner' AND r.is_system_role = TRUE AND p.code IN ('landed.view','landed.settings','landed.post','landed.reverse')
ON CONFLICT (role_id, permission_id) DO NOTHING;

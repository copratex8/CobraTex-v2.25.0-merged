-- 0065_period_closing.sql — إقفال الفترات المالية وقيد إقفال السنة (2.16.0).
ALTER TABLE fiscal_periods ADD COLUMN closed_at TIMESTAMPTZ, ADD COLUMN closed_by UUID, ADD COLUMN close_note TEXT, ADD COLUMN reopened_at TIMESTAMPTZ, ADD COLUMN reopened_by UUID, ADD COLUMN reopen_reason TEXT;
CREATE TABLE year_end_closings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID NOT NULL,
  from_date DATE NOT NULL, to_date DATE NOT NULL, closing_date DATE NOT NULL,
  retained_account_id UUID NOT NULL,
  revenue_total NUMERIC(18,4) NOT NULL, expense_total NUMERIC(18,4) NOT NULL, net_income NUMERIC(18,4) NOT NULL,
  accounts_closed INT NOT NULL,
  journal_entry_id UUID NOT NULL REFERENCES journal_entries(id),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  reversal_entry_id UUID REFERENCES journal_entries(id), reverse_reason TEXT, reversed_at TIMESTAMPTZ,
  created_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (retained_account_id, company_id) REFERENCES accounts (id, company_id),
  CHECK (from_date <= to_date AND closing_date BETWEEN from_date AND to_date),
  CHECK (status <> 'reversed' OR (reversal_entry_id IS NOT NULL AND reverse_reason IS NOT NULL))
);
ALTER TABLE year_end_closings ENABLE ROW LEVEL SECURITY;
INSERT INTO permissions(code) VALUES ('accounting.period.close'), ('accounting.period.reopen'), ('accounting.yearend.close') ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_id, permission_id, scope)
SELECT r.id, p.id, 'all_branches' FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Owner' AND r.is_system_role = TRUE AND p.code IN ('accounting.period.close','accounting.period.reopen','accounting.yearend.close')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- منع ترحيل أي قيد في فترة مقفلة — على مستوى قاعدة البيانات فتغطي كل المسارات (النواة والإضافات) دون تعديل كودها.
CREATE OR REPLACE FUNCTION forbid_posting_in_closed_period() RETURNS TRIGGER AS $$
DECLARE st TEXT;
BEGIN
  IF NEW.status = 'posted' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'posted') THEN
    SELECT status INTO st FROM fiscal_periods WHERE id = NEW.fiscal_period_id;
    IF st = 'closed' THEN
      RAISE EXCEPTION 'الفترة المالية مقفلة — لا يمكن ترحيل قيد فيها' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_forbid_posting_in_closed_period BEFORE INSERT OR UPDATE OF status ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_posting_in_closed_period();

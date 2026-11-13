-- 0058_claim_credit_notes_fx_posting.sql
-- (1) إشعار دائن لتسوية مطالبة الجودة (قيد: مدين مسموحات/مردودات مبيعات ← دائن حساب العميل)، مرتبط بالمطالبة.
-- (2) ترحيل قيد تقييم العملات الأجنبية (غير محقَّق) مع قيد عكسي بتاريخ لاحق، حتى لا يتكرر مع فرق السداد المحقَّق.
ALTER TABLE companies ADD COLUMN sales_allowance_account_id UUID;
ALTER TABLE companies ADD COLUMN fx_unrealized_account_id UUID;
ALTER TABLE companies ADD FOREIGN KEY (sales_allowance_account_id, id) REFERENCES accounts (id, company_id);
ALTER TABLE companies ADD FOREIGN KEY (fx_unrealized_account_id, id) REFERENCES accounts (id, company_id);

CREATE TABLE claim_credit_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID NOT NULL,
  note_no TEXT NOT NULL,
  claim_id UUID NOT NULL REFERENCES quality_claims(id),
  customer_id UUID NOT NULL,
  sales_invoice_id UUID REFERENCES sales_invoices(id),
  note_date DATE NOT NULL,
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  reason TEXT,
  journal_entry_id UUID NOT NULL REFERENCES journal_entries(id),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  reversal_entry_id UUID REFERENCES journal_entries(id),
  reversed_at TIMESTAMPTZ, reverse_reason TEXT,
  created_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, note_no),
  FOREIGN KEY (customer_id, company_id) REFERENCES customers (id, company_id),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  CHECK (status <> 'reversed' OR (reversal_entry_id IS NOT NULL AND reverse_reason IS NOT NULL))
);
CREATE UNIQUE INDEX uq_claim_credit_note_active ON claim_credit_notes(claim_id) WHERE status = 'posted';
CREATE INDEX idx_claim_credit_notes_customer ON claim_credit_notes(company_id, customer_id, note_date DESC);
ALTER TABLE claim_credit_notes ENABLE ROW LEVEL SECURITY;

CREATE TABLE fx_revaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID NOT NULL,
  as_of DATE NOT NULL,
  net_amount NUMERIC(18,4) NOT NULL,
  detail JSONB,
  journal_entry_id UUID NOT NULL REFERENCES journal_entries(id),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  reversal_date DATE,
  reversal_entry_id UUID REFERENCES journal_entries(id),
  created_by UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  CHECK (status <> 'reversed' OR (reversal_entry_id IS NOT NULL AND reversal_date IS NOT NULL AND reversal_date > as_of))
);
-- تقييم واحد فعّال في آن واحد: لا يُرحَّل تقييم جديد قبل عكس السابق.
CREATE UNIQUE INDEX uq_fx_reval_active ON fx_revaluations(company_id) WHERE status = 'posted';
ALTER TABLE fx_revaluations ENABLE ROW LEVEL SECURITY;

INSERT INTO permissions(code) VALUES ('textile.claims.credit'), ('fx.reval.post') ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_id, permission_id, scope)
SELECT r.id, p.id, 'all_branches' FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Owner' AND r.is_system_role = TRUE AND p.code IN ('textile.claims.credit','fx.reval.post')
ON CONFLICT (role_id, permission_id) DO NOTHING;

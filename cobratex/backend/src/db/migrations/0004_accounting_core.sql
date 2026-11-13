-- 0004_accounting_core.sql

CREATE TABLE currencies (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
INSERT INTO currencies(code, name) VALUES ('EGP','Egyptian Pound'), ('USD','US Dollar'), ('EUR','Euro');

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('asset','liability','equity','revenue','expense')),
  parent_id UUID,
  is_control_account BOOLEAN NOT NULL DEFAULT false,
  currency_code TEXT REFERENCES currencies(code),
  UNIQUE (id, company_id),
  UNIQUE (company_id, code),
  FOREIGN KEY (parent_id, company_id) REFERENCES accounts (id, company_id)
);

CREATE TABLE cost_centers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  parent_id UUID,
  UNIQUE (id, company_id),
  FOREIGN KEY (parent_id, company_id) REFERENCES cost_centers (id, company_id)
);

CREATE TABLE fiscal_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  UNIQUE (id, company_id),
  UNIQUE (company_id, start_date, end_date),
  CHECK (end_date > start_date)
);

CREATE TABLE journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID NOT NULL,
  activity_id UUID,
  project_id UUID,
  fiscal_period_id UUID NOT NULL,
  entry_date DATE NOT NULL,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  exchange_rate NUMERIC(18,6) NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_review','approved','posted','rejected','cancelled','reversed')),
  source_document_type TEXT,
  source_document_id UUID,
  reversal_of_entry_id UUID REFERENCES journal_entries(id),
  cancelled_reason TEXT,
  cancelled_by UUID,
  cancelled_at TIMESTAMPTZ,
  created_by UUID,
  posted_by UUID,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (activity_id, company_id) REFERENCES activities (id, company_id),
  FOREIGN KEY (project_id, company_id) REFERENCES projects (id, company_id),
  FOREIGN KEY (fiscal_period_id, company_id) REFERENCES fiscal_periods (id, company_id)
);

CREATE TABLE journal_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id UUID NOT NULL REFERENCES journal_entries(id),
  company_id UUID NOT NULL,
  account_id UUID NOT NULL,
  cost_center_id UUID,
  debit NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  description TEXT,
  -- سطر واحد لا يكون مدينًا ودائنًا معًا (تحقق صف مفرد صالح لـ CHECK عادي)
  CHECK (NOT (debit > 0 AND credit > 0)),
  FOREIGN KEY (account_id, company_id) REFERENCES accounts (id, company_id),
  FOREIGN KEY (cost_center_id, company_id) REFERENCES cost_centers (id, company_id)
);
CREATE INDEX idx_journal_lines_entry ON journal_lines(journal_entry_id);
CREATE INDEX idx_journal_entries_company_period ON journal_entries(company_id, fiscal_period_id);
CREATE INDEX idx_journal_entries_status ON journal_entries(company_id, status);

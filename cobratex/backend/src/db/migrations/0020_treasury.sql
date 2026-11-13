-- 0020_treasury.sql
-- وحدة الخزائن والبنوك: كيان خزينة/بنك حقيقي (بدل استخدام حساب "نقدية" عادي مباشرة)، سندات
-- قبض/صرف، تحويلات بين خزينتين/بنكين، وشيكات واردة/صادرة بدورة حياة صريحة.

CREATE TABLE safe_or_banks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID NOT NULL,
  code TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('safe','bank')),
  linked_account_id UUID NOT NULL, -- يُنشأ ذريًا مع الخزينة، بنفس نمط العملاء/الموردين
  bank_name TEXT,
  account_number TEXT,
  iban TEXT,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, code),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (linked_account_id, company_id) REFERENCES accounts (id, company_id),
  CHECK (kind = 'safe' OR (bank_name IS NOT NULL AND account_number IS NOT NULL))
);

/* ============================== سندات القبض والصرف ============================== */
CREATE TABLE treasury_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  branch_id UUID NOT NULL,
  safe_or_bank_id UUID NOT NULL,
  document_number TEXT NOT NULL,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('receipt','payment')),
  counterparty_type TEXT NOT NULL CHECK (counterparty_type IN ('customer','supplier','other')),
  counterparty_customer_id UUID,
  counterparty_supplier_id UUID,
  contra_account_id UUID, -- إلزامي فقط عند counterparty_type='other' (مثال: إيراد متنوع، مصروف، رأس مال)
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  exchange_rate NUMERIC(18,6) NOT NULL DEFAULT 1,
  transaction_date DATE NOT NULL,
  fiscal_period_id UUID NOT NULL,
  description TEXT,
  activity_id UUID,
  project_id UUID,
  cost_center_id UUID,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled','reversed')),
  journal_entry_id UUID REFERENCES journal_entries(id),
  cancelled_reason TEXT,
  cancelled_by UUID,
  cancelled_at TIMESTAMPTZ,
  created_by UUID,
  posted_by UUID,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, branch_id, document_number),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (safe_or_bank_id, company_id) REFERENCES safe_or_banks (id, company_id),
  FOREIGN KEY (counterparty_customer_id, company_id) REFERENCES customers (id, company_id),
  FOREIGN KEY (counterparty_supplier_id, company_id) REFERENCES suppliers (id, company_id),
  FOREIGN KEY (contra_account_id, company_id) REFERENCES accounts (id, company_id),
  FOREIGN KEY (fiscal_period_id, company_id) REFERENCES fiscal_periods (id, company_id),
  FOREIGN KEY (activity_id, company_id) REFERENCES activities (id, company_id),
  FOREIGN KEY (project_id, company_id) REFERENCES projects (id, company_id),
  FOREIGN KEY (cost_center_id, company_id) REFERENCES cost_centers (id, company_id),
  CHECK (
    (counterparty_type = 'customer' AND counterparty_customer_id IS NOT NULL AND counterparty_supplier_id IS NULL AND contra_account_id IS NULL) OR
    (counterparty_type = 'supplier' AND counterparty_supplier_id IS NOT NULL AND counterparty_customer_id IS NULL AND contra_account_id IS NULL) OR
    (counterparty_type = 'other' AND contra_account_id IS NOT NULL AND counterparty_customer_id IS NULL AND counterparty_supplier_id IS NULL)
  )
);

/* ============================== تحويلات بين خزينتين/بنكين ============================== */
CREATE TABLE treasury_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  branch_id UUID NOT NULL,
  from_safe_or_bank_id UUID NOT NULL,
  to_safe_or_bank_id UUID NOT NULL,
  document_number TEXT NOT NULL,
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  exchange_rate NUMERIC(18,6) NOT NULL DEFAULT 1,
  transfer_date DATE NOT NULL,
  fiscal_period_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled','reversed')),
  journal_entry_id UUID REFERENCES journal_entries(id),
  cancelled_reason TEXT,
  cancelled_by UUID,
  cancelled_at TIMESTAMPTZ,
  created_by UUID,
  posted_by UUID,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, branch_id, document_number),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (from_safe_or_bank_id, company_id) REFERENCES safe_or_banks (id, company_id),
  FOREIGN KEY (to_safe_or_bank_id, company_id) REFERENCES safe_or_banks (id, company_id),
  FOREIGN KEY (fiscal_period_id, company_id) REFERENCES fiscal_periods (id, company_id),
  CHECK (from_safe_or_bank_id <> to_safe_or_bank_id)
);

/* ============================== الشيكات (واردة وصادرة) ============================== */
CREATE TABLE checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  branch_id UUID NOT NULL,
  safe_or_bank_id UUID NOT NULL,
  check_type TEXT NOT NULL CHECK (check_type IN ('incoming','outgoing')),
  check_number TEXT NOT NULL,
  check_date DATE NOT NULL,
  due_date DATE NOT NULL,
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  counterparty_customer_id UUID,
  counterparty_supplier_id UUID,
  -- دورة الحياة: pending -> deposited -> cleared|bounced ، أو pending -> cancelled
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','deposited','cleared','bounced','cancelled')),
  treasury_transaction_id UUID REFERENCES treasury_transactions(id), -- يُربط فقط عند التحصيل/الصرف الفعلي (cleared)
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, safe_or_bank_id, check_type, check_number),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (safe_or_bank_id, company_id) REFERENCES safe_or_banks (id, company_id),
  FOREIGN KEY (counterparty_customer_id, company_id) REFERENCES customers (id, company_id),
  FOREIGN KEY (counterparty_supplier_id, company_id) REFERENCES suppliers (id, company_id),
  CHECK (
    (check_type = 'incoming' AND counterparty_customer_id IS NOT NULL AND counterparty_supplier_id IS NULL) OR
    (check_type = 'outgoing' AND counterparty_supplier_id IS NOT NULL AND counterparty_customer_id IS NULL)
  )
);

INSERT INTO permissions(code) VALUES
  ('treasury.safe.create'), ('treasury.safe.view'),
  ('treasury.transaction.create'), ('treasury.transaction.view'), ('treasury.transaction.post'), ('treasury.transaction.reverse'),
  ('treasury.transfer.create'), ('treasury.transfer.view'), ('treasury.transfer.post'), ('treasury.transfer.reverse'),
  ('treasury.check.create'), ('treasury.check.view'), ('treasury.check.transition')
ON CONFLICT (code) DO NOTHING;

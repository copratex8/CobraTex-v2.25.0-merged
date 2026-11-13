-- 0031_bank_reconciliation.sql
-- تسوية بنكية: الموجود سابقًا فقط دورة حياة الشيك (checks) بلا أي استيراد لكشف حساب بنكي ولا
-- مطابقة. المطابقة هنا ضد treasury_transactions/treasury_transfers المرحَّلة مباشرة — لا حاجة
-- لمطابقة checks بشكل منفصل: أي شيك يصل لحالة 'cleared' يُنشئ وير حِّل treasury_transaction فعليًا
-- (راجع checkService.transitionCheckStatus)، فيظهر أثره هنا تلقائيًا عبر تلك المعاملة.
CREATE TABLE bank_reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID NOT NULL,
  safe_or_bank_id UUID NOT NULL,
  statement_date DATE NOT NULL,
  -- الرصيد الافتتاحي (من كشف الفترة السابقة أو تسوية سابقة مكتملة لنفس الخزينة/البنك) + مجموع
  -- كل أسطر الكشف المُطابَقة يجب أن يساوي statement_ending_balance تمامًا حتى تكتمل التسوية.
  opening_balance NUMERIC(18,4) NOT NULL DEFAULT 0,
  statement_ending_balance NUMERIC(18,4) NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  created_by UUID,
  completed_by UUID,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (safe_or_bank_id, company_id) REFERENCES safe_or_banks (id, company_id)
);

CREATE INDEX idx_bank_reconciliations_safe ON bank_reconciliations(safe_or_bank_id);

CREATE TABLE bank_statement_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id UUID NOT NULL REFERENCES bank_reconciliations(id),
  company_id UUID NOT NULL REFERENCES companies(id),
  line_date DATE NOT NULL,
  description TEXT,
  -- موجب = إيداع بنكي (Credit من منظور البنك)، سالب = سحب/خصم بنكي (Debit من منظور البنك).
  amount NUMERIC(18,4) NOT NULL CHECK (amount <> 0),
  reference TEXT,
  matched_treasury_transaction_id UUID REFERENCES treasury_transactions(id),
  matched_treasury_transfer_id UUID REFERENCES treasury_transfers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- سطر كشف واحد يُطابَق مستندًا واحدًا كحد أقصى (لا كليهما معًا).
  CHECK (matched_treasury_transaction_id IS NULL OR matched_treasury_transfer_id IS NULL)
);

CREATE INDEX idx_bank_statement_lines_reconciliation ON bank_statement_lines(reconciliation_id);
-- يمنع مطابقة نفس معاملة الخزينة/التحويل لأكثر من سطر كشف واحد (في أي تسوية) في آنٍ واحد.
CREATE UNIQUE INDEX idx_bank_statement_lines_unique_tx_match ON bank_statement_lines(matched_treasury_transaction_id) WHERE matched_treasury_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX idx_bank_statement_lines_unique_transfer_match ON bank_statement_lines(matched_treasury_transfer_id) WHERE matched_treasury_transfer_id IS NOT NULL;

INSERT INTO permissions(code) VALUES
  ('treasury.reconciliation.create'),
  ('treasury.reconciliation.view'),
  ('treasury.reconciliation.match'),
  ('treasury.reconciliation.complete')
ON CONFLICT (code) DO NOTHING;

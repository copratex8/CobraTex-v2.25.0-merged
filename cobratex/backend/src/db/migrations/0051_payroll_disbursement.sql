-- 0051_payroll_disbursement.sql: ربط كشف الرواتب المُرحَّل بسند صرف خزينة (مدين رواتب مستحقة / دائن خزينة أو بنك).
ALTER TABLE payroll_runs ADD COLUMN payment_transaction_id UUID REFERENCES treasury_transactions(id), ADD COLUMN paid_at TIMESTAMPTZ;
CREATE UNIQUE INDEX uq_payroll_payment ON payroll_runs(payment_transaction_id) WHERE payment_transaction_id IS NOT NULL;

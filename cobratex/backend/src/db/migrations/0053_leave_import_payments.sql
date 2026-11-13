-- 0053: (١) رصيد الإجازات السنوي لكل عامل  (٢) صرف الرواتب على دفعات (payroll_payments) بدل سند واحد
ALTER TABLE textile_workers ADD COLUMN annual_leave_days NUMERIC(5,1) NOT NULL DEFAULT 21 CHECK (annual_leave_days >= 0 AND annual_leave_days <= 366);

CREATE TABLE payroll_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  run_id UUID NOT NULL REFERENCES payroll_runs(id),
  transaction_id UUID NOT NULL REFERENCES treasury_transactions(id),
  amount NUMERIC(16,2) NOT NULL CHECK (amount > 0),
  paid_by UUID,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (transaction_id)
);
CREATE INDEX idx_payroll_payments_run ON payroll_payments(run_id);
ALTER TABLE payroll_payments ENABLE ROW LEVEL SECURITY;
INSERT INTO payroll_payments(company_id, run_id, transaction_id, amount, paid_by, paid_at)
SELECT company_id, id, payment_transaction_id, total_net, posted_by, COALESCE(paid_at, now()) FROM payroll_runs WHERE payment_transaction_id IS NOT NULL;
DROP INDEX IF EXISTS uq_payroll_payment;
ALTER TABLE payroll_runs DROP COLUMN payment_transaction_id, DROP COLUMN paid_at;

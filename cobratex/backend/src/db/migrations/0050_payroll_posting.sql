-- 0050_payroll_posting.sql: ترحيل كشف الرواتب المعتمد إلى قيد محاسبي (اختياري، بخطوة منفصلة).
-- الحسابات الأربعة تُنشأ عند أول استخدام (أكواد 5060/2060/2070/1060) ويمكن تبديلها من جدول الإعداد.
CREATE TABLE payroll_account_settings (
  company_id UUID PRIMARY KEY REFERENCES companies(id),
  wages_expense_account_id UUID NOT NULL REFERENCES accounts(id),
  salaries_payable_account_id UUID NOT NULL REFERENCES accounts(id),
  insurance_payable_account_id UUID NOT NULL REFERENCES accounts(id),
  advances_account_id UUID NOT NULL REFERENCES accounts(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE payroll_account_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_runs ADD COLUMN journal_entry_id UUID REFERENCES journal_entries(id), ADD COLUMN posted_at TIMESTAMPTZ, ADD COLUMN posted_by UUID;
CREATE UNIQUE INDEX uq_payroll_je ON payroll_runs(journal_entry_id) WHERE journal_entry_id IS NOT NULL;
INSERT INTO permissions(code) VALUES ('textile.payroll.post') ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_id, permission_id, scope)
SELECT r.id, p.id, 'all_branches' FROM roles r CROSS JOIN permissions p WHERE r.name='Owner' AND r.is_system_role=TRUE AND p.code='textile.payroll.post'
ON CONFLICT (role_id, permission_id) DO NOTHING;

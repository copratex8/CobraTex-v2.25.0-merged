-- 0052_employer_insurance.sql: حصة صاحب العمل في التأمينات الاجتماعية (% من الأساسي). لا تُخصم من العامل؛ تدخل قيد الرواتب (مدين أجور / دائن تأمينات مستحقة).
ALTER TABLE textile_workers ADD COLUMN employer_insurance_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (employer_insurance_percent >= 0 AND employer_insurance_percent <= 100);
ALTER TABLE payroll_lines ADD COLUMN employer_insurance NUMERIC(14,2) NOT NULL DEFAULT 0;

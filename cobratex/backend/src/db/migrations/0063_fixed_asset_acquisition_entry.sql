-- 0063: ربط الأصل بقيد الاقتناء الاختياري المرحَّل من السجل (Dr حساب الأصل / Cr حساب المقابل).
ALTER TABLE fixed_assets ADD COLUMN acquisition_entry_id UUID REFERENCES journal_entries(id);

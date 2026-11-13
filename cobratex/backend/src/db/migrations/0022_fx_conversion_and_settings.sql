-- 0022_fx_conversion_and_settings.sql
-- المرحلة: تفعيل فروق العملة فعليًا، بعد توحيد تحويل العملة عبر كل الوحدات (تم في نفس هذه المرحلة
-- عبر تعديل تطبيقي واحد في createDraftJournalEntry، لا يحتاج migration). هذه المهاجرة تضيف فقط
-- حساب فرق العملة على مستوى الشركة، وصلاحية تعديل إعدادات الشركة.

ALTER TABLE companies ADD COLUMN fx_gain_loss_account_id UUID;
ALTER TABLE companies ADD FOREIGN KEY (fx_gain_loss_account_id, id) REFERENCES accounts (id, company_id);

INSERT INTO permissions(code) VALUES ('company.settings.update')
ON CONFLICT (code) DO NOTHING;

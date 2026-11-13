-- 0070_attachments_storage.sql — المرفقات في Supabase Storage (2.21.0): عمود المسار + محتوى القاعدة اختياري (متوافق للخلف).
-- idempotent: آمنة لو سبق تشغيل supabase/migrations/…_storage_attachments.sql (الذي يضيف العمود نفسه).
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS storage_path TEXT;
ALTER TABLE attachments ALTER COLUMN file_data DROP NOT NULL;
DO $$ BEGIN
  ALTER TABLE attachments ADD CONSTRAINT attachments_has_content CHECK (file_data IS NOT NULL OR storage_path IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

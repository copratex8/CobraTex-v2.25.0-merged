-- 0032_attachments.sql
-- مرفقات ملفات (صور أصناف، فواتير ممسوحة ضوئيًا...) — لم يكن هناك أي تخزين ملفات مُفعَّل إطلاقًا.
--
-- قرار تخزين متعمَّد: BYTEA داخل PostgreSQL نفسه، لا القرص المحلي للخادم ولا S3/تخزين سحابي خارجي.
-- السبب: النشر الموثَّق لهذا المشروع (render.yaml) هو Render Free Web Service بقرص مؤقت (ephemeral) —
-- أي ملف يُكتب على قرص الخادم يُفقَد عند أي إعادة نشر أو إعادة تشغيل، فلا يصلح كتخزين دائم إطلاقًا.
-- التخزين داخل قاعدة البيانات نفسها (Neon/Supabase المجانية أيضًا، الموثَّقتان في نفس الملف) يضمن
-- بقاء المرفق طالما بقيت بقية بيانات الشركة، بلا أي خدمة خارجية إضافية أو بيانات اعتماد جديدة يحتاج
-- المستخدم إعدادها. الكلفة: يستهلك حصة تخزين القاعدة (غالبًا محدودة على الخطط المجانية) — لذلك حجم
-- الملف مُقيَّد بصرامة عند الرفع (5MB، مفروض في الخدمة). ترقية لاحقة لتخزين سحابي (S3-compatible)
-- ممكنة متى احتاج المشروع ذلك فعليًا، بإبقاء نفس واجهة الجدول (استبدال file_data بـ storage_key).
CREATE TABLE attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID NOT NULL,
  -- ربط عام (polymorphic) بلا FK فعلي لكل كيان ممكن — entity_type من قائمة مُتحقَّق منها بالتطبيق
  -- (راجع attachmentService.ts)، وentity_id يُتحقَّق من انتمائه لنفس الشركة عند الرفع.
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INT NOT NULL,
  file_data BYTEA NOT NULL,
  uploaded_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id)
);

CREATE INDEX idx_attachments_entity ON attachments(company_id, entity_type, entity_id);

INSERT INTO permissions(code) VALUES
  ('attachments.upload'),
  ('attachments.view'),
  ('attachments.delete')
ON CONFLICT (code) DO NOTHING;

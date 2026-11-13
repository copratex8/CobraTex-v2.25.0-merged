-- 0059_activity_profiles.sql
-- ملف نشاط الشركة (تصنيع/تجارة/صباغة/تجهيز/متكامل…) + تجاوزات الوحدات بيد المطوّر فقط.
-- الافتراضي «integrated» = كل الوحدات مفعّلة، فلا يتغيّر شيء على العملاء الحاليين.
ALTER TABLE companies ADD COLUMN activity_profile TEXT NOT NULL DEFAULT 'integrated';
CREATE TABLE company_modules (
  company_id UUID NOT NULL REFERENCES companies(id),
  module_key TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, module_key)
);
ALTER TABLE company_modules ENABLE ROW LEVEL SECURITY;

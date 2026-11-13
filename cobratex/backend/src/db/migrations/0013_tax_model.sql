-- 0013_tax_model.sql
-- الضريبة قابلة للتهيئة بالكامل: النوع/النسبة/الحساب/شامل أو غير شامل/التقريب/تاريخ السريان.
-- "تغيير نسبة الضريبة" لا يُعدِّل صفًا قائمًا (قد تكون مستخدمة في فواتير مرحّلة تاريخيًا)، بل يُغلق
-- الإصدار الحالي بتاريخ (effective_to) وينشئ إصدارًا جديدًا (tax_rates سجل Append مع نطاق تاريخ) —
-- هذا يحافظ على دقة الفواتير القديمة بنفس النسبة التي كانت سارية وقت إصدارها.

CREATE TABLE tax_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  sales_tax_account_id UUID,   -- حساب ضريبة المبيعات (دائن عند البيع)
  purchase_tax_account_id UUID, -- حساب ضريبة المشتريات القابلة للخصم (مدين عند الشراء)
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (id, company_id),
  FOREIGN KEY (sales_tax_account_id, company_id) REFERENCES accounts (id, company_id),
  FOREIGN KEY (purchase_tax_account_id, company_id) REFERENCES accounts (id, company_id)
);

CREATE TABLE tax_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_type_id UUID NOT NULL,
  company_id UUID NOT NULL,
  rate_percent NUMERIC(6,3) NOT NULL CHECK (rate_percent >= 0 AND rate_percent <= 100),
  is_price_inclusive BOOLEAN NOT NULL DEFAULT false,
  is_exempt BOOLEAN NOT NULL DEFAULT false, -- نسبة 0 كإعفاء صريح، تمييزًا عن "لا ضريبة مطبَّقة إطلاقًا"
  rounding_mode TEXT NOT NULL DEFAULT 'half_even' CHECK (rounding_mode IN ('half_up','half_even')),
  effective_from DATE NOT NULL,
  effective_to DATE, -- NULL = الإصدار الساري حاليًا
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  FOREIGN KEY (tax_type_id, company_id) REFERENCES tax_types (id, company_id),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
-- إصدار "ساري حاليًا" واحد فقط لكل نوع ضريبة (فهرس جزئي)
CREATE UNIQUE INDEX uq_tax_rate_current_version ON tax_rates(tax_type_id) WHERE effective_to IS NULL;
CREATE INDEX idx_tax_rates_lookup ON tax_rates(tax_type_id, effective_from, effective_to);

INSERT INTO permissions(code) VALUES
  ('accounting.tax.manage')
ON CONFLICT (code) DO NOTHING;

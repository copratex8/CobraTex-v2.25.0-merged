-- 0057_fx_rates_currencies.sql
-- أسعار الصرف اليومية (متوسط/شراء/بيع) لكل عملة مقابل عملة أساس الشركة، وإدارة العملات (رمز/خانات عشرية/تفعيل).
-- المستندات تجلب السعر تلقائيًا عند غيابه (بدل السكوت على 1). تقييم الأرصدة الأجنبية تقرير تحليلي بلا ترحيل.
ALTER TABLE currencies ADD COLUMN name_ar TEXT;
ALTER TABLE currencies ADD COLUMN symbol TEXT;
ALTER TABLE currencies ADD COLUMN decimals INT NOT NULL DEFAULT 2 CHECK (decimals BETWEEN 0 AND 4);
ALTER TABLE currencies ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;
UPDATE currencies SET name_ar='جنيه مصري', symbol='ج.م' WHERE code='EGP';
UPDATE currencies SET name_ar='دولار أمريكي', symbol='$' WHERE code='USD';
UPDATE currencies SET name_ar='يورو', symbol='€' WHERE code='EUR';
INSERT INTO currencies(code, name, name_ar, symbol, decimals) VALUES
  ('SAR','Saudi Riyal','ريال سعودي','ر.س',2), ('AED','UAE Dirham','درهم إماراتي','د.إ',2), ('KWD','Kuwaiti Dinar','دينار كويتي','د.ك',3),
  ('QAR','Qatari Riyal','ريال قطري','ر.ق',2), ('GBP','Pound Sterling','جنيه إسترليني','£',2), ('CNY','Chinese Yuan','يوان صيني','¥',2),
  ('TRY','Turkish Lira','ليرة تركية','₺',2), ('INR','Indian Rupee','روبية هندية','₹',2), ('JPY','Japanese Yen','ين ياباني','¥',0),
  ('CHF','Swiss Franc','فرنك سويسري','CHF',2), ('PKR','Pakistani Rupee','روبية باكستانية','Rs',2), ('BDT','Bangladeshi Taka','تاكا بنغلاديشية','৳',2)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE exchange_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  rate_date DATE NOT NULL,
  rate_type TEXT NOT NULL DEFAULT 'mid' CHECK (rate_type IN ('mid','buy','sell')),
  -- وحدات عملة الأساس لكل 1 وحدة من currency_code
  rate NUMERIC(18,6) NOT NULL CHECK (rate > 0),
  source TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, currency_code, rate_date, rate_type)
);
CREATE INDEX idx_fx_rates_lookup ON exchange_rates(company_id, currency_code, rate_type, rate_date DESC);
ALTER TABLE exchange_rates ENABLE ROW LEVEL SECURITY;
INSERT INTO permissions(code) VALUES ('fx.rates.view'), ('fx.rates.manage'), ('fx.reval.view') ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_id, permission_id, scope)
SELECT r.id, p.id, 'all_branches' FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Owner' AND r.is_system_role = TRUE AND p.code IN ('fx.rates.view','fx.rates.manage','fx.reval.view')
ON CONFLICT (role_id, permission_id) DO NOTHING;

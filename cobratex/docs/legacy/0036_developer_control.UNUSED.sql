-- 0036_developer_control.sql
-- لوحة المطور الخارجية (CobraTex Developer Panel): تحكم عن بُعد بتشغيل/إيقاف النظام لكل عميل (Tenant)،
-- مفتاح إيقاف شامل، وإشعارات تظهر على شاشة تسجيل الدخول وداخل التطبيق.
-- جداول عامة على مستوى المنصة (ليست تابعة لشركة) — يكتب فيها المطوّر فقط عبر /api/dev/* (محمي بـ DEVELOPER_SECRET).
-- لا تعدّل أي جدول موجود. غياب صف الترخيص = العميل "نشط" (سلوك جي تك الأصلي يبقى كما هو).

CREATE TABLE developer_license (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'expired')),
  message TEXT,
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE developer_notice (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE, -- NULL = يظهر لكل العملاء
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'critical')),
  title TEXT NOT NULL,
  body TEXT,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_developer_notice_active ON developer_notice (is_active, starts_at, ends_at);

CREATE TABLE developer_setting (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO developer_setting (key, value) VALUES ('global', '{"enabled": true, "message": ""}');

CREATE TABLE developer_audit (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- أمان Supabase: تفعيل RLS بلا سياسات يمنع واجهة REST العامة (anon key) من قراءة/كتابة هذه الجداول.
-- الباك إند يتصل بدور المالك (postgres) الذي يتجاوز RLS، فلا يتأثر.
ALTER TABLE developer_license ENABLE ROW LEVEL SECURITY;
ALTER TABLE developer_notice ENABLE ROW LEVEL SECURITY;
ALTER TABLE developer_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE developer_audit ENABLE ROW LEVEL SECURITY;

-- 0036_platform_control.sql
-- لوحة المطور الخارجية (Remote Control Plane): جداول على مستوى المنصة كلها (ليست تابعة لشركة معيّنة).
-- لا تمس أي جدول قائم. الحالة الافتراضية = "active" فلا يتغير سلوك النظام قبل أن يستخدمها المطور.

-- إعدادات المنصة العامة (المفتاح 'service' = حالة التشغيل العامة لكل العملاء).
CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO platform_settings(key, value)
VALUES ('service', '{"status":"active","message":""}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- إيقاف/تشغيل عميل (Tenant) بعينه دون التأثير على غيره.
CREATE TABLE IF NOT EXISTS tenant_service_status (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  message TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- إشعارات شاشة تسجيل الدخول: tenant_id = NULL تعني لكل العملاء.
CREATE TABLE IF NOT EXISTS platform_announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'success', 'warning', 'critical')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_platform_announcements_active ON platform_announcements (is_active, tenant_id);

-- سجل تدقيق لكل أمر تحكم صادر من لوحة المطور.
CREATE TABLE IF NOT EXISTS platform_audit (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

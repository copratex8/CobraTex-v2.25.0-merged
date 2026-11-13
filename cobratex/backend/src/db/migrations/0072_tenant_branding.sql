-- 0072_tenant_branding.sql — هوية مستقلة لكل عميل داخل نشر واحد (2.23.0). تُدار من لوحة المطور.
CREATE TABLE tenant_branding (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  slug TEXT UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),   -- رابط قصير: /?c=acme
  brand JSONB NOT NULL DEFAULT '{}'::jsonb,                                -- مفاتيح مسموحة فقط (انظر brandingService)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE tenant_domains (
  host TEXT PRIMARY KEY CHECK (host = lower(host)),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX idx_tenant_domains_tenant ON tenant_domains(tenant_id);
ALTER TABLE tenant_branding ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_domains ENABLE ROW LEVEL SECURITY;

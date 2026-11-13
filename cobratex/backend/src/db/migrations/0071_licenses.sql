-- 0071_licenses.sql — التراخيص تُدار من لوحة المطور (2.22.0).
-- لا صف ترخيص = عميل قديم بلا قيود (إلا إن ضُبط LICENSE_REQUIRED=1 على الخادم).
CREATE TABLE tenant_licenses (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  plan_type TEXT NOT NULL CHECK (plan_type IN ('trial','monthly','annual','perpetual','custom')),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,                      -- NULL = دائم
  grace_days INTEGER NOT NULL DEFAULT 7 CHECK (grace_days BETWEEN 0 AND 365),
  expired_mode TEXT NOT NULL DEFAULT 'readonly' CHECK (expired_mode IN ('readonly','block')),
  binding_mode TEXT NOT NULL DEFAULT 'none' CHECK (binding_mode IN ('none','domain','device','domain_device')),
  allowed_domains TEXT[] NOT NULL DEFAULT '{}',
  max_devices INTEGER CHECK (max_devices IS NULL OR max_devices >= 1),
  max_users INTEGER CHECK (max_users IS NULL OR max_users >= 1),
  max_branches INTEGER CHECK (max_branches IS NULL OR max_branches >= 1),
  notes TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT license_perpetual_no_expiry CHECK (plan_type <> 'perpetual' OR expires_at IS NULL),
  CONSTRAINT license_timed_has_expiry CHECK (plan_type = 'perpetual' OR expires_at IS NOT NULL)
);
CREATE TABLE license_devices (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  revoked BOOLEAN NOT NULL DEFAULT false,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, device_id)
);
ALTER TABLE tenant_licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_devices ENABLE ROW LEVEL SECURITY;

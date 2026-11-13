-- 0002_identity_rbac.sql

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  company_id UUID REFERENCES companies(id),
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  mfa_secret TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE TABLE roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  is_system_role BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (id, company_id),
  UNIQUE (company_id, name)
);

CREATE TABLE permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE -- مثال: sales.invoice.create
);

CREATE TABLE role_permissions (
  role_id UUID NOT NULL REFERENCES roles(id),
  permission_id UUID NOT NULL REFERENCES permissions(id),
  scope TEXT NOT NULL DEFAULT 'own_branch' CHECK (scope IN ('own_branch','multi_branch','all_branches')),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
  user_id UUID NOT NULL REFERENCES users(id),
  role_id UUID NOT NULL,
  company_id UUID NOT NULL,
  PRIMARY KEY (user_id, role_id),
  FOREIGN KEY (role_id, company_id) REFERENCES roles (id, company_id)
);

CREATE TABLE user_branch_scopes (
  user_id UUID NOT NULL REFERENCES users(id),
  branch_id UUID NOT NULL,
  company_id UUID NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'single' CHECK (scope_type IN ('single','multi','all')),
  PRIMARY KEY (user_id, branch_id),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id)
);

-- سجل تدقيق append-only: بلا صلاحية تعديل أو حذف على مستوى التطبيق
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  company_id UUID,
  user_id UUID,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  action TEXT NOT NULL CHECK (action IN ('create','update','delete','post','reverse','cancel','login','login_failed')),
  before_json JSONB,
  after_json JSONB,
  ip_address TEXT,
  device_info TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_company_entity ON audit_logs(company_id, entity_type, entity_id);

-- منع أي UPDATE أو DELETE على سجل التدقيق بنيويًا
CREATE OR REPLACE FUNCTION forbid_audit_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();

-- 0038_backup_settings.sql
-- النسخ الاحتياطي (يدوي/تلقائي) وربط Google Drive. صف واحد فقط (id = 1) على مستوى النظام.
-- أسرار Google (client secret / refresh token) تُخزَّن مشفّرة AES-256-GCM من التطبيق، لا نصًا صريحًا.
CREATE TABLE IF NOT EXISTS backup_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  google_client_id TEXT,
  google_client_secret_enc TEXT,
  google_refresh_token_enc TEXT,
  google_account_email TEXT,
  drive_folder_id TEXT,
  drive_folder_name TEXT NOT NULL DEFAULT 'CobraTex Backups',
  auto_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  retention_count INTEGER NOT NULL DEFAULT 14 CHECK (retention_count BETWEEN 1 AND 365),
  last_backup_at TIMESTAMPTZ,
  last_backup_status TEXT,
  last_backup_error TEXT,
  last_backup_name TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO backup_settings(id) VALUES (1) ON CONFLICT (id) DO NOTHING;
ALTER TABLE backup_settings ENABLE ROW LEVEL SECURITY;

-- صلاحية إدارة النسخ الاحتياطي: تُمنح لكل أدوار "Owner" القائمة (الأدوار الجديدة تأخذها تلقائيًا من grantOwnerRole).
INSERT INTO permissions(code) VALUES ('system.backup.manage') ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_id, permission_id, scope)
SELECT r.id, p.id, 'all_branches'
FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Owner' AND r.is_system_role = TRUE AND p.code = 'system.backup.manage'
ON CONFLICT (role_id, permission_id) DO NOTHING;

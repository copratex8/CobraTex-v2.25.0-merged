-- 0073_user_admin_permissions.sql — إدارة المستخدمين والأدوار من الواجهة (2.24.0).
INSERT INTO permissions(code) VALUES ('admin.users.manage'), ('admin.roles.manage') ON CONFLICT (code) DO NOTHING;
-- يمنح كل دور مالك (Owner) قائم الصلاحيتين بنطاق all_branches (الأدوار الجديدة تأخذها من grantOwnerRole).
INSERT INTO role_permissions(role_id, permission_id, scope)
SELECT r.id, p.id, 'all_branches' FROM roles r CROSS JOIN permissions p
 WHERE r.is_system_role AND r.name = 'Owner' AND p.code IN ('admin.users.manage', 'admin.roles.manage')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- 0019_read_permissions.sql
-- بعض مسارات القراءة كانت بلا صلاحية view مخصصة إطلاقًا (items/inventory) — تُسَد هنا.
INSERT INTO permissions(code) VALUES
  ('items.item.view'),
  ('items.category.view'),
  ('inventory.balance.view')
ON CONFLICT (code) DO NOTHING;

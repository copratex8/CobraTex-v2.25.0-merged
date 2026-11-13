-- 0023_pagination_phase.sql
-- المرحلة: Pagination شامل لكل المستندات. لا تغيير في المخطط سوى صلاحية قراءة كانت ناقصة لقيود
-- اليومية (كانت الصلاحيات الموجودة كلها create/reverse/manage فقط، بلا صلاحية عرض/قائمة مخصصة).
INSERT INTO permissions(code) VALUES ('accounting.journal.view')
ON CONFLICT (code) DO NOTHING;

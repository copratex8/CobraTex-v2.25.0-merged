-- 0029_soft_toggle_permissions.sql
-- فجوة موثَّقة: لا مسار PATCH لتعطيل عميل/مورد/صنف عبر is_active رغم وجود العمود على الجداول
-- الثلاثة منذ البداية. هذه ليست حذفًا فعليًا (لا DELETE مادي موجود أصلًا في المشروع لأي من هذه
-- الكيانات) بل تعطيل/تفعيل: العميل المُعطَّل يختفي من قوائم الاختيار عند إنشاء مستندات جديدة، لكن
-- تاريخه المحاسبي والمستندات القديمة تبقى سليمة تمامًا (foreign keys لا تُمس إطلاقًا).
INSERT INTO permissions(code) VALUES
  ('sales.customer.update'),
  ('purchasing.supplier.update'),
  ('items.item.update')
ON CONFLICT (code) DO NOTHING;

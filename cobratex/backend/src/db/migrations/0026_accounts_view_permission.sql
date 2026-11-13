-- 0026_accounts_view_permission.sql
-- فجوة مُكتشَفة أثناء بناء واجهة الخزينة: لا يوجد مسار قراءة لدليل الحسابات إطلاقًا (فقط
-- POST /accounting/accounts للإنشاء)، ولا صلاحية عرض مقابلة. سند القبض/الصرف بنوع طرف مقابل
-- 'other' يتطلب اختيار contraAccountId من قائمة حسابات حقيقية في الواجهة — يضيف هذا الملف
-- الصلاحية الناقصة فقط (المسار والخدمة يُضافان في نفس المرحلة بالكود).
INSERT INTO permissions(code) VALUES
  ('accounting.account.view')
ON CONFLICT (code) DO NOTHING;

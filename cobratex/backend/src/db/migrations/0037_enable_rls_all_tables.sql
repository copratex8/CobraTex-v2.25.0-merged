-- 0037_enable_rls_all_tables.sql
-- تحصين للنشر على Supabase: كل جدول في المخطط public يُفعَّل عليه RLS (بلا سياسات = ممنوع على anon/authenticated).
-- لا أثر على الباك إند: يتصل بدور مالك الجداول (postgres في Supabase) الذي يتجاوز RLS افتراضيًا.
-- يعمل بأمان على أي PostgreSQL (التفعيل لا يغيّر سلوك المالك/المستخدم الخارق).
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;

-- 20261106000005_realtime.sql
-- Realtime respects RLS: a client only receives events for rows its SELECT policy allows (migration 03).
-- Publish document-level tables only. Do NOT add high-churn tables (journal_lines, stock_movements):
-- Free plan = 2M realtime messages / month and 200 concurrent connections.
do $$
declare t text;
begin
  foreach t in array array['sales_invoices','customer_payments','supplier_invoices','supplier_payments',
                           'treasury_transactions','checks','goods_receipts','production_orders',
                           'notifications','attachments']
  loop
    if to_regclass('public.' || t) is not null
       and not exists (select 1 from pg_publication_tables
                       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

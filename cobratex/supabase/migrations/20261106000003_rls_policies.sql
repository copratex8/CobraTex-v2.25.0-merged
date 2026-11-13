-- 20261106000003_rls_policies.sql
-- DEFAULT-DENY design. Migration 0037 already enabled RLS on every table; here we open ONLY what the
-- browser needs, and every read requires the SAME permission code Express enforces today.
--
-- Why not a blanket "company_id = my company" policy on every table? Because Express checks a
-- permission per route (accounting.*, textile.payroll.*, ...). A blanket policy would let ANY user of the
-- company read payroll, journals, and backup settings straight through the Data API.

-- 0) Hardening: browser roles never write directly. Writes happen via Express / SECURITY DEFINER RPCs.
revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate on all tables in schema public from authenticated;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke insert, update, delete, truncate on tables from authenticated;

-- 1) Opt-in helper: per-table SELECT policy = same company + permission (+ branch scope when the table has branch_id)
create or replace function app.enable_read(p_table text, p_perm text) returns void
language plpgsql as $$
declare has_branch boolean;
begin
  if to_regclass('public.' || quote_ident(p_table)) is null then
    raise notice 'enable_read: table % not found - skipped', p_table; return;
  end if;
  select exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = p_table and column_name = 'branch_id')
    into has_branch;
  execute format('drop policy if exists %I on public.%I', 'rls_read_' || p_table, p_table);
  if has_branch then
    execute format('create policy %I on public.%I for select to authenticated
                    using (company_id = app.company_id() and app.has_permission(%L, branch_id))',
                   'rls_read_' || p_table, p_table, p_perm);
  else
    execute format('create policy %I on public.%I for select to authenticated
                    using (company_id = app.company_id() and (select app.has_permission(%L)))',
                   'rls_read_' || p_table, p_table, p_perm);
  end if;
  execute format('grant select on public.%I to authenticated', p_table);
end $$;
revoke execute on function app.enable_read(text, text) from public, anon, authenticated;  -- migrations only

-- 2) Starter set: documents + masters (extend as you move more screens to supabase-js)
select app.enable_read(t, p) from (values
  ('sales_invoices','sales.invoice.view'), ('sales_orders','sales.order.view'),
  ('quotations','sales.quotation.view'),   ('sales_returns','sales.return.view'),
  ('customers','sales.customer.view'),     ('customer_payments','sales.payment.view'),
  ('purchase_orders','purchasing.order.view'), ('goods_receipts','purchasing.receipt.view'),
  ('supplier_invoices','purchasing.invoice.view'), ('supplier_payments','purchasing.payment.view'),
  ('purchase_returns','purchasing.return.view'), ('expense_invoices','purchasing.expense_invoice.view'),
  ('suppliers','purchasing.supplier.view'),
  ('treasury_transactions','treasury.transaction.view'), ('treasury_transfers','treasury.transfer.view'),
  ('checks','treasury.check.view'), ('safe_or_banks','treasury.safe.view'),
  ('bank_reconciliations','treasury.reconciliation.view'),
  ('items','items.item.view'), ('item_categories','items.category.view'),
  ('stock_balances','inventory.balance.view'), ('accounts','accounting.account.view'),
  ('production_orders','manufacturing.order.view'), ('bill_of_materials','manufacturing.bom.view'),
  ('branches','tenancy.branch.view'),
  ('attachments','attachments.view')
) as v(t, p);

-- 3) Tables with their own shape
drop policy if exists rls_read_companies on public.companies;
create policy rls_read_companies on public.companies for select to authenticated using (id = app.company_id());
grant select on public.companies to authenticated;

drop policy if exists rls_read_tenants on public.tenants;
create policy rls_read_tenants on public.tenants for select to authenticated using (id = app.tenant_id());
grant select on public.tenants to authenticated;

drop policy if exists rls_read_permissions on public.permissions;
create policy rls_read_permissions on public.permissions for select to authenticated using (true);
grant select on public.permissions to authenticated;

-- A user can see their own branch scopes
drop policy if exists rls_read_own_scopes on public.user_branch_scopes;
create policy rls_read_own_scopes on public.user_branch_scopes for select to authenticated using (user_id = auth.uid());
grant select on public.user_branch_scopes to authenticated;

-- users: same company, SAFE COLUMNS ONLY (password_hash and mfa_secret must never reach the browser)
drop policy if exists rls_read_users on public.users;
create policy rls_read_users on public.users for select to authenticated using (company_id = app.company_id());
revoke select on public.users from authenticated;
grant select (id, tenant_id, company_id, full_name, email, phone, is_active, last_login_at, created_at)
  on public.users to authenticated;

-- notifications: only my own; the only column I may update is read_at
drop policy if exists rls_read_own_notifications on public.notifications;
create policy rls_read_own_notifications on public.notifications for select to authenticated
  using (company_id = app.company_id() and user_id = auth.uid() and (select app.has_permission('notifications.view')));
drop policy if exists rls_update_own_notifications on public.notifications;
create policy rls_update_own_notifications on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

-- 4) Deliberately CLOSED to the browser (Express / service role only): audit_logs, refresh_tokens, backup_settings
--    (encrypted Google secrets), platform_* (developer kill-switch), push_subscriptions, idempotency_keys,
--    document_sequences, journal_*, payroll_*, roles, user_roles, role_permissions.

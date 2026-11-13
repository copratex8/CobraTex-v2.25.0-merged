-- 20261106000001_app_helpers.sql
-- Helper functions used by every RLS policy. They live in schema "app" (NOT exposed by the Data API).
-- They mirror the Express logic in identityService.buildAccessClaims / RequestContext.assertPermission.
-- Run on the Supabase project (SQL editor or `supabase db push`), AFTER your data is restored.

create schema if not exists app;
revoke all on schema app from public, anon;
grant usage on schema app to authenticated, service_role;

-- Company / tenant come from custom JWT claims (added by custom_access_token_hook, see migration 02).
create or replace function app.company_id() returns uuid
language sql stable as $$ select nullif(auth.jwt() ->> 'company_id', '')::uuid $$;

create or replace function app.tenant_id() returns uuid
language sql stable as $$ select nullif(auth.jwt() ->> 'tenant_id', '')::uuid $$;

-- Live permission check (NOT from the token, so role changes apply immediately).
--   p_branch null  -> only "does the user hold this permission"
--   p_branch given -> grant scope 'all_branches' passes; otherwise the branch must be in the user's
--                     user_branch_scopes (or any of their rows has scope_type = 'all').
create or replace function app.has_permission(p_code text, p_branch uuid default null)
returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(bool_or(
           p_branch is null
           or rp.scope = 'all_branches'
           or exists (select 1 from user_branch_scopes s
                      where s.user_id = auth.uid()
                        and (s.scope_type = 'all' or s.branch_id = p_branch))
         ), false)
  from user_roles ur
  join role_permissions rp on rp.role_id = ur.role_id
  join permissions p on p.id = rp.permission_id
  join users u on u.id = ur.user_id and u.is_active
  where ur.user_id = auth.uid()
    and ur.company_id = app.company_id()
    and p.code = p_code
$$;

revoke execute on function app.company_id(), app.tenant_id(), app.has_permission(text, uuid) from public, anon;
grant  execute on function app.company_id(), app.tenant_id(), app.has_permission(text, uuid) to authenticated, service_role;

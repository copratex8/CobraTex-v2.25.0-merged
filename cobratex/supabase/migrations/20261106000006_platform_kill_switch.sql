-- 20261106000006_platform_kill_switch.sql
-- Replaces Express' platformGuard for browser -> Supabase traffic.
--   * RESTRICTIVE policy on every browser-facing table: when the developer suspends the platform (or this
--     tenant) from the developer panel, ALL direct reads/writes/realtime events stop immediately.
--   * public.get_platform_status(): same payload as GET /api/public/status (login screen + watcher).
-- The control tables (platform_settings, tenant_service_status, platform_announcements) are still written by
-- the developer panel through Express; they stay closed to the browser (read only via the RPC below).

create or replace function app.service_active() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select not exists (select 1 from platform_settings where key = 'service' and value ->> 'status' = 'suspended')
     and not exists (select 1 from tenant_service_status where tenant_id = app.tenant_id() and status = 'suspended')
$$;
revoke execute on function app.service_active() from public, anon;
grant  execute on function app.service_active() to authenticated;

create or replace function app.apply_service_guard(p_table text) returns void
language plpgsql as $$
begin
  execute format('drop policy if exists rls_service_active on public.%I', p_table);
  execute format('create policy rls_service_active on public.%I as restrictive for all to authenticated
                  using ((select app.service_active()))', p_table);
end $$;
revoke execute on function app.apply_service_guard(text) from public, anon, authenticated;

-- enable_read (migration 03) redefined: identical + service guard, so every future table is protected automatically.
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
  perform app.apply_service_guard(p_table);
end $$;
revoke execute on function app.enable_read(text, text) from public, anon, authenticated;

-- Guard every table that already has one of our policies (migrations 03/04).
do $$
declare r record;
begin
  for r in select distinct tablename from pg_policies
           where schemaname = 'public' and policyname like 'rls\_%' escape '\'
             and policyname <> 'rls_service_active' and roles @> array['authenticated']::name[]
  loop
    perform app.apply_service_guard(r.tablename);
  end loop;
end $$;

-- Storage: same switch, only for our bucket (other buckets unaffected).
drop policy if exists rls_service_active_storage on storage.objects;
create policy rls_service_active_storage on storage.objects as restrictive for all to authenticated
  using (bucket_id <> 'attachments' or (select app.service_active()));

-- ---- public status (anon-callable on purpose: the login screen needs it) -------------------------------
create or replace function public.get_platform_status(p_tenant_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare g jsonb; t record; st text := 'active'; msg text := ''; sc text := null; ann jsonb;
begin
  select value into g from platform_settings where key = 'service';
  if coalesce(g ->> 'status', 'active') = 'suspended' then
    st := 'suspended'; msg := coalesce(g ->> 'message', ''); sc := 'global';
  elsif p_tenant_id is not null then
    select status, message into t from tenant_service_status where tenant_id = p_tenant_id;
    if found and t.status = 'suspended' then st := 'suspended'; msg := t.message; sc := 'tenant'; end if;
  end if;
  if st = 'suspended' and msg = '' then msg := 'تم إيقاف الخدمة مؤقتًا. يرجى التواصل مع مزوّد الخدمة.'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'body', a.body, 'severity', a.severity)
                            order by a.created_at desc), '[]'::jsonb)
    into ann
  from (select * from platform_announcements
         where is_active and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now())
           and (tenant_id is null or tenant_id = p_tenant_id)
         order by created_at desc limit 10) a;

  return jsonb_build_object('status', st, 'message', case when st = 'suspended' then msg else '' end,
                            'scope', sc, 'announcements', ann,
                            'serverTime', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end $$;
revoke execute on function public.get_platform_status(uuid) from public;
grant  execute on function public.get_platform_status(uuid) to anon, authenticated;

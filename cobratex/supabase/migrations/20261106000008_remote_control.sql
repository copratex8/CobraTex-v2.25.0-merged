-- 20261106000008_remote_control.sql
-- Server-side enforcement of the developer's remote control on the Supabase side:
--  * license expiry (after grace, ONLY for licenses with expired_mode='block') blocks the tenant's reads/writes/realtime exactly like a manual suspension
--  * get_platform_status additionally returns: license (ONLY when the caller's JWT belongs to that tenant)
--    and the remote update policy (latest/min app version). Anonymous callers still get status + announcements only.
-- Depends on backend migrations 0071 (tenant_licenses) and 0074 (license_state / license_blocks / platform_today).

create or replace function app.service_active() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select not exists (select 1 from platform_settings where key = 'service' and value ->> 'status' = 'suspended')
     and not exists (select 1 from tenant_service_status where tenant_id = app.tenant_id() and status = 'suspended')
     and not coalesce(public.license_blocks(app.tenant_id()), false)
$$;

create or replace function public.get_platform_status(p_tenant_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  g jsonb; t record; s record; upd jsonb; lic jsonb := null;
  st text := 'active'; msg text := ''; sc text := null; ann jsonb;
begin
  select value into g from platform_settings where key = 'service';
  if coalesce(g ->> 'status', 'active') = 'suspended' then
    st := 'suspended'; msg := coalesce(g ->> 'message', ''); sc := 'global';
  elsif p_tenant_id is not null then
    select status, message into t from tenant_service_status where tenant_id = p_tenant_id;
    if found and t.status = 'suspended' then
      st := 'suspended'; msg := t.message; sc := 'tenant';
    elsif public.license_blocks(p_tenant_id) then
      st := 'suspended'; sc := 'license';
      msg := 'انتهى ترخيص النظام. يرجى التواصل مع مزوّد الخدمة لتجديد الترخيص.';
    end if;
  end if;
  if st = 'suspended' and msg = '' then msg := 'تم إيقاف الخدمة مؤقتًا. يرجى التواصل مع مزوّد الخدمة.'; end if;

  -- license details are private to the tenant itself
  if p_tenant_id is not null and p_tenant_id = nullif(auth.jwt() ->> 'tenant_id', '')::uuid then
    select * into s from public.license_state(p_tenant_id);
    if s.state is not null and s.state <> 'none' then
      lic := jsonb_build_object('state', s.state, 'daysLeft', s.days_left, 'endsAt', s.expires_on,
                                'graceUntil', s.grace_until, 'plan', s.plan);
    end if;
  end if;

  select value into upd from platform_settings where key = 'client_update';

  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'body', a.body, 'severity', a.severity)
                            order by a.created_at desc), '[]'::jsonb)
    into ann
  from (select * from platform_announcements
         where is_active and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now())
           and (tenant_id is null or tenant_id = p_tenant_id)
         order by created_at desc limit 10) a;

  return jsonb_build_object('status', st, 'message', case when st = 'suspended' then msg else '' end,
                            'scope', sc, 'announcements', ann, 'license', lic,
                            'update', coalesce(upd, '{}'::jsonb),
                            'serverTime', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end $$;
revoke execute on function public.get_platform_status(uuid) from public;
grant  execute on function public.get_platform_status(uuid) to anon, authenticated;

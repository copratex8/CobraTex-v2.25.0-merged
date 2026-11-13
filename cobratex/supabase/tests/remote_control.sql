-- supabase/tests/remote_control.sql — licenses, reminders, auto-suspension, status RPC. One transaction, rolled back.
--   psql "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/remote_control.sql
begin;

insert into tenants(id, name) values
  ('a1000000-0000-0000-0000-0000000000a1','S-T1'), ('a1000000-0000-0000-0000-0000000000a2','S-T2');
insert into companies(id, tenant_id, legal_name, display_name) values
  ('c1000000-0000-0000-0000-0000000000c1','a1000000-0000-0000-0000-0000000000a1','SC1','SC1'),
  ('c1000000-0000-0000-0000-0000000000c2','a1000000-0000-0000-0000-0000000000a2','SC2','SC2');
insert into users(id, tenant_id, company_id, full_name, email, password_hash) values
  ('d1000000-0000-0000-0000-0000000000d1','a1000000-0000-0000-0000-0000000000a1','c1000000-0000-0000-0000-0000000000c1','Owner1','o1@s.test','x'),
  ('d1000000-0000-0000-0000-0000000000d2','a1000000-0000-0000-0000-0000000000a1','c1000000-0000-0000-0000-0000000000c1','Clerk1','c1@s.test','x');
insert into roles(id, company_id, name) values
  ('f1000000-0000-0000-0000-0000000000f1','c1000000-0000-0000-0000-0000000000c1','Owner'),
  ('f1000000-0000-0000-0000-0000000000f2','c1000000-0000-0000-0000-0000000000c1','Clerk');
insert into user_roles(user_id, role_id, company_id) values
  ('d1000000-0000-0000-0000-0000000000d1','f1000000-0000-0000-0000-0000000000f1','c1000000-0000-0000-0000-0000000000c1'),
  ('d1000000-0000-0000-0000-0000000000d2','f1000000-0000-0000-0000-0000000000f2','c1000000-0000-0000-0000-0000000000c1');

do $$ declare s record; n int; r record; begin
  -- 1) no license row = unlimited (backward compatible)
  select * into s from license_state('a1000000-0000-0000-0000-0000000000a2');
  if s.state <> 'none' then raise exception 'FAIL 1a: tenant without license must be none, got %', s.state; end if;
  if license_blocks('a1000000-0000-0000-0000-0000000000a2') then raise exception 'FAIL 1b: none must not block'; end if;

  -- 2) 3 days left -> expiring, reminder goes to the OWNER only, once
  insert into tenant_licenses(tenant_id, plan_type, expires_at, grace_days, expired_mode)
  values ('a1000000-0000-0000-0000-0000000000a1','annual', (platform_today() + 3)::timestamp at time zone 'UTC', 7, 'block');
  select * into s from license_state('a1000000-0000-0000-0000-0000000000a1');
  if s.state <> 'expiring' or s.days_left <> 3 then raise exception 'FAIL 2a: expected expiring/3 got %/%', s.state, s.days_left; end if;

  select count(*) into n from send_license_reminders();
  if n <> 1 then raise exception 'FAIL 2b: expected exactly 1 reminder (owner), got %', n; end if;
  select count(*) into n from notifications where type = 'license_reminder' and user_id = 'd1000000-0000-0000-0000-0000000000d1';
  if n <> 1 then raise exception 'FAIL 2c: owner must have 1 in-app reminder, got %', n; end if;
  select count(*) into n from notifications where user_id = 'd1000000-0000-0000-0000-0000000000d2';
  if n <> 0 then raise exception 'FAIL 2d: non-owner must not receive license reminders'; end if;
  select count(*) into n from send_license_reminders();
  if n <> 0 then raise exception 'FAIL 2e: same threshold must not be re-sent, got %', n; end if;

  -- 4 days left is not a reminder day
  update tenant_licenses set expires_at = (platform_today() + 4)::timestamp at time zone 'UTC' where tenant_id = 'a1000000-0000-0000-0000-0000000000a1';
  select count(*) into n from send_license_reminders();
  if n <> 0 then raise exception 'FAIL 2f: 4 days left must not send, got %', n; end if;

  -- 3) ended yesterday, grace 7 -> grace (NOT blocked), daily reminder
  update tenant_licenses set expires_at = (platform_today() - 1)::timestamp at time zone 'UTC' where tenant_id = 'a1000000-0000-0000-0000-0000000000a1';
  select * into s from license_state('a1000000-0000-0000-0000-0000000000a1');
  if s.state <> 'grace' then raise exception 'FAIL 3a: expected grace got %', s.state; end if;
  if license_blocks('a1000000-0000-0000-0000-0000000000a1') then raise exception 'FAIL 3b: grace must not block'; end if;
  select count(*) into n from send_license_reminders();
  if n <> 1 then raise exception 'FAIL 3c: grace reminder expected, got %', n; end if;

  -- 4) grace over -> expired + blocked; status RPC reports it; last allowed day still works
  update tenant_licenses set expires_at = (platform_today() - 7)::timestamp at time zone 'UTC' where tenant_id = 'a1000000-0000-0000-0000-0000000000a1';
  if license_blocks('a1000000-0000-0000-0000-0000000000a1') then raise exception 'FAIL 4a: last grace day must still work'; end if;
  update tenant_licenses set expires_at = (platform_today() - 8)::timestamp at time zone 'UTC' where tenant_id = 'a1000000-0000-0000-0000-0000000000a1';
  select * into s from license_state('a1000000-0000-0000-0000-0000000000a1');
  if s.state <> 'expired' or not license_blocks('a1000000-0000-0000-0000-0000000000a1') then
    raise exception 'FAIL 4b: expected expired+blocked got %', s.state; end if;
  select count(*) into n from send_license_reminders();
  if n <> 0 then raise exception 'FAIL 4c: no reminders after the service is stopped'; end if;
end $$;

-- 5) status RPC as anon: suspended by license, but NO license details leaked; update policy visible
insert into platform_settings(key, value) values ('client_update', '{"latestVersion":"9.9.9","minVersion":"1.0.0"}'::jsonb)
  on conflict (key) do update set value = excluded.value;
set local role anon;
do $$ declare j jsonb; begin
  j := public.get_platform_status('a1000000-0000-0000-0000-0000000000a1');
  if j ->> 'status' <> 'suspended' or j ->> 'scope' <> 'license' then raise exception 'FAIL 5a: got %', j; end if;
  if j -> 'license' <> 'null'::jsonb then raise exception 'FAIL 5b: anon must not see license details: %', j -> 'license'; end if;
  if j -> 'update' ->> 'latestVersion' <> '9.9.9' then raise exception 'FAIL 5c: update policy missing'; end if;
end $$;
reset role;

-- 6) authenticated user of the tenant: sees own license details; and app.service_active() is false (RLS blocks)
select set_config('request.jwt.claims', json_build_object('sub','d1000000-0000-0000-0000-0000000000d1','role','authenticated',
  'company_id','c1000000-0000-0000-0000-0000000000c1','tenant_id','a1000000-0000-0000-0000-0000000000a1')::text, true);
select set_config('request.jwt.claim.sub','d1000000-0000-0000-0000-0000000000d1', true);
set local role authenticated;
do $$ declare j jsonb; begin
  j := public.get_platform_status('a1000000-0000-0000-0000-0000000000a1');
  if j -> 'license' ->> 'state' <> 'expired' then raise exception 'FAIL 6a: tenant must see its own license: %', j; end if;
  if app.service_active() then raise exception 'FAIL 6b: expired license must deactivate the service'; end if;
end $$;
reset role;

-- 7) renewing restores service immediately
update tenant_licenses set expires_at = (platform_today() + 365)::timestamp at time zone 'UTC' where tenant_id = 'a1000000-0000-0000-0000-0000000000a1';
select set_config('request.jwt.claims', json_build_object('sub','d1000000-0000-0000-0000-0000000000d1','role','authenticated',
  'company_id','c1000000-0000-0000-0000-0000000000c1','tenant_id','a1000000-0000-0000-0000-0000000000a1')::text, true);
set local role authenticated;
do $$ begin
  if not app.service_active() then raise exception 'FAIL 7a: renewal must restore service'; end if;
end $$;
reset role;

select 'REMOTE CONTROL: ALL CHECKS PASSED' as result;
rollback;

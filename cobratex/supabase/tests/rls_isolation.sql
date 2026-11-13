-- supabase/tests/rls_isolation.sql
-- Port of backend/tests/tenantIsolation.test.ts to the Supabase side. Run AFTER migrations 01..06:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_isolation.sql
-- Everything runs in ONE transaction that is rolled back: leaves no data behind. Any failed check raises.
begin;

-- ---------- fixtures (as postgres: bypasses RLS) ----------
insert into tenants(id, name) values
  ('a0000000-0000-0000-0000-0000000000a1','T1'), ('a0000000-0000-0000-0000-0000000000a2','T2');
insert into companies(id, tenant_id, legal_name, display_name) values
  ('c0000000-0000-0000-0000-0000000000c1','a0000000-0000-0000-0000-0000000000a1','C1','C1'),
  ('c0000000-0000-0000-0000-0000000000c2','a0000000-0000-0000-0000-0000000000a2','C2','C2');
insert into branches(id, company_id, name_ar, name_en) values
  ('b0000000-0000-0000-0000-0000000000b1','c0000000-0000-0000-0000-0000000000c1','ف1','B1'),
  ('b0000000-0000-0000-0000-0000000000b2','c0000000-0000-0000-0000-0000000000c1','ف2','B2');
insert into users(id, tenant_id, company_id, full_name, email, password_hash) values
  ('d0000000-0000-0000-0000-0000000000d1','a0000000-0000-0000-0000-0000000000a1','c0000000-0000-0000-0000-0000000000c1','HasPerm','has@t1.test','x'),
  ('d0000000-0000-0000-0000-0000000000d2','a0000000-0000-0000-0000-0000000000a1','c0000000-0000-0000-0000-0000000000c1','NoPerm','no@t1.test','x'),
  ('d0000000-0000-0000-0000-0000000000d3','a0000000-0000-0000-0000-0000000000a2','c0000000-0000-0000-0000-0000000000c2','Other','other@t2.test','x');
insert into accounts(id, company_id, code, name_ar, name_en, account_type) values
  ('e0000000-0000-0000-0000-0000000000e1','c0000000-0000-0000-0000-0000000000c1','1000','ص1','A1','asset'),
  ('e0000000-0000-0000-0000-0000000000e2','c0000000-0000-0000-0000-0000000000c2','1000','ص2','A2','asset');
insert into roles(id, company_id, name) values ('f0000000-0000-0000-0000-0000000000f1','c0000000-0000-0000-0000-0000000000c1','viewer');
insert into role_permissions(role_id, permission_id, scope)
  select 'f0000000-0000-0000-0000-0000000000f1', id, 'all_branches' from permissions where code = 'accounting.account.view';
insert into user_roles(user_id, role_id, company_id) values
  ('d0000000-0000-0000-0000-0000000000d1','f0000000-0000-0000-0000-0000000000f1','c0000000-0000-0000-0000-0000000000c1');
insert into notifications(company_id, user_id, type, title) values
  ('c0000000-0000-0000-0000-0000000000c1','d0000000-0000-0000-0000-0000000000d1','t','mine'),
  ('c0000000-0000-0000-0000-0000000000c1','d0000000-0000-0000-0000-0000000000d2','t','not mine');
-- the permission code must really exist, otherwise every "has permission" check below is meaningless
do $$ begin
  if not exists (select 1 from permissions where code = 'accounting.account.view') then
    raise exception 'SETUP: permission accounting.account.view is not seeded'; end if;
  if not exists (select 1 from role_permissions where role_id = 'f0000000-0000-0000-0000-0000000000f1') then
    raise exception 'SETUP: role_permissions fixture empty'; end if;
end $$;

-- ---------- 1) user WITH permission, company 1 ----------
select set_config('request.jwt.claims', json_build_object('sub','d0000000-0000-0000-0000-0000000000d1','role','authenticated',
  'company_id','c0000000-0000-0000-0000-0000000000c1','tenant_id','a0000000-0000-0000-0000-0000000000a1')::text, true);
select set_config('request.jwt.claim.sub','d0000000-0000-0000-0000-0000000000d1', true);
set local role authenticated;

do $$ declare n int; begin
  select count(*) into n from accounts;
  if n <> 1 then raise exception 'FAIL 1a: expected 1 account (own company only), got %', n; end if;
  if exists (select 1 from accounts where company_id = 'c0000000-0000-0000-0000-0000000000c2') then
    raise exception 'FAIL 1b: other company account visible'; end if;
  select count(*) into n from users;
  if n <> 2 then raise exception 'FAIL 1c: expected 2 users of own company, got %', n; end if;
  select count(*) into n from notifications;
  if n <> 1 then raise exception 'FAIL 1d: must see only own notifications, got %', n; end if;
end $$;

do $$ begin
  begin perform password_hash from users limit 1;
    raise exception 'FAIL 1e: password_hash must NOT be readable';
  exception when insufficient_privilege then null; end;
  begin perform mfa_secret from users limit 1;
    raise exception 'FAIL 1f: mfa_secret must NOT be readable';
  exception when insufficient_privilege then null; end;
end $$;

do $$ begin
  begin insert into accounts(company_id, code, name_ar, name_en, account_type)
        values ('c0000000-0000-0000-0000-0000000000c1','9','x','x','asset');
    raise exception 'FAIL 1g: direct INSERT into accounts must be denied';
  exception when insufficient_privilege then null; end;
  begin delete from accounts;
    raise exception 'FAIL 1h: direct DELETE on accounts must be denied';
  exception when insufficient_privilege then null; end;
  begin perform 1 from audit_logs limit 1;
    raise exception 'FAIL 1i: audit_logs must be closed to the browser';
  exception when insufficient_privilege then null; end;
  begin perform seed_textile_defaults('c0000000-0000-0000-0000-0000000000c2');
    raise exception 'FAIL 1l: public helper functions must not be callable from the browser (RPC)';
  exception when insufficient_privilege then null; end;
  begin perform public.custom_access_token_hook('{}'::jsonb);
    raise exception 'FAIL 1m: auth hook must not be callable by users';
  exception when insufficient_privilege then null; end;
  begin perform 1 from backup_settings limit 1;
    raise exception 'FAIL 1j: backup_settings (encrypted secrets) must be closed';
  exception when insufficient_privilege then null; end;
end $$;

-- notifications: may update ONLY read_at
do $$ begin
  update notifications set read_at = now() where title = 'mine';
  begin update notifications set title = 'hacked' where title = 'mine';
    raise exception 'FAIL 1k: updating title must be denied';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ---------- 2) user WITHOUT the permission, same company ----------
select set_config('request.jwt.claims', json_build_object('sub','d0000000-0000-0000-0000-0000000000d2','role','authenticated',
  'company_id','c0000000-0000-0000-0000-0000000000c1','tenant_id','a0000000-0000-0000-0000-0000000000a1')::text, true);
select set_config('request.jwt.claim.sub','d0000000-0000-0000-0000-0000000000d2', true);
set local role authenticated;
do $$ declare n int; begin
  select count(*) into n from accounts;
  if n <> 0 then raise exception 'FAIL 2a: user without accounting.account.view saw % accounts', n; end if;
end $$;
reset role;

-- ---------- 3) user of ANOTHER tenant ----------
select set_config('request.jwt.claims', json_build_object('sub','d0000000-0000-0000-0000-0000000000d3','role','authenticated',
  'company_id','c0000000-0000-0000-0000-0000000000c2','tenant_id','a0000000-0000-0000-0000-0000000000a2')::text, true);
select set_config('request.jwt.claim.sub','d0000000-0000-0000-0000-0000000000d3', true);
set local role authenticated;
do $$ declare n int; begin
  select count(*) into n from accounts;
  if n <> 0 then raise exception 'FAIL 3a: other tenant user saw % accounts', n; end if;
  select count(*) into n from users where company_id = 'c0000000-0000-0000-0000-0000000000c1';
  if n <> 0 then raise exception 'FAIL 3b: cross-company users visible'; end if;
end $$;
reset role;

-- ---------- 4) kill switch: suspending tenant T1 blocks user 1 immediately ----------
insert into tenant_service_status(tenant_id, status, message) values ('a0000000-0000-0000-0000-0000000000a1','suspended','stop')
  on conflict (tenant_id) do update set status = 'suspended';
select set_config('request.jwt.claims', json_build_object('sub','d0000000-0000-0000-0000-0000000000d1','role','authenticated',
  'company_id','c0000000-0000-0000-0000-0000000000c1','tenant_id','a0000000-0000-0000-0000-0000000000a1')::text, true);
select set_config('request.jwt.claim.sub','d0000000-0000-0000-0000-0000000000d1', true);
set local role authenticated;
do $$ declare n int; s jsonb; begin
  select count(*) into n from accounts;
  if n <> 0 then raise exception 'FAIL 4a: suspended tenant still reads accounts (%).', n; end if;
end $$;
reset role;
set local role anon;
do $$ declare s jsonb; begin
  s := public.get_platform_status('a0000000-0000-0000-0000-0000000000a1');
  if s ->> 'status' <> 'suspended' or s ->> 'scope' <> 'tenant' then raise exception 'FAIL 4b: status RPC says %', s; end if;
  s := public.get_platform_status('a0000000-0000-0000-0000-0000000000a2');
  if s ->> 'status' <> 'active' then raise exception 'FAIL 4c: other tenant must stay active, got %', s; end if;
end $$;
reset role;

-- ---------- 5) anon sees nothing ----------
set local role anon;
do $$ begin
  begin perform 1 from accounts limit 1; raise exception 'FAIL 5a: anon can read accounts';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

select 'RLS isolation: ALL CHECKS PASSED' as result;
rollback;

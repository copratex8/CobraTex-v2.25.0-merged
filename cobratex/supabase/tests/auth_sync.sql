-- supabase/tests/auth_sync.sql — each user has their OWN password; Express user management stays in sync with Supabase Auth.
-- Run after migrations 01..08:  psql "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/auth_sync.sql   (one transaction, rolled back)
begin;

insert into tenants(id, name) values ('a2000000-0000-0000-0000-0000000000a1','AS-T1');
insert into companies(id, tenant_id, legal_name, display_name) values ('c2000000-0000-0000-0000-0000000000c1','a2000000-0000-0000-0000-0000000000a1','AC1','AC1');

do $$ declare au record; n int; begin
  -- 1) creating a user in public.users creates the Supabase Auth user with the SAME id and the SAME bcrypt hash
  insert into users(id, tenant_id, company_id, full_name, email, password_hash)
  values ('d2000000-0000-0000-0000-0000000000d1','a2000000-0000-0000-0000-0000000000a1','c2000000-0000-0000-0000-0000000000c1','U1','U1@Sync.test','$2b$12$hash.one.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  select * into au from auth.users where id = 'd2000000-0000-0000-0000-0000000000d1';
  if not found then raise exception 'FAIL 1a: auth user not created'; end if;
  if au.email <> 'u1@sync.test' then raise exception 'FAIL 1b: email must be lower-cased, got %', au.email; end if;
  if au.encrypted_password <> '$2b$12$hash.one.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' then raise exception 'FAIL 1c: hash mismatch'; end if;
  if au.banned_until is not null then raise exception 'FAIL 1d: active user must not be banned'; end if;
  if not exists (select 1 from auth.identities where user_id = au.id and provider = 'email') then raise exception 'FAIL 1e: identity missing'; end if;

  -- 2) a second user has an independent password
  insert into users(id, tenant_id, company_id, full_name, email, password_hash)
  values ('d2000000-0000-0000-0000-0000000000d2','a2000000-0000-0000-0000-0000000000a1','c2000000-0000-0000-0000-0000000000c1','U2','u2@sync.test','$2b$12$hash.two.yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy');
  select count(distinct encrypted_password) into n from auth.users where id in ('d2000000-0000-0000-0000-0000000000d1','d2000000-0000-0000-0000-0000000000d2');
  if n <> 2 then raise exception 'FAIL 2: users must have distinct passwords'; end if;

  -- 3) changing the password syncs AND ends existing sessions
  insert into auth.sessions(id, user_id, created_at, updated_at) values ('e2000000-0000-0000-0000-0000000000e1','d2000000-0000-0000-0000-0000000000d1', now(), now());
  update users set password_hash = '$2b$12$hash.new.zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' where id = 'd2000000-0000-0000-0000-0000000000d1';
  select * into au from auth.users where id = 'd2000000-0000-0000-0000-0000000000d1';
  if au.encrypted_password <> '$2b$12$hash.new.zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' then raise exception 'FAIL 3a: password change not synced'; end if;
  if exists (select 1 from auth.sessions where user_id = au.id) then raise exception 'FAIL 3b: sessions must end after a password change'; end if;
  if (select encrypted_password from auth.users where id = 'd2000000-0000-0000-0000-0000000000d2') like '%zzzz%' then raise exception 'FAIL 3c: other users must be untouched'; end if;

  -- 4) deactivation bans sign-in and ends sessions; reactivation restores
  insert into auth.sessions(id, user_id, created_at, updated_at) values ('e2000000-0000-0000-0000-0000000000e2','d2000000-0000-0000-0000-0000000000d2', now(), now());
  update users set is_active = false where id = 'd2000000-0000-0000-0000-0000000000d2';
  select * into au from auth.users where id = 'd2000000-0000-0000-0000-0000000000d2';
  if au.banned_until is null or au.banned_until <= now() then raise exception 'FAIL 4a: deactivated user must be banned'; end if;
  if exists (select 1 from auth.sessions where user_id = au.id) then raise exception 'FAIL 4b: sessions must end on deactivation'; end if;
  update users set is_active = true where id = 'd2000000-0000-0000-0000-0000000000d2';
  select * into au from auth.users where id = 'd2000000-0000-0000-0000-0000000000d2';
  if au.banned_until is not null then raise exception 'FAIL 4c: reactivated user must not stay banned'; end if;

  -- 4b) a Supabase sign-in updates the "last login" shown in the users screen
  update auth.users set last_sign_in_at = now() where id = 'd2000000-0000-0000-0000-0000000000d1';
  if (select last_login_at from users where id = 'd2000000-0000-0000-0000-0000000000d1') is null then
    raise exception 'FAIL 4d: last_sign_in_at must sync to users.last_login_at'; end if;

  -- 5) the JWT hook puts tenant/company into the token
  declare r jsonb; begin
    r := public.custom_access_token_hook(jsonb_build_object('user_id','d2000000-0000-0000-0000-0000000000d1','claims','{}'::jsonb));
    if r -> 'claims' ->> 'company_id' <> 'c2000000-0000-0000-0000-0000000000c1' or r -> 'claims' ->> 'tenant_id' <> 'a2000000-0000-0000-0000-0000000000a1' then
      raise exception 'FAIL 5: hook claims wrong: %', r; end if;
  end;
end $$;

select 'AUTH SYNC: ALL CHECKS PASSED' as result;
rollback;

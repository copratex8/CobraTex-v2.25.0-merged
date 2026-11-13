-- 20261106000002_auth_import_and_hook.sql
-- 1) Import public.users into Supabase Auth KEEPING the same UUID and the bcrypt hash (no password reset).
-- 2) Custom Access Token Hook: adds tenant_id / company_id / branch_ids to the JWT.
-- 3) Trigger that keeps auth.users in sync while Express still creates/updates users (hybrid phase).
-- TEST ON A STAGING PROJECT FIRST - this writes to the auth schema.

-- Guard: Supabase emails are globally unique, yours are unique per tenant only.
do $$ begin
  if exists (select 1 from public.users group by lower(email) having count(*) > 1) then
    raise exception 'Duplicate emails across tenants. Supabase Auth needs globally unique emails - fix first.';
  end if;
end $$;

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                        confirmation_token, recovery_token, email_change, email_change_token_new, banned_until)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', lower(u.email),
       u.password_hash, now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       jsonb_build_object('full_name', u.full_name),
       u.created_at, now(), '', '', '', '',
       case when u.is_active then null else 'infinity'::timestamptz end
from public.users u
where not exists (select 1 from auth.users a where a.id = u.id);

insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), u.id, u.id::text,
       jsonb_build_object('sub', u.id::text, 'email', lower(u.email), 'email_verified', true, 'phone_verified', false),
       'email', now(), now(), now()
from public.users u
where not exists (select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email');

-- ---- Custom Access Token Hook ----------------------------------------------------------------
create or replace function public.custom_access_token_hook(event jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  claims   jsonb := coalesce(event -> 'claims', '{}'::jsonb);
  uid      uuid  := (event ->> 'user_id')::uuid;
  u        record;
  branches jsonb;
  all_scope boolean;
begin
  select tenant_id, company_id into u from public.users where id = uid;
  if not found then return event; end if;

  select coalesce(jsonb_agg(branch_id), '[]'::jsonb), coalesce(bool_or(scope_type = 'all'), false)
    into branches, all_scope
  from public.user_branch_scopes where user_id = uid;

  -- Display-only helpers for the UI. Real enforcement is always app.has_permission() in the DB.
  claims := claims || jsonb_build_object('tenant_id', u.tenant_id, 'company_id', u.company_id,
                                         'branch_ids', branches,
                                         'scope_type', case when all_scope then 'all' else 'limited' end);
  return jsonb_set(event, '{claims}', claims);
end $$;

revoke execute on function public.custom_access_token_hook(jsonb) from public, anon, authenticated;
grant  execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
-- ➜ Then enable it in the dashboard: Authentication -> Hooks -> Custom Access Token -> public.custom_access_token_hook

-- ---- Keep auth.users in sync while Express is still creating users ------------------------------
create or replace function app.sync_user_to_auth() returns trigger
language plpgsql security definer set search_path = public, auth, pg_temp as $$
begin
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change, email_change_token_new, banned_until)
  values ('00000000-0000-0000-0000-000000000000', new.id, 'authenticated', 'authenticated', lower(new.email),
          new.password_hash, now(), '{"provider":"email","providers":["email"]}'::jsonb,
          jsonb_build_object('full_name', new.full_name), now(), now(), '', '', '', '',
          case when new.is_active then null else 'infinity'::timestamptz end)
  on conflict (id) do update
    set email = excluded.email, encrypted_password = excluded.encrypted_password,
        banned_until = excluded.banned_until, updated_at = now();

  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), new.id, new.id::text,
          jsonb_build_object('sub', new.id::text, 'email', lower(new.email), 'email_verified', true, 'phone_verified', false),
          'email', now(), now(), now())
  on conflict (provider_id, provider) do update
    set identity_data = excluded.identity_data, updated_at = now();

  -- تغيير كلمة المرور أو تعطيل الحساب ⇒ إنهاء كل جلساته فورًا (refresh tokens تُحذف بالتتابع).
  if tg_op = 'UPDATE' and (old.password_hash is distinct from new.password_hash or (old.is_active and not new.is_active)) then
    delete from auth.sessions where user_id = new.id;
  end if;
  return new;
end $$;
revoke execute on function app.sync_user_to_auth() from public, anon, authenticated;

drop trigger if exists trg_sync_user_to_auth on public.users;
create trigger trg_sync_user_to_auth
  after insert or update of email, password_hash, is_active on public.users
  for each row execute function app.sync_user_to_auth();

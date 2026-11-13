-- 20261106000009_last_login_sync.sql
-- «آخر دخول» في شاشة المستخدمين كان يُحدَّث فقط من مسار الدخول القديم في Express. بعد الانتقال إلى Supabase Auth
-- يسجّل GoTrue وقت الدخول في auth.users.last_sign_in_at؛ هذا المُشغِّل ينسخه إلى public.users.last_login_at.
create or replace function app.sync_last_login() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.last_sign_in_at is distinct from old.last_sign_in_at then
    update public.users set last_login_at = new.last_sign_in_at where id = new.id;
  end if;
  return new;
end $$;
revoke execute on function app.sync_last_login() from public, anon, authenticated;

drop trigger if exists trg_sync_last_login on auth.users;
create trigger trg_sync_last_login
  after update of last_sign_in_at on auth.users
  for each row execute function app.sync_last_login();

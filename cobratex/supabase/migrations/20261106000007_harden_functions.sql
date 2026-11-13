-- 20261106000007_harden_functions.sql
-- Supabase exposes EVERY function in schema "public" as an RPC endpoint, and Postgres grants EXECUTE to PUBLIC by default.
-- Your backend migrations define helper functions in public (e.g. seed_textile_defaults(p_company uuid)): left as-is,
-- any signed-in user (or anon) could call them with ANOTHER company's id. Close them all; Express/postgres are unaffected.
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- The only public RPC the browser may call (login screen status):
grant execute on function public.get_platform_status(uuid) to anon, authenticated;
-- (custom_access_token_hook keeps its explicit grant to supabase_auth_admin; trigger functions need no grant.)

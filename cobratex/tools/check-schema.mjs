#!/usr/bin/env node
/**
 * Static contract check (no database needed) — catches the mistakes that otherwise fail only in production:
 *  1. Every table/column that our Supabase SQL and frontend `.from('table')` calls rely on EXISTS in backend/src/db/migrations.
 *  2. Every permission code used in supabase/migrations/*.sql is SEEDED by a backend migration
 *     (a typo there would silently deny everyone, because RLS is default-deny).
 *  3. Every table passed to app.enable_read() exists, has company_id, and the policy migration does not
 *     expose forbidden tables.
 * Usage:  node tools/check-schema.mjs        (run from the repo root; exit code 1 on any problem)
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const migDir = path.join(root, 'backend/src/db/migrations');
const sbDir = path.join(root, 'supabase/migrations');
const read = (f) => fs.readFileSync(f, 'utf8');
const strip = (s) => s.replace(/--[^\n]*/g, '');

// ---------- build schema from the 69 backend migrations ----------
const schema = new Map(); // table -> Set(columns)
const sql = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort().map((f) => strip(read(path.join(migDir, f)))).join('\n');

for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*?)\n\);/g)) {
  const cols = new Set();
  for (const line of m[2].split('\n')) {
    const c = line.trim().match(/^([a-z_][a-z0-9_]*)\s+[A-Za-z]/);
    if (c && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(c[1])) cols.add(c[1]);
  }
  schema.set(m[1], cols);
}
for (const m of sql.matchAll(/ALTER TABLE (?:IF EXISTS )?(\w+)\s+ADD COLUMN (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gi)) {
  if (!schema.has(m[1])) schema.set(m[1], new Set());
  schema.get(m[1]).add(m[2]);
}

// Tables/columns created by OUR migrations (so later checks accept them)
const ours = { attachments: ['storage_path'] };
for (const [t, cols] of Object.entries(ours)) cols.forEach((c) => schema.get(t)?.add(c));

const problems = [];
const need = (table, cols) => {
  if (!schema.has(table)) return problems.push(`table "${table}" not found in backend migrations`);
  for (const c of cols) if (!schema.get(table).has(c)) problems.push(`column ${table}.${c} not found in backend migrations`);
};

// ---------- 1) explicit contract of what our SQL / TS touches ----------
need('users', ['id','tenant_id','company_id','full_name','email','phone','password_hash','mfa_secret','is_active','last_login_at','created_at']);
need('user_roles', ['user_id','role_id','company_id']);
need('role_permissions', ['role_id','permission_id','scope']);
need('permissions', ['id','code']);
need('user_branch_scopes', ['user_id','branch_id','company_id','scope_type']);
need('audit_logs', ['tenant_id','company_id','user_id','entity_type','entity_id','action','before_json','after_json']);
need('attachments', ['id','company_id','branch_id','entity_type','entity_id','file_name','mime_type','file_size','file_data','uploaded_by','created_at']);
need('notifications', ['id','company_id','user_id','type','title','body','read_at','created_at']);
need('push_subscriptions', ['id','user_id','endpoint','p256dh_key','auth_key']);
need('platform_settings', ['key','value']);
need('tenant_service_status', ['tenant_id','status','message']);
need('platform_announcements', ['id','tenant_id','title','body','severity','is_active','starts_at','ends_at','created_at']);
need('tenants', ['id','name']); need('companies', ['id','tenant_id','legal_name','display_name']);
need('branches', ['id','company_id','name_ar','name_en']);
need('accounts', ['id','company_id','code','name_ar','name_en','account_type']);
need('roles', ['id','company_id','name']);
need('tenant_licenses', ['tenant_id','plan_type','starts_at','expires_at','grace_days','expired_mode','binding_mode','notes','updated_at']);
need('license_devices', ['tenant_id','device_id','revoked','last_seen']);
need('license_reminders_sent', ['tenant_id','expires_on','threshold','sent_at']);

// ---------- 2) permission codes ----------
const seeded = new Set([...sql.matchAll(/'([a-z_]+(?:\.[a-z_]+){1,3})'/g)].map((m) => m[1]));
const files = fs.existsSync(sbDir) ? fs.readdirSync(sbDir).filter((f) => f.endsWith('.sql')).sort() : [];
const used = new Map(); // code -> file
let enableRead = [];
for (const f of files) {
  const text = strip(read(path.join(sbDir, f)));
  for (const m of text.matchAll(/has_permission\(\s*'([a-z_.]+)'/g)) used.set(m[1], f);
  for (const m of text.matchAll(/\(\s*'(\w+)'\s*,\s*'([a-z_]+(?:\.[a-z_]+){1,3})'\s*\)/g)) { enableRead.push([m[1], m[2], f]); used.set(m[2], f); }
}
for (const [code, f] of used) if (!seeded.has(code)) problems.push(`permission code "${code}" (${f}) is not seeded by any backend migration`);

// ---------- 2b) every permission code the BACKEND/FRONTEND code asks for must be seeded ----------
{
  const srcWalk = (d) => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (['node_modules', 'dist'].includes(e.name) ? [] : srcWalk(path.join(d, e.name))) : [path.join(d, e.name)])) : [];
  for (const f of srcWalk(path.join(root, 'backend/src')).filter((x) => x.endsWith('.ts'))) {
    for (const m of read(f).matchAll(/assertPermission\(\s*'([a-z_]+(?:\.[a-z_]+){1,3})'/g)) {
      if (!seeded.has(m[1])) problems.push(`${path.relative(root, f)}: assertPermission('${m[1]}') is not seeded by any migration`);
    }
  }
  for (const f of srcWalk(path.join(root, 'frontend/src/features/users')).filter((x) => /\.tsx?$/.test(x))) {
    for (const m of read(f).matchAll(/code === '([a-z_]+(?:\.[a-z_]+){1,3})'/g)) {
      if (!seeded.has(m[1])) problems.push(`${path.relative(root, f)}: permission '${m[1]}' is not seeded by any migration`);
    }
  }
}

// ---------- 3) enable_read tables ----------
for (const [t, code, f] of enableRead) {
  if (!schema.has(t)) { problems.push(`enable_read: table "${t}" (${f}) not found`); continue; }
  if (!schema.get(t).has('company_id')) problems.push(`enable_read: table "${t}" has no company_id (${f})`);
}
const forbidden = ['audit_logs','refresh_tokens','backup_settings','platform_settings','tenant_service_status','platform_audit','tenant_licenses','license_devices','license_reminders_sent','tenant_branding','push_subscriptions','idempotency_keys','document_sequences','journal_entries','journal_lines','payroll_runs','payroll_lines','roles','user_roles','role_permissions'];
for (const [t, , f] of enableRead) if (forbidden.includes(t)) problems.push(`SECURITY: "${t}" must stay closed to the browser but is passed to enable_read (${f})`);

// ---------- 4) frontend .from('table') calls ----------
const feDir = path.join(root, 'frontend/src');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const rpcs = new Set(['get_platform_status']);
if (fs.existsSync(feDir)) {
  for (const f of walk(feDir).filter((x) => /\.(ts|tsx)$/.test(x))) {
    const t = read(f);
    for (const m of t.matchAll(/\.from\(\s*'(\w+)'\s*\)/g)) {
      if (!schema.has(m[1]) && m[1] !== 'attachments') problems.push(`${path.relative(root, f)}: .from('${m[1]}') -> unknown table`);
    }
    for (const m of t.matchAll(/\.rpc\(\s*'(\w+)'/g)) if (!rpcs.has(m[1])) problems.push(`${path.relative(root, f)}: rpc '${m[1]}' is not defined by any migration`);
    const sel = t.match(/COLUMNS\s*=\s*'([^']+)'/);
    if (sel && f.endsWith('attachments/api.ts')) need('attachments', sel[1].split(',').map((c) => c.trim()));
  }
}

console.log(`schema: ${schema.size} tables parsed · ${used.size} permission codes checked · ${enableRead.length} enable_read tables checked`);
if (problems.length) { console.error('\n' + problems.map((p) => '✗ ' + p).join('\n')); process.exit(1); }
console.log('✓ contract OK');

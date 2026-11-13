import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { useAuth } from '@/auth/AuthContext';

interface Role { id: string; name: string; isSystem: boolean; userCount: number; permissions: { code: string; scope: string }[] }
interface UserRow { id: string; fullName: string; email: string; phone: string | null; isActive: boolean; lastLoginAt: string | null; roles: { id: string; name: string }[]; branchIds: string[]; allBranches: boolean; isSelf: boolean }
interface Perms { codes: string[]; grantable: string[]; templates: { id: string; name: string; desc: string; codes: string[] }[] }
interface Branch { id: string; name_ar?: string; name_en?: string }

const errMsg = (e: unknown) => (e as { response?: { data?: { error?: string; message?: string } }; message?: string })?.response?.data?.error ?? (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? (e as Error)?.message ?? 'حدث خطأ';
const SCOPES: Record<string, string> = { own_branch: 'فرع المستخدم فقط', multi_branch: 'فروعه المحددة', all_branches: 'كل الفروع' };

function useAdminData() {
  const users = useQuery({ queryKey: ['admin-users'], queryFn: async () => (await apiClient.get<UserRow[]>('/admin/users')).data, retry: false });
  const roles = useQuery({ queryKey: ['admin-roles'], queryFn: async () => (await apiClient.get<Role[]>('/admin/roles')).data, retry: false });
  const perms = useQuery({ queryKey: ['admin-perms'], queryFn: async () => (await apiClient.get<Perms>('/admin/permissions')).data, retry: false });
  const branches = useQuery({ queryKey: ['admin-branches'], queryFn: async () => (await apiClient.get<Branch[]>('/branches')).data, retry: false });
  return { users, roles, perms, branches };
}

/** المستخدمون والصلاحيات: لكل مستخدم بريد وكلمة مرور خاصة ودور/أدوار ونطاق فروع. الخادم يطبّق كل القيود. */
export default function UsersPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'users' | 'roles' | 'me'>(can('admin.users.manage') ? 'users' : 'me');
  return (
    <div>
      <div className="page-hdr"><div><h1>المستخدمون والصلاحيات</h1><p>لكل مستخدم كلمة مرور خاصة وصلاحيات حسب دوره</p></div></div>
      <div className="mb-4 flex flex-wrap gap-2">
        {can('admin.users.manage') && <button className={`btn ${tab === 'users' ? 'btn-gold' : 'btn-outline'}`} onClick={() => setTab('users')}>👥 المستخدمون</button>}
        {can('admin.roles.manage') && <button className={`btn ${tab === 'roles' ? 'btn-gold' : 'btn-outline'}`} onClick={() => setTab('roles')}>🛡️ الأدوار</button>}
        <button className={`btn ${tab === 'me' ? 'btn-gold' : 'btn-outline'}`} onClick={() => setTab('me')}>🔑 كلمة مروري</button>
      </div>
      {tab === 'users' && can('admin.users.manage') && <UsersTab />}
      {tab === 'roles' && can('admin.roles.manage') && <RolesTab />}
      {tab === 'me' && <MyPassword />}
    </div>
  );
}

function MyPassword() {
  const [cur, setCur] = useState(''); const [n1, setN1] = useState(''); const [n2, setN2] = useState(''); const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const m = useMutation({
    mutationFn: async () => (await apiClient.post('/me/password', { currentPassword: cur, newPassword: n1 })).data,
    onSuccess: () => { setMsg({ ok: true, t: 'تم تغيير كلمة المرور. ستحتاج لتسجيل الدخول مجددًا على باقي الأجهزة.' }); setCur(''); setN1(''); setN2(''); },
    onError: (e) => setMsg({ ok: false, t: errMsg(e) }),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); setMsg(null); if (n1 !== n2) return setMsg({ ok: false, t: 'تأكيد كلمة المرور غير مطابق' }); m.mutate(); };
  return (
    <form className="card max-w-md space-y-3" onSubmit={submit}>
      <div className="card-hdr"><span className="card-title">تغيير كلمة مروري</span></div>
      <input className="input" type="password" autoComplete="current-password" placeholder="كلمة المرور الحالية" value={cur} onChange={(e) => setCur(e.target.value)} required />
      <input className="input" type="password" autoComplete="new-password" placeholder="كلمة المرور الجديدة" value={n1} onChange={(e) => setN1(e.target.value)} required />
      <input className="input" type="password" autoComplete="new-password" placeholder="تأكيد كلمة المرور الجديدة" value={n2} onChange={(e) => setN2(e.target.value)} required />
      <p className="text-xs text-slate-400">8 أحرف على الأقل وتحوي حروفًا وأرقامًا.</p>
      {msg && <p className={`text-sm ${msg.ok ? 'text-green-700' : 'text-red-600'}`}>{msg.t}</p>}
      <button className="btn btn-gold" disabled={m.isPending}>حفظ</button>
    </form>
  );
}

function Secret({ pw, onClose }: { pw: string; onClose: () => void }) {
  return (
    <div className="card mb-4 border-2 border-amber-400">
      <p className="font-bold">كلمة المرور المؤقتة — تظهر مرة واحدة فقط، سلِّمها للمستخدم وانصحه بتغييرها:</p>
      <p className="my-2 select-all rounded bg-slate-100 p-3 text-center text-lg font-mono" dir="ltr">{pw}</p>
      <div className="flex gap-2"><button className="btn btn-sm btn-outline" onClick={() => navigator.clipboard?.writeText(pw)}>نسخ</button><button className="btn btn-sm" onClick={onClose}>إغلاق</button></div>
    </div>
  );
}

function UsersTab() {
  const qc = useQueryClient();
  const { users, roles, branches } = useAdminData();
  const [secret, setSecret] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-users'] });
  const toggle = useMutation({ mutationFn: async (u: UserRow) => apiClient.patch(`/admin/users/${u.id}`, { isActive: !u.isActive }), onSuccess: refresh, onError: (e) => setErr(errMsg(e)) });
  const reset = useMutation({ mutationFn: async (u: UserRow) => (await apiClient.post<{ generatedPassword?: string }>(`/admin/users/${u.id}/reset-password`, {})).data, onSuccess: (d) => { setErr(null); if (d.generatedPassword) setSecret(d.generatedPassword); }, onError: (e) => setErr(errMsg(e)) });
  return (
    <div>
      {secret && <Secret pw={secret} onClose={() => setSecret(null)} />}
      {err && <p className="mb-3 text-sm text-red-600">{err}</p>}
      <div className="mb-3"><button className="btn btn-gold" onClick={() => { setEditing('new'); setErr(null); }}>➕ مستخدم جديد</button></div>
      {editing && <UserForm key={typeof editing === 'string' ? 'new' : editing.id} user={editing === 'new' ? null : editing} roles={roles.data ?? []} branches={branches.data ?? []} onDone={(pw) => { setEditing(null); refresh(); if (pw) setSecret(pw); }} onCancel={() => setEditing(null)} />}
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>الاسم</th><th>البريد</th><th>الأدوار</th><th>الفروع</th><th>آخر دخول</th><th>الحالة</th><th></th></tr></thead>
          <tbody>
            {(users.data ?? []).map((u) => (
              <tr key={u.id}>
                <td>{u.fullName}{u.isSelf ? ' (أنت)' : ''}</td><td dir="ltr">{u.email}</td>
                <td>{u.roles.map((r) => r.name).join('، ') || '—'}</td>
                <td>{u.allBranches ? 'كل الفروع' : `${u.branchIds.length} فرع`}</td>
                <td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('ar-EG') : '—'}</td>
                <td>{u.isActive ? '🟢 نشط' : '⛔ معطَّل'}</td>
                <td className="whitespace-nowrap">
                  <button className="btn btn-sm btn-outline" onClick={() => { setEditing(u); setErr(null); }}>تعديل</button>{' '}
                  <button className="btn btn-sm btn-info" onClick={() => { if (confirm(`إعادة ضبط كلمة مرور ${u.fullName}؟ ستنتهي جلساته الحالية.`)) reset.mutate(u); }}>🔑 كلمة مرور</button>{' '}
                  {!u.isSelf && <button className={`btn btn-sm ${u.isActive ? 'btn-danger' : 'btn-outline'}`} onClick={() => toggle.mutate(u)}>{u.isActive ? 'تعطيل' : 'تفعيل'}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {users.isError && <p className="mt-3 text-sm text-red-600">{errMsg(users.error)}</p>}
    </div>
  );
}

function UserForm({ user, roles, branches, onDone, onCancel }: { user: UserRow | null; roles: Role[]; branches: Branch[]; onDone: (pw?: string) => void; onCancel: () => void }) {
  const [fullName, setFullName] = useState(user?.fullName ?? ''); const [email, setEmail] = useState(user?.email ?? ''); const [phone, setPhone] = useState(user?.phone ?? '');
  const [password, setPassword] = useState(''); const [roleIds, setRoleIds] = useState<string[]>(user?.roles.map((r) => r.id) ?? []);
  const [all, setAll] = useState(user?.allBranches ?? false); const [bids, setBids] = useState<string[]>(user?.branchIds ?? []); const [err, setErr] = useState<string | null>(null);
  const tog = (arr: string[], id: string) => (arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);
  const m = useMutation({
    mutationFn: async () => {
      if (user) { await apiClient.patch(`/admin/users/${user.id}`, { fullName, phone: phone || null, ...(user.isSelf ? {} : { roleIds }), allBranches: all, branchIds: all ? [] : bids }); return {} as { generatedPassword?: string }; }
      return (await apiClient.post<{ generatedPassword?: string }>('/admin/users', { fullName, email, phone: phone || undefined, password: password || undefined, roleIds, allBranches: all, branchIds: all ? [] : bids })).data;
    },
    onSuccess: (d) => onDone(d.generatedPassword), onError: (e) => setErr(errMsg(e)),
  });
  return (
    <form className="card mb-4 space-y-3" onSubmit={(e) => { e.preventDefault(); setErr(null); m.mutate(); }}>
      <div className="card-hdr"><span className="card-title">{user ? `تعديل ${user.fullName}` : 'مستخدم جديد'}</span></div>
      <div className="grid gap-3 md:grid-cols-2">
        <input className="input" placeholder="الاسم الكامل" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
        <input className="input" dir="ltr" type="email" placeholder="البريد (اسم الدخول)" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={!!user} />
        <input className="input" dir="ltr" placeholder="الهاتف (اختياري)" value={phone} onChange={(e) => setPhone(e.target.value)} />
        {!user && <input className="input" dir="ltr" type="text" autoComplete="off" placeholder="كلمة المرور (اتركها فارغة لتوليدها)" value={password} onChange={(e) => setPassword(e.target.value)} />}
      </div>
      {!(user?.isSelf) && (
        <div><p className="mb-1 text-sm font-bold">الأدوار</p>
          <div className="flex flex-wrap gap-3">{roles.map((r) => <label key={r.id} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={roleIds.includes(r.id)} onChange={() => setRoleIds(tog(roleIds, r.id))} />{r.name}</label>)}</div></div>
      )}
      <div><p className="mb-1 text-sm font-bold">الفروع المسموحة</p>
        <label className="mb-1 flex items-center gap-1 text-sm"><input type="checkbox" checked={all} onChange={() => setAll(!all)} />كل الفروع</label>
        {!all && <div className="flex flex-wrap gap-3">{branches.map((b) => <label key={b.id} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={bids.includes(b.id)} onChange={() => setBids(tog(bids, b.id))} />{b.name_ar ?? b.name_en ?? b.id.slice(0, 6)}</label>)}</div>}
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}
      <div className="flex gap-2"><button className="btn btn-gold" disabled={m.isPending}>حفظ</button><button type="button" className="btn btn-outline" onClick={onCancel}>إلغاء</button></div>
    </form>
  );
}

function RolesTab() {
  const qc = useQueryClient();
  const { roles, perms } = useAdminData();
  const [editing, setEditing] = useState<Role | 'new' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const del = useMutation({ mutationFn: async (r: Role) => apiClient.delete(`/admin/roles/${r.id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-roles'] }), onError: (e) => setErr(errMsg(e)) });
  return (
    <div>
      {err && <p className="mb-3 text-sm text-red-600">{err}</p>}
      <div className="mb-3"><button className="btn btn-gold" onClick={() => { setEditing('new'); setErr(null); }}>➕ دور جديد</button></div>
      {editing && perms.data && <RoleForm key={typeof editing === 'string' ? 'new' : editing.id} role={editing === 'new' ? null : editing} perms={perms.data} onDone={() => { setEditing(null); qc.invalidateQueries({ queryKey: ['admin-roles'] }); }} onCancel={() => setEditing(null)} />}
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>الدور</th><th>عدد الصلاحيات</th><th>المستخدمون</th><th></th></tr></thead>
          <tbody>
            {(roles.data ?? []).map((r) => (
              <tr key={r.id}><td>{r.name}{r.isSystem ? ' 🔒' : ''}</td><td>{r.permissions.length}</td><td>{r.userCount}</td>
                <td>{!r.isSystem && <><button className="btn btn-sm btn-outline" onClick={() => { setEditing(r); setErr(null); }}>تعديل</button>{' '}<button className="btn btn-sm btn-danger" onClick={() => { if (confirm(`حذف الدور ${r.name}؟`)) del.mutate(r); }}>حذف</button></>}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RoleForm({ role, perms, onDone, onCancel }: { role: Role | null; perms: Perms; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(role?.name ?? ''); const [scope, setScope] = useState(role?.permissions[0]?.scope ?? 'own_branch');
  const [sel, setSel] = useState<Set<string>>(new Set(role?.permissions.map((p) => p.code) ?? [])); const [err, setErr] = useState<string | null>(null);
  const groups = useMemo(() => { const g = new Map<string, string[]>(); for (const c of perms.grantable) { const k = c.split('.')[0]; g.set(k, [...(g.get(k) ?? []), c]); } return [...g.entries()]; }, [perms]);
  const flip = (codes: string[], on: boolean) => setSel((s) => { const n = new Set(s); codes.forEach((c) => (on ? n.add(c) : n.delete(c))); return n; });
  const m = useMutation({
    mutationFn: async () => { const body = { name, scope, permissionCodes: [...sel] }; return role ? apiClient.put(`/admin/roles/${role.id}`, body) : apiClient.post('/admin/roles', body); },
    onSuccess: onDone, onError: (e) => setErr(errMsg(e)),
  });
  return (
    <form className="card mb-4 space-y-3" onSubmit={(e) => { e.preventDefault(); setErr(null); if (sel.size === 0) return setErr('اختر صلاحية واحدة على الأقل'); m.mutate(); }}>
      <div className="card-hdr"><span className="card-title">{role ? `تعديل الدور ${role.name}` : 'دور جديد'}</span></div>
      <div className="grid gap-3 md:grid-cols-2">
        <input className="input" placeholder="اسم الدور" value={name} onChange={(e) => setName(e.target.value)} required />
        <select className="input" value={scope} onChange={(e) => setScope(e.target.value)}>{Object.entries(SCOPES).map(([k, v]) => <option key={k} value={k}>نطاق الصلاحيات: {v}</option>)}</select>
      </div>
      <div><p className="mb-1 text-sm font-bold">قوالب جاهزة (تستبدل الاختيار الحالي)</p>
        <div className="flex flex-wrap gap-2">{perms.templates.map((t) => <button type="button" key={t.id} title={t.desc} className="btn btn-sm btn-outline" onClick={() => { setSel(new Set(t.codes.filter((c) => perms.grantable.includes(c)))); if (!name) setName(t.name); }}>{t.name}</button>)}</div></div>
      <div className="max-h-96 space-y-3 overflow-auto rounded border border-slate-200 p-3">
        {groups.map(([k, codes]) => (
          <div key={k}>
            <p className="mb-1 flex items-center gap-2 text-sm font-bold" dir="ltr"><span>{k}</span>
              <button type="button" className="text-xs text-blue-600" onClick={() => flip(codes, true)}>الكل</button><button type="button" className="text-xs text-blue-600" onClick={() => flip(codes, false)}>لا شيء</button></p>
            <div className="grid gap-1 md:grid-cols-2" dir="ltr">{codes.map((c) => <label key={c} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={sel.has(c)} onChange={(e) => flip([c], e.target.checked)} />{c}</label>)}</div>
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-400">المحدَّد: {sel.size} صلاحية. لا يمكنك منح صلاحية لا تملكها أنت.</p>
      {err && <p className="text-sm text-red-600">{err}</p>}
      <div className="flex gap-2"><button className="btn btn-gold" disabled={m.isPending}>حفظ</button><button type="button" className="btn btn-outline" onClick={onCancel}>إلغاء</button></div>
    </form>
  );
}

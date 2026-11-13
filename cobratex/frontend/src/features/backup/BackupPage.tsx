import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient, backendOrigin, extractErrorMessage } from '@/api/client';
import { toast } from '@/ui/toast';

interface Settings {
  googleClientId: string | null; hasClientSecret: boolean; googleAccountEmail: string | null; driveConnected: boolean;
  driveFolderName: string; autoEnabled: boolean; retentionCount: number;
  lastBackupAt: string | null; lastBackupStatus: string | null; lastBackupError: string | null; lastBackupName: string | null;
}
interface Local { name: string; sizeBytes: number; modifiedAt: string }
interface DriveFile { id: string; name: string; sizeBytes: number; createdAt: string }
interface Status { settings: Settings; local: Local[]; dir: string }

const fmtSize = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleString('ar-EG') : '—');
const STATUS: Record<string, { t: string; cls: string }> = {
  ok: { t: 'ناجحة', cls: 'b-paid' }, partial: { t: 'محلية فقط (فشل رفع Drive)', cls: 'b-pend' }, failed: { t: 'فشلت', cls: 'b-late' },
};

/** النسخ الاحتياطي: يدوي (إنشاء/تنزيل/استعادة) + ربط Google Drive + نسخ تلقائي يومي. صلاحية system.backup.manage. */
export default function BackupPage() {
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [drive, setDrive] = useState<DriveFile[] | null>(null);
  const [cid, setCid] = useState('');
  const [secret, setSecret] = useState('');
  const [folder, setFolder] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const r = (await apiClient.get<Status>('/backup/status')).data;
      setSt(r); setErr(null);
      setCid((v) => v || r.settings.googleClientId || '');
      setFolder((v) => v || r.settings.driveFolderName);
    } catch (e) { setErr(extractErrorMessage(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e) { toast(extractErrorMessage(e), 'error', 6000); } finally { setBusy(null); }
  };

  const create = (up: boolean) => run(up ? 'cd' : 'c', async () => {
    const r = (await apiClient.post('/backup/create', { uploadToDrive: up })).data as { name: string; driveError: string | null; drive: unknown };
    if (up && r.driveError) toast(`تم حفظ النسخة محليًا لكن فشل رفع Drive: ${r.driveError}`, 'warn', 7000);
    else toast(up ? 'تم إنشاء النسخة ورفعها إلى Google Drive' : 'تم إنشاء النسخة الاحتياطية', 'success');
    await load();
    if (up && st?.settings.driveConnected) void listDrive();
  });

  const download = (name: string) => run('d' + name, async () => {
    const r = await apiClient.get(`/backup/download/${encodeURIComponent(name)}`, { responseType: 'blob' });
    const url = URL.createObjectURL(r.data as Blob);
    const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
  });

  const confirmRestore = (what: string) =>
    window.prompt(`⚠️ الاستعادة تستبدل كل بيانات النظام الحالية بمحتوى النسخة (${what}). تُنشأ نسخة أمان تلقائيًا قبلها.\nاكتب RESTORE للمتابعة:`) === 'RESTORE';

  const afterRestore = (r: { tables: number; rows: number; safetyBackup: string | null }) => {
    toast(`تمت الاستعادة: ${r.tables} جدول و${r.rows} صف. نسخة الأمان: ${r.safetyBackup ?? '—'}. سيُعاد تحميل الصفحة…`, 'success', 6000);
    setTimeout(() => window.location.reload(), 2500);
  };

  const restoreLocal = (name: string) => {
    if (!confirmRestore(name)) return;
    void run('r' + name, async () => afterRestore((await apiClient.post(`/backup/restore/local/${encodeURIComponent(name)}`, { confirm: 'RESTORE' })).data));
  };
  const restoreUpload = (f: File) => {
    if (!confirmRestore(f.name)) return;
    void run('ru', async () => {
      const fd = new FormData(); fd.append('file', f); fd.append('confirm', 'RESTORE');
      afterRestore((await apiClient.post('/backup/restore/upload', fd)).data);
    });
  };
  const removeLocal = (name: string) => {
    if (!window.confirm(`حذف ${name}؟`)) return;
    void run('x' + name, async () => { await apiClient.delete(`/backup/local/${encodeURIComponent(name)}`); await load(); });
  };

  const saveSettings = (patch: Record<string, unknown>, okMsg = 'تم حفظ الإعدادات') =>
    run('s', async () => { await apiClient.put('/backup/settings', patch); toast(okMsg, 'success'); await load(); });

  const listDrive = () => run('dl', async () => setDrive((await apiClient.get<DriveFile[]>('/backup/drive/files')).data));
  const restoreDrive = (f: DriveFile) => {
    if (!confirmRestore(f.name)) return;
    void run('rd' + f.id, async () => afterRestore((await apiClient.post('/backup/restore/drive', { fileId: f.id, confirm: 'RESTORE' })).data));
  };

  const connect = () => run('g', async () => {
    const { url } = (await apiClient.get<{ url: string }>('/backup/google/auth-url')).data;
    const w = window.open(url, 'cobratex-drive', 'width=560,height=720');
    if (!w) { window.location.href = url; return; }
    const onMsg = (ev: MessageEvent) => {
      if ((ev.data as { type?: string })?.type !== 'cobratex-drive') return;
      window.removeEventListener('message', onMsg);
      toast((ev.data as { ok: boolean }).ok ? 'تم ربط Google Drive' : 'لم يكتمل الربط', (ev.data as { ok: boolean }).ok ? 'success' : 'error');
      void load();
    };
    window.addEventListener('message', onMsg);
    // احتياطي إن لم تصل الرسالة (مثل حظر opener): نستطلع الحالة حتى يظهر الربط أو تُغلق النافذة.
    const t0 = Date.now();
    const iv = window.setInterval(async () => {
      try {
        const r = (await apiClient.get<Status>('/backup/status')).data;
        if (r.settings.driveConnected && !st?.settings.driveConnected) { setSt(r); window.clearInterval(iv); window.removeEventListener('message', onMsg); toast('تم ربط Google Drive', 'success'); }
      } catch { /* تجاهل */ }
      if (Date.now() - t0 > 180000 || w.closed) window.clearInterval(iv);
    }, 2000);
  });
  const disconnect = () => {
    if (!window.confirm('فصل Google Drive؟ لن تُحذف الملفات الموجودة عليه.')) return;
    void run('gd', async () => { await apiClient.post('/backup/google/disconnect'); setDrive(null); await load(); });
  };

  if (err) {
    return (
      <div className="card">
        <div className="card-hdr"><span className="card-title">النسخ الاحتياطي</span></div>
        <p className="text-sm text-red-700">{err}</p>
        <p className="mt-2 text-xs text-slate-500">تتطلب هذه الصفحة صلاحية «system.backup.manage»، وهي متاحة في التثبيت الخاص بعميل واحد.</p>
      </div>
    );
  }
  if (!st) return <p className="text-sm text-slate-500">جارٍ التحميل…</p>;
  const s = st.settings;
  const last = s.lastBackupStatus ? STATUS[s.lastBackupStatus] : null;
  const redirectUri = `${backendOrigin || window.location.origin}/api/backup/google/callback`;

  return (
    <div>
      <div className="page-hdr">
        <div><h1>النسخ الاحتياطي</h1><p>نسخ يدوي وتلقائي، وربط Google Drive، واستعادة كاملة</p></div>
      </div>

      <section className="card">
        <div className="card-hdr"><span className="card-title">الحالة</span>{last && <span className={`badge ${last.cls}`}>{last.t}</span>}</div>
        <p className="text-sm text-slate-600">آخر نسخة: <b>{fmtDate(s.lastBackupAt)}</b>{s.lastBackupName && <span dir="ltr"> · {s.lastBackupName}</span>}</p>
        {s.lastBackupError && <p className="mt-1 text-xs text-red-700">{s.lastBackupError}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <button className="btn btn-primary" disabled={!!busy} onClick={() => create(false)}>{busy === 'c' ? 'جارٍ النسخ…' : '💾 نسخة احتياطية الآن'}</button>
          <button className="btn btn-gold" disabled={!!busy || !s.driveConnected} onClick={() => create(true)} title={s.driveConnected ? '' : 'اربط Google Drive أولًا'}>
            {busy === 'cd' ? 'جارٍ النسخ والرفع…' : '☁️ نسخة + رفع إلى Drive'}
          </button>
          <button className="btn btn-outline" disabled={!!busy} onClick={() => fileRef.current?.click()}>📂 استعادة من ملف…</button>
          <input ref={fileRef} type="file" accept=".cbk" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) restoreUpload(f); }} />
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={s.autoEnabled} onChange={(e) => void saveSettings({ autoEnabled: e.target.checked }, e.target.checked ? 'فُعِّل النسخ اليومي التلقائي' : 'أُوقف النسخ التلقائي')} />
          نسخ تلقائي يومي (يرفع إلى Drive إن كان مربوطًا) — يعمل أثناء تشغيل البرنامج
        </label>
        <label className="mt-2 flex items-center gap-2 text-sm">
          الاحتفاظ بآخر
          <input type="number" min={1} max={365} defaultValue={s.retentionCount} key={s.retentionCount} className="w-20 rounded border border-slate-300 px-2 py-1"
            onBlur={(e) => { const n = Number(e.target.value); if (n >= 1 && n <= 365 && n !== s.retentionCount) void saveSettings({ retentionCount: n }); }} />
          نسخة (محليًا وعلى Drive)
        </label>
      </section>

      <section className="card">
        <div className="card-hdr"><span className="card-title">النسخ المحلية</span><span className="text-xs text-slate-400" dir="ltr">{st.dir}</span></div>
        {st.local.length === 0 ? <p className="text-sm text-slate-500">لا توجد نسخ محلية بعد.</p> : (
          <div className="tbl-wrap"><table className="w-full text-sm"><thead><tr><th>الملف</th><th>الحجم</th><th>التاريخ</th><th /></tr></thead><tbody>
            {st.local.map((b) => (
              <tr key={b.name}>
                <td dir="ltr">{b.name}</td><td>{fmtSize(b.sizeBytes)}</td><td>{fmtDate(b.modifiedAt)}</td>
                <td className="whitespace-nowrap text-left">
                  <button className="btn btn-sm btn-outline" disabled={!!busy} onClick={() => download(b.name)}>تنزيل</button>{' '}
                  <button className="btn btn-sm btn-info" disabled={!!busy} onClick={() => restoreLocal(b.name)}>استعادة</button>{' '}
                  <button className="btn btn-sm btn-danger" disabled={!!busy} onClick={() => removeLocal(b.name)}>حذف</button>
                </td>
              </tr>
            ))}
          </tbody></table></div>
        )}
        <p className="mt-3 text-xs leading-6 text-slate-400">للنسخ اليدوي إلى Drive بدون ربط: نزِّل الملف (.cbk) وارفعه بنفسك إلى Drive، وللاستعادة استخدم «استعادة من ملف».</p>
      </section>

      <section className="card">
        <div className="card-hdr">
          <span className="card-title">Google Drive</span>
          <span className={`badge ${s.driveConnected ? 'b-paid' : 'b-pend'}`}>{s.driveConnected ? `مربوط${s.googleAccountEmail ? ` · ${s.googleAccountEmail}` : ''}` : 'غير مربوط'}</span>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-sm">Client ID<input dir="ltr" className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5" value={cid} onChange={(e) => setCid(e.target.value)} /></label>
          <label className="text-sm">Client Secret {s.hasClientSecret && <span className="text-xs text-slate-400">(محفوظ — اتركه فارغًا لإبقائه)</span>}
            <input dir="ltr" type="password" className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5" value={secret} onChange={(e) => setSecret(e.target.value)} /></label>
          <label className="text-sm">اسم المجلد على Drive<input className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5" value={folder} onChange={(e) => setFolder(e.target.value)} /></label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn btn-primary" disabled={!!busy || !cid} onClick={() => void saveSettings({ googleClientId: cid, ...(secret ? { googleClientSecret: secret } : {}), driveFolderName: folder || undefined }, 'تم حفظ بيانات Google').then(() => setSecret(''))}>حفظ البيانات</button>
          <button className="btn btn-gold" disabled={!!busy || !s.googleClientId || !s.hasClientSecret} onClick={connect}>{s.driveConnected ? 'إعادة الربط' : '🔗 ربط Google Drive'}</button>
          {s.driveConnected && <button className="btn btn-outline" disabled={!!busy} onClick={() => void listDrive()}>عرض نسخ Drive</button>}
          {s.driveConnected && <button className="btn btn-danger" disabled={!!busy} onClick={disconnect}>فصل</button>}
        </div>
        <details className="mt-4 text-xs leading-6 text-slate-500">
          <summary className="cursor-pointer font-bold">كيف أحصل على Client ID وSecret؟ (مرة واحدة، مجانًا)</summary>
          <ol className="mr-5 list-decimal">
            <li>افتح console.cloud.google.com وأنشئ مشروعًا، ثم فعّل «Google Drive API».</li>
            <li>شاشة الموافقة (OAuth consent): اختر External وأضف بريدك مستخدمًا تجريبيًا.</li>
            <li>Credentials ← Create credentials ← OAuth client ID ← نوع Web application.</li>
            <li>في Authorized redirect URIs ضع بالضبط: <code dir="ltr" className="select-all">{redirectUri}</code></li>
            <li>انسخ Client ID وClient Secret هنا واضغط حفظ ثم «ربط Google Drive».</li>
          </ol>
          النطاق المطلوب drive.file فقط: لا يرى البرنامج إلا الملفات التي ينشئها هو.
        </details>
        {drive && (
          <div className="tbl-wrap mt-4"><table className="w-full text-sm"><thead><tr><th>الملف على Drive</th><th>الحجم</th><th>التاريخ</th><th /></tr></thead><tbody>
            {drive.length === 0 && <tr><td colSpan={4} className="text-slate-500">المجلد فارغ.</td></tr>}
            {drive.map((f) => (
              <tr key={f.id}><td dir="ltr">{f.name}</td><td>{fmtSize(f.sizeBytes)}</td><td>{fmtDate(f.createdAt)}</td>
                <td className="text-left"><button className="btn btn-sm btn-info" disabled={!!busy} onClick={() => restoreDrive(f)}>استعادة</button></td></tr>
            ))}
          </tbody></table></div>
        )}
      </section>
    </div>
  );
}

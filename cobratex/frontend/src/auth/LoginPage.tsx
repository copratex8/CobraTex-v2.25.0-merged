import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { extractErrorMessage } from '@/api/client';
import { useBrand } from '@/brand/BrandProvider';
import { BrandLogoFull, DeveloperCredit } from '@/brand/BrandParts';
import InstallAppButton from '@/pwa/InstallAppButton';
import { ContactActions } from '@/brand/DeveloperContact';
import { usePlatformStatus } from '@/platform/usePlatformStatus';
import AnnouncementList from '@/platform/AnnouncementList';

const TENANT_KEY = 'cobratex_tenant_id';

function readSavedTenant(): string {
  try {
    return localStorage.getItem(TENANT_KEY) ?? '';
  } catch {
    return '';
  }
}

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const brand = useBrand();
  const [tenantId, setTenantId] = useState(readSavedTenant);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // معرّف المستأجر الافتراضي من brand.json (نشر عميل واحد) يملأ الحقل إن كان فارغًا.
  const effectiveTenant = brand.defaultTenantId || tenantId;

  const { data: platform } = usePlatformStatus(effectiveTenant);
  const suspended = platform?.status === 'suspended';

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login({ tenantId: effectiveTenant, email, password });
      try {
        localStorage.setItem(TENANT_KEY, effectiveTenant);
      } catch {
        /* التخزين غير متاح — لا يؤثر على الدخول */
      }
      navigate('/', { replace: true });
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  const inputCls = 'mb-4 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm';
  return (
    <div className="ct-login-bg flex min-h-screen flex-col items-center justify-center p-4">
      <InstallAppButton variant="banner" />
      <form onSubmit={handleSubmit} className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-2xl">
        <div className="mb-5 flex flex-col items-center text-center">
          <BrandLogoFull width={230} />
          <h1 className="sr-only">{brand.appName}</h1>
          <p className="mt-1 text-xs text-slate-500">{brand.tagline}</p>
        </div>

        <AnnouncementList items={platform?.announcements ?? []} />
        {suspended && (
          <p role="alert" className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
            🔒 {platform?.message}
          </p>
        )}

        {!brand.defaultTenantId && (
          <>
            <label className="mb-1 block text-sm font-medium text-slate-700">معرّف المستأجر (Tenant ID)</label>
            <input
              className={inputCls}
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              dir="ltr"
              required
            />
          </>
        )}

        <label className="mb-1 block text-sm font-medium text-slate-700">البريد الإلكتروني</label>
        <input type="email" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" required />

        <label className="mb-1 block text-sm font-medium text-slate-700">كلمة المرور</label>
        <input type="password" className="mb-6 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" required />

        {error && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <button type="submit" disabled={loading || suspended} className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition disabled:opacity-50">
          {loading ? 'جارٍ الدخول...' : 'دخول'}
        </button>
      </form>
      <p className="mt-5 text-xs text-white/60">للاشتراك أو الدعم الفني:</p>
      <ContactActions className="mt-2" text={`مرحبًا، أرغب في الاستفسار عن نظام ${brand.appName}`} />
      <DeveloperCredit className="mt-6 text-center text-xs text-white/50" />
    </div>
  );
}

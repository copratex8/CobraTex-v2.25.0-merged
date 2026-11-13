import axios from 'axios';
import { markSuspended, markLicenseIssue } from '@/platform/suspension';
import { AUTH_MODE, supabase } from '@/lib/supabaseClient';

// عنوان الـ API قابل للتهيئة عبر متغير بيئة (Vite) — يُضبط في .env أو .env.production عند النشر.
// القيمة الافتراضية تفترض تشغيل الباك إند محليًا على المنفذ 4000 (راجع backend/.env.example).
const baseURL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000/api';

export const apiClient = axios.create({ baseURL });

/** أصل الباك إند بلا لاحقة /api — تُستخدَم لبناء روابط مطلقة لأصول ثابتة يقدّمها الباك إند نفسه
 * (مثل ملفات JS الخاصة بالإضافات عبر /plugin-assets)، والتي لا تمر عبر apiClient (ليست JSON). */
export const backendOrigin = baseURL.replace(/\/api\/?$/, '');

const TOKEN_KEY = 'cobratex_access_token';
const REFRESH_TOKEN_KEY = 'cobratex_refresh_token';

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function getStoredRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function setStoredRefreshToken(token: string | null) {
  if (token) localStorage.setItem(REFRESH_TOKEN_KEY, token);
  else localStorage.removeItem(REFRESH_TOKEN_KEY);
}

export function setSessionTokens(accessToken: string | null, refreshToken: string | null) {
  setStoredToken(accessToken);
  setStoredRefreshToken(refreshToken);
}

/** معرّف جهاز ثابت في هذا المتصفح (لترخيص الربط بالجهاز). لا يحوي بيانات شخصية. */
export function getDeviceId(): string {
  try {
    let id = localStorage.getItem('cobratex_device_id');
    if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
      id = (crypto.randomUUID?.() ?? `d${Date.now().toString(36)}${Math.random().toString(36).slice(2)}0000000000`).replace(/[^A-Za-z0-9_-]/g, '');
      localStorage.setItem('cobratex_device_id', id);
    }
    return id;
  } catch { return 'unknown-device-0000'; }
}

/** وضع supabase: التوكن من جلسة supabase-js (تُجدَّد تلقائيًا عند انتهائها). وضع legacy: من التخزين المحلي. */
async function currentAccessToken(): Promise<string | null> {
  if (AUTH_MODE === 'supabase' && supabase) {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }
  return getStoredToken();
}

apiClient.interceptors.request.use(async (config) => {
  const token = await currentAccessToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  config.headers['X-Device-Id'] = getDeviceId();
  return config;
});

/**
 * الباك إند الآن يدعم Refresh Token (/auth/refresh) — access token صالح 15 دقيقة فقط، لكن refresh
 * token صالح 7 أيام ويُدوَّر (rotate) عند كل استخدام. عند أول 401 لأي طلب (غير طلب تسجيل الدخول أو
 * التجديد نفسه)، نحاول تجديدًا صامتًا مرة واحدة فقط ثم نُعيد الطلب الأصلي بالتوكن الجديد. لتفادي
 * "عاصفة تجديد" عند فشل عدة طلبات متزامنة بـ401 دفعة واحدة، كل الطلبات المتزامنة تشترك في وعد
 * تجديد واحد (refreshPromise) بدل استدعاء /auth/refresh لكل واحد منها على حدة — تجديد واحد يكفيها كلها.
 */
let refreshPromise: Promise<string | null> | null = null;

async function performRefresh(): Promise<string | null> {
  if (AUTH_MODE === 'supabase' && supabase) {
    const { data, error } = await supabase.auth.refreshSession();
    return error ? null : (data.session?.access_token ?? null);
  }
  const storedRefreshToken = getStoredRefreshToken();
  if (!storedRefreshToken) return null;
  try {
    const res = await axios.post(`${baseURL}/auth/refresh`, { refreshToken: storedRefreshToken }, { headers: { 'X-Device-Id': getDeviceId() } });
    setSessionTokens(res.data.accessToken, res.data.refreshToken);
    return res.data.accessToken as string;
  } catch {
    setSessionTokens(null, null);
    return null;
  }
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config as (typeof error.config & { _retried?: boolean }) | undefined;
    // زر الإيقاف عن بُعد (لوحة المطور): الخادم يرد 503 + SERVICE_SUSPENDED برسالة المطوّر.
    if (error.response?.status === 503 && error.response?.data?.code === 'SERVICE_SUSPENDED') {
      markSuspended(String(error.response.data.error ?? ''));
    }
    // الترخيص (2.22.0): أكواد LICENSE_* من حارس الخادم. الكتابة المرفوضة بعد الانتهاء (وضع القراءة) = شريط فقط؛ غير ذلك يحجب الواجهة.
    const lcode = error.response?.data?.code;
    if (typeof lcode === 'string' && lcode.startsWith('LICENSE_') && lcode !== 'LICENSE_LIMIT') {
      const isWrite = ['post', 'put', 'patch', 'delete'].includes(String(originalRequest?.method ?? '').toLowerCase());
      markLicenseIssue(lcode, String(error.response.data.error ?? ''), !(lcode === 'LICENSE_EXPIRED' && isWrite && !String(originalRequest?.url ?? '').includes('/auth/')));
    }
    const isAuthEndpoint = originalRequest?.url?.includes('/auth/login') || originalRequest?.url?.includes('/auth/refresh');

    if (error.response?.status === 401 && originalRequest && !originalRequest._retried && !isAuthEndpoint) {
      originalRequest._retried = true;
      if (!refreshPromise) {
        refreshPromise = performRefresh().finally(() => { refreshPromise = null; });
      }
      const newAccessToken = await refreshPromise;
      if (newAccessToken) {
        originalRequest.headers = originalRequest.headers ?? {};
        originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
        return apiClient(originalRequest);
      }
    }

    if (error.response?.status === 401) {
      setSessionTokens(null, null);
      if (AUTH_MODE === 'supabase' && supabase) void supabase.auth.signOut();
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  },
);

/** يستخرج رسالة الخطأ من: خطأ axios ({error}) أو خطأ Supabase/Error ({message}) أو رسالة عامة. */
export function extractErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { error?: string } | undefined;
    if (data?.error) return data.error;
    if (error.message) return error.message;
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const m = (error as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  return 'حدث خطأ غير متوقع';
}

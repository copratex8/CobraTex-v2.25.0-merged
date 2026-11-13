import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiClient, getStoredToken, getStoredRefreshToken, setSessionTokens, setStoredToken } from '@/api/client';
import { AUTH_MODE, supabase } from '@/lib/supabaseClient';

interface AuthUser {
  userId: string;
  branchIds: string[];
  companyId: string;
  tenantId: string;
  /** أكواد الصلاحيات الممنوحة (للإخفاء في الواجهة فقط؛ الخادم هو المُنفِّذ). */
  permissions: string[];
}

interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  can: (code: string) => boolean;
  login: (input: { tenantId: string; email: string; password: string }) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface TokenClaims {
  sub?: string;
  userId?: string;
  tenantId?: string;
  companyId?: string;
  tenant_id?: string;
  company_id?: string;
  branchIds?: string[];
  branch_ids?: string[];
  permissions?: Array<{ code: string }>;
}

function decodeClaims(token: string): TokenClaims | null {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(atob(b64).split('').map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
    return JSON.parse(json) as TokenClaims;
  } catch {
    return null;
  }
}

/**
 * قراءة محتوى JWT دون تحقق توقيع — لغرض عرض واجهة فقط. الأمان الفعلي مفروض دائمًا من الخادم/RLS.
 *  - توكن CobraTex (legacy): يحمل userId/tenantId/companyId/branchIds/permissions.
 *  - توكن Supabase: يحمل sub + tenant_id/company_id/branch_ids (من custom_access_token_hook)؛ الصلاحيات تُجلب من /auth/me.
 */
function userFromToken(token: string | null): AuthUser | null {
  if (!token) return null;
  const c = decodeClaims(token);
  if (!c) return null;
  const userId = AUTH_MODE === 'supabase' ? c.sub : (c.userId ?? c.sub);
  if (!userId) return null; // يُسقط أيضًا التوكنات القديمة المتبقية من الوضع الآخر
  return {
    userId,
    branchIds: c.branchIds ?? c.branch_ids ?? [],
    companyId: c.companyId ?? c.company_id ?? '',
    tenantId: c.tenantId ?? c.tenant_id ?? '',
    permissions: Array.isArray(c.permissions) ? c.permissions.map((p) => p.code) : [],
  };
}

const LOGIN_ERROR = 'بيانات الدخول غير صحيحة';

/**
 * الباك إند يشترط tenantId صراحةً في /auth/login (تعدُّد المستأجرين). الجلسة تُجدَّد صامتًا عبر refresh token (client.ts).
 * في وضع Supabase يُطابَق tenantId المُدخَل مع tenant_id في توكن الحساب كي تبقى شاشة الدخول متعددة العملاء ذات معنى.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() => userFromToken(getStoredToken()));

  useEffect(() => {
    if (AUTH_MODE !== 'supabase' || !supabase) return;
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      const token = session?.access_token ?? null;
      setStoredToken(token); // مرآة لمن يقرأ getStoredToken() بشكل متزامن (PluginHost)
      setUser((prev) => {
        const next = userFromToken(token);
        return next ? { ...next, permissions: prev?.userId === next.userId ? prev.permissions : [] } : null;
      });
    });
    return () => data.subscription.unsubscribe();
  }, []);

  // وضع Supabase: التوكن لا يحمل الصلاحيات ⇒ تُجلب مرة لكل مستخدم من الخادم (تُفرض هناك على أي حال).
  const uid = user?.userId;
  useEffect(() => {
    if (AUTH_MODE !== 'supabase' || !uid) return;
    let cancelled = false;
    apiClient.get<{ permissions?: Array<{ code: string }> }>('/auth/me')
      .then((r) => { if (!cancelled) setUser((u) => (u && u.userId === uid ? { ...u, permissions: (r.data.permissions ?? []).map((p) => p.code) } : u)); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [uid]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isAuthenticated: !!user,
      can: (code) => !!user && user.permissions.includes(code),
      login: async ({ tenantId, email, password }) => {
        if (AUTH_MODE === 'supabase' && supabase) {
          const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
          if (error || !data.session) throw new Error(LOGIN_ERROR);
          const claims = decodeClaims(data.session.access_token);
          if (tenantId.trim() && claims?.tenant_id && claims.tenant_id !== tenantId.trim()) {
            await supabase.auth.signOut();
            throw new Error(LOGIN_ERROR);
          }
          return;
        }
        const res = await apiClient.post('/auth/login', { tenantId, email, password });
        setSessionTokens(res.data.accessToken, res.data.refreshToken);
        setUser(userFromToken(res.data.accessToken));
      },
      logout: () => {
        if (AUTH_MODE === 'supabase' && supabase) {
          void supabase.auth.signOut();
          return;
        }
        const refreshToken = getStoredRefreshToken();
        setSessionTokens(null, null);
        setUser(null);
        if (refreshToken) {
          // إبطال أفضل-جهد لصف الـ refresh token في الباك إند — لا ننتظر النتيجة ولا نمنع الخروج محليًا لو فشل الطلب.
          apiClient.post('/auth/logout', { refreshToken }).catch(() => {});
        }
      },
    }),
    [user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth يجب أن يُستخدَم داخل AuthProvider');
  return ctx;
}

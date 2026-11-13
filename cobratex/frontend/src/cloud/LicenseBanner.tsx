import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { useLicenseIssue } from '@/platform/suspension';

interface LicenseStatus {
  licensed: boolean; planType?: string; state?: 'not_started' | 'active' | 'grace' | 'expired'; daysLeft?: number | null;
  expiresAt?: string | null; graceEndsAt?: string | null; expiredMode?: 'readonly' | 'block';
}
const fmt = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('ar-EG') : '');

/** شريط حالة الترخيص (2.22.0): تنبيه قبل الانتهاء بـ14 يومًا، ومهلة السماح، ووضع القراءة فقط. لا يظهر لترخيص سليم أو عميل بلا ترخيص. */
export function LicenseBanner() {
  const issue = useLicenseIssue();
  const { data } = useQuery({
    queryKey: ['license-status'],
    queryFn: async () => (await apiClient.get<LicenseStatus>('/license/status')).data,
    staleTime: 10 * 60_000,
    retry: false,
  });
  let text: string | null = null; let danger = false;
  if (issue && !issue.block) { text = issue.message; danger = true; }
  else if (data?.licensed) {
    if (data.state === 'grace') { text = `انتهى الترخيص بتاريخ ${fmt(data.expiresAt)} — مهلة السماح حتى ${fmt(data.graceEndsAt)}. جدّد الاشتراك لتفادي التقييد.`; danger = true; }
    else if (data.state === 'expired') { text = data.expiredMode === 'readonly' ? 'انتهى الترخيص: النظام في وضع القراءة فقط. جدّد الاشتراك لاستعادة الإدخال.' : 'انتهى الترخيص.'; danger = true; }
    else if (data.state === 'active' && data.daysLeft != null && data.daysLeft <= 14) text = `ينتهي الترخيص خلال ${data.daysLeft} يومًا (${fmt(data.expiresAt)}). تواصل مع مزوّد الخدمة للتجديد.`;
  }
  if (!text) return null;
  return (
    <div className="ct-no-print px-4 py-2 text-center text-sm font-semibold" role="status"
      style={{ background: danger ? 'linear-gradient(135deg,#c0392b,#e74c3c)' : 'linear-gradient(135deg,var(--gold),var(--gold2))', color: danger ? '#fff' : 'var(--navy)' }}>
      {text}
    </div>
  );
}

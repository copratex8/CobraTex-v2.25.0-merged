import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

interface Cur { code: string; name_ar: string | null; name: string; is_active: boolean; isBase: boolean }

/** اختيار العملة وسعر الصرف للمستندات: الأجنبية بلا سعر يُجلب سعرها من جدول أسعار الصرف (بيع/شراء حسب المستند)، ويُرفض المستند إن لم يوجد سعر. */
export function useCurrencyChoice() {
  const [currencyCode, setCurrencyCode] = useState('EGP'); const [exchangeRate, setExchangeRate] = useState('');
  const { data } = useQuery({ queryKey: ['fx-currencies'], queryFn: async () => (await apiClient.get<Cur[]>('/fx/currencies')).data, retry: false, staleTime: 60_000 });
  const base = data?.find((c) => c.isBase)?.code ?? 'EGP';
  const foreign = currencyCode !== base;
  const payload = { currencyCode, ...(foreign && exchangeRate ? { exchangeRate } : {}) };
  const fields = (
    <div className="grid gap-3 md:grid-cols-2">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">العملة</span>
        <select value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
          {(data?.filter((c) => c.is_active) ?? [{ code: 'EGP', name_ar: 'جنيه مصري', name: 'EGP', is_active: true, isBase: true }]).map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name_ar ?? c.name}</option>)}
        </select>
      </label>
      {foreign && (
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">سعر الصرف (فارغ = من الجدول)</span>
          <input value={exchangeRate} onChange={(e) => setExchangeRate(e.target.value)} inputMode="decimal" placeholder="تلقائي" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        </label>
      )}
    </div>
  );
  return { currencyCode, exchangeRate, foreign, base, payload, fields };
}

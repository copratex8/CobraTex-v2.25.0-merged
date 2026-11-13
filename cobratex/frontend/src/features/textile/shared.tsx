/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, extractErrorMessage } from '@/api/client';
import { toast } from '@/ui/toast';

/** صفوف الخادم (أسماء أعمدة snake_case كما ترجع من الـAPI). */
export type Row = Record<string, any>;

export const inputCls = 'w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm';

export function useGet<T = Row[]>(url: string, params?: Record<string, unknown>, enabled = true) {
  const clean = Object.fromEntries(Object.entries(params ?? {}).filter(([, v]) => v !== '' && v !== undefined && v !== null));
  return useQuery({
    queryKey: ['textile', url, clean],
    queryFn: async () => (await apiClient.get<T>(url, { params: clean })).data,
    enabled,
    retry: false,
  });
}

/** يرسل طلبًا ويُظهر نجاحًا/خطأً ويُحدِّث كل استعلامات الغزل والنسيج. */
export function useAction() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  async function run<T = Row>(fn: () => Promise<{ data: T }>, okMsg?: string): Promise<T | null> {
    setBusy(true);
    try {
      const r = await fn();
      if (okMsg) toast(okMsg, 'success');
      await qc.invalidateQueries({ queryKey: ['textile'] });
      return r.data;
    } catch (e) {
      toast(extractErrorMessage(e), 'error', 6000);
      return null;
    } finally {
      setBusy(false);
    }
  }
  return { busy, run, post: <T = Row,>(u: string, b: unknown, m?: string) => run<T>(() => apiClient.post<T>(u, b), m), put: <T = Row,>(u: string, b: unknown, m?: string) => run<T>(() => apiClient.put<T>(u, b), m) };
}

export function PageHeader({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="page-hdr">
      <div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

export function TextileNav() {
  const links: Array<[string, string]> = [
    ['/textile', 'لوحة المؤشرات'], ['/textile/setup', 'المراحل والهوالك'], ['/textile/machines', 'الماكينات'], ['/textile/rolls', 'فحص الرولات'],
    ['/textile/quality', 'الجودة'], ['/textile/maintenance', 'الصيانة'], ['/textile/reports', 'التقارير'], ['/textile/tools', 'الحاسبات'],
    ['/textile/fibers', 'الألياف والخلط'], ['/textile/weaving', 'السدى والتعبئة'], ['/textile/dyeing', 'الصباغة'], ['/textile/toll', 'التشغيل للغير'],
    ['/textile/production-reports', 'تقارير الإنتاج'], ['/textile/cost-rates', 'معدّلات التحويل'],
    ['/textile/schedule', 'الجدولة'], ['/textile/sales-tracking', 'متابعة البيع'], ['/textile/defects', 'العيوب'], ['/textile/specs', 'المواصفات'], ['/textile/delivery', 'إذن التسليم'], ['/textile/utilities', 'المرافق'], ['/textile/blend', 'نسب الخيوط'], ['/textile/trace', 'التتبّع'], ['/textile/claims', 'المطالبات'], ['/textile/fabric-stock', 'مخزون الأقمشة'], ['/textile/cost-card', 'بطاقة التكلفة'], ['/textile/profitability', 'الربحية'], ['/textile/lot-issue', 'صرف باللوط'], ['/textile/sales-payment', 'نوع الدفع'], ['/textile/lots', 'اللوتات'], ['/textile/price-deviation', 'انحراف الأسعار'], ['/textile/critical', 'الحرجة'], ['/textile/currencies', 'العملات'], ['/textile/simulator', 'محاكي الاختناق'], ['/textile/attendance', 'الحضور والأجور'], ['/textile/payroll', 'الرواتب'], ['/textile/workforce', 'العمالة والحوافز'], ['/textile/subcontract', 'التصنيع لدى الغير'], ['/textile/labels', 'الملصقات'],
  ];
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      {links.map(([to, label]) => <Link key={to} to={to} className="btn btn-sm btn-outline">{label}</Link>)}
    </div>
  );
}

export function Card({ title, badge, children }: { title?: string; badge?: string; children: ReactNode }) {
  return (
    <section className="card">
      {title && <div className="card-hdr"><span className="card-title">{title}</span>{badge && <span className="card-badge">{badge}</span>}</div>}
      {children}
    </section>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block text-sm"><span className="mb-1 block text-xs text-slate-500">{label}</span>{children}</label>;
}

export function Kpi({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'good' | 'bad' }) {
  const color = tone === 'bad' ? 'text-red-700' : tone === 'good' ? 'text-emerald-700' : 'text-slate-900';
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-extrabold ${color}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

export function DataTable({ cols, rows, empty = 'لا توجد بيانات.' }: { cols: Array<{ h: string; k?: string; r?: (row: Row) => ReactNode }>; rows: Row[] | undefined; empty?: string }) {
  if (!rows) return <p className="text-sm text-slate-500">جارٍ التحميل…</p>;
  if (rows.length === 0) return <p className="text-sm text-slate-500">{empty}</p>;
  return (
    <div className="tbl-wrap">
      <table className="w-full text-start text-sm">
        <thead><tr>{cols.map((c) => <th key={c.h} className="px-3 py-2 text-start font-medium">{c.h}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.id ?? row.code ?? i}>{cols.map((c) => <td key={c.h} className="px-3 py-1.5">{c.r ? c.r(row) : String(row[c.k ?? ''] ?? '—')}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** تنسيق رقم عشري من الخادم (نص) لعرض مختصر. */
export const num = (v: unknown, d = 2) => (v === null || v === undefined || v === '' ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d }));
export const today = () => new Date().toISOString().slice(0, 10);

export function DateRange({ from, to, setFrom, setTo }: { from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void }) {
  return (
    <div className="mb-3 flex flex-wrap items-end gap-3">
      <Field label="من"><input type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
      <Field label="إلى"><input type="date" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} /></Field>
    </div>
  );
}

export const STAGE_LABELS: Record<string, string> = {
  blowroom: 'فتح وتنظيف', carding: 'كرد', combing: 'مشط', drawing: 'سحب', roving: 'فتيل', ring_spinning: 'غزل رينج', open_end: 'أوبن إند', winding: 'تدوير',
  warping: 'تسدية', sizing: 'نشا', weaving: 'نسيج', knitting: 'تريكو', dyeing: 'صباغة', printing: 'طباعة', finishing: 'تجهيز', inspection: 'فحص', packing: 'تعبئة', other: 'أخرى',
};

import { Link } from 'react-router-dom';
import { useBrand } from '@/brand/BrandProvider';
import { useSafes } from '@/features/catalog/api';
import { useTrialBalance, useSalesSummary, usePurchaseSummary } from '@/features/reports/api';
import { useTreasuryTransactions, useChecks } from '@/features/treasury/api';
import { useSalesInvoices } from '@/features/salesInvoices/api';
import { usePurchaseInvoices } from '@/features/purchaseInvoices/api';

function firstDayOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
function daysFromNow(n: number) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export default function DashboardPage() {
  const asOf = today();
  const monthStart = firstDayOfMonth();
  const upcomingDue = daysFromNow(7);

  const { data: safes } = useSafes();
  const { data: trialBalance } = useTrialBalance(asOf);
  const { data: salesSummary, isLoading: salesLoading } = useSalesSummary(monthStart, asOf, 'day');
  const { data: purchaseSummary, isLoading: purchaseLoading } = usePurchaseSummary(monthStart, asOf, 'day');
  const { data: treasuryTx } = useTreasuryTransactions(1, 1, { status: 'draft' });
  const { data: checks } = useChecks(1, 100);
  // pageSize=1: نحتاج فقط total الدقيق من الباك إند (فلتر الحالة هناك) لا صفوف الفواتير نفسها.
  const { data: draftSales } = useSalesInvoices(1, 1, { status: 'draft' });
  const { data: draftPurchases } = usePurchaseInvoices(1, 1, { status: 'draft' });

  const balanceByAccount = new Map((trialBalance?.accounts ?? []).map((a) => [a.id, Number(a.total_debit) - Number(a.total_credit)]));
  const treasuryTotal = (safes ?? []).reduce((sum, s) => sum + (balanceByAccount.get(s.linked_account_id) ?? 0), 0);

  const draftTreasuryVouchers = treasuryTx?.total ?? 0;
  const checksDueSoon = (checks?.data ?? []).filter((c) => (c.status === 'pending' || c.status === 'deposited') && c.due_date <= upcomingDue);
  const draftSalesInvoices = draftSales?.total ?? 0;
  const draftPurchaseInvoices = draftPurchases?.total ?? 0;

  const brand = useBrand();

  // ── عرض فقط: سلسلة أيام الشهر للرسم البياني (نفس بيانات تقريري المبيعات/المشتريات اليومية) ──
  const salesByDay = new Map<string, number>((salesSummary?.lines ?? []).map((l): [string, number] => [String(l.day ?? '').slice(0, 10), Number(l.total_sales)]));
  const purchasesByDay = new Map<string, number>((purchaseSummary?.lines ?? []).map((l): [string, number] => [String(l.day ?? '').slice(0, 10), Number(l.total_purchases)]));
  const days: string[] = Array.from(new Set<string>([...salesByDay.keys(), ...purchasesByDay.keys()])).filter(Boolean).sort();
  const maxValue = Math.max(1, ...days.map((d) => Math.max(salesByDay.get(d) ?? 0, purchasesByDay.get(d) ?? 0)));

  return (
    <div>
      <div className="page-hdr">
        <div>
          <h1>مرحبًا بك في {brand.appName}</h1>
          <p>ملخص أداء الشهر الحالي — {monthStart} إلى {asOf}</p>
        </div>
        <div className="flex gap-2">
          <Link to="/sales/invoices/new" className="btn btn-gold btn-sm">+ فاتورة بيع</Link>
          <Link to="/purchasing/invoices/new" className="btn btn-outline btn-sm">+ فاتورة شراء</Link>
        </div>
      </div>

      <div className="kpi-grid">
        <KpiCard icon="💹" title="مبيعات الشهر الحالي" value={salesLoading ? '...' : `${salesSummary?.grandTotal ?? '0.0000'}`} to="/reports/sales-summary" tone="good" />
        <KpiCard icon="🧺" title="مشتريات الشهر الحالي" value={purchaseLoading ? '...' : `${purchaseSummary?.grandTotal ?? '0.0000'}`} to="/reports/purchase-summary" tone="info" />
        <KpiCard icon="🏦" title="إجمالي أرصدة الخزائن والبنوك" value={treasuryTotal.toFixed(4)} to="/treasury/safes" />
        <KpiCard icon="🗓️" title="شيكات مستحقة خلال 7 أيام" value={String(checksDueSoon.length)} to="/treasury/checks" tone={checksDueSoon.length > 0 ? 'warn' : 'default'} />
      </div>

      <div className="kpi-grid cols-3">
        <KpiCard icon="📝" title="سندات قبض/صرف بحاجة ترحيل" value={String(draftTreasuryVouchers)} to="/treasury/transactions" tone={draftTreasuryVouchers > 0 ? 'warn' : 'default'} />
        <KpiCard icon="🧾" title="فواتير بيع بحاجة ترحيل" value={String(draftSalesInvoices)} to="/sales/invoices" tone={draftSalesInvoices > 0 ? 'warn' : 'default'} />
        <KpiCard icon="📦" title="فواتير شراء بحاجة ترحيل" value={String(draftPurchaseInvoices)} to="/purchasing/invoices" tone={draftPurchaseInvoices > 0 ? 'warn' : 'default'} />
      </div>

      <div className="card">
        <div className="card-hdr">
          <span className="card-title">المبيعات والمشتريات اليومية</span>
          <span className="flex items-center gap-3 text-[0.68rem] text-slate-500">
            <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm" style={{ background: 'var(--green)' }} />مبيعات</span>
            <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm" style={{ background: 'var(--gold)' }} />مشتريات</span>
          </span>
        </div>
        {days.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-400">لا توجد حركة مرحَّلة هذا الشهر بعد.</p>
        ) : (
          <div className="chart-bars">
            {days.map((d) => {
              const s = salesByDay.get(d) ?? 0;
              const p = purchasesByDay.get(d) ?? 0;
              return (
                <div key={d} className="cb-wrap">
                  <div className="cb-pair">
                    <div className="cb cb-green" style={{ height: `${(s / maxValue) * 100}%` }} title={`مبيعات ${d}: ${s.toFixed(2)}`} />
                    <div className="cb cb-gold" style={{ height: `${(p / maxValue) * 100}%` }} title={`مشتريات ${d}: ${p.toFixed(2)}`} />
                  </div>
                  <span className="cb-lbl">{d.slice(8)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {checksDueSoon.length > 0 && (
        <div className="card">
          <div className="card-hdr"><span className="card-title">شيكات مستحقة قريبًا</span><span className="card-badge">{checksDueSoon.length}</span></div>
          <div className="tbl-wrap">
            <table className="etbl">
              <thead>
                <tr>
                  <th>رقم الشيك</th>
                  <th>النوع</th>
                  <th>تاريخ الاستحقاق</th>
                  <th>المبلغ</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {checksDueSoon.map((c) => (
                  <tr key={c.id}>
                    <td className="font-semibold text-slate-900">{c.check_number}</td>
                    <td>{c.check_type === 'incoming' ? 'وارد' : 'صادر'}</td>
                    <td>{c.due_date}</td>
                    <td>{c.amount} {c.currency_code}</td>
                    <td className="text-end">
                      <Link to={`/treasury/checks/${c.id}`} className="text-sm font-medium text-slate-700 hover:underline">عرض</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

type KpiTone = 'default' | 'warn' | 'good' | 'info';

function KpiCard({ icon, title, value, to, tone = 'default' }: { icon: string; title: string; value: string; to: string; tone?: KpiTone }) {
  return (
    <Link to={to} className={`kpi ${tone === 'default' ? '' : tone}`}>
      <span className="kpi-icon">{icon}</span>
      <p className="kpi-lbl">{title}</p>
      <p className="kpi-val">{value}</p>
    </Link>
  );
}

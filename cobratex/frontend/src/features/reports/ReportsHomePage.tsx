import { Link } from 'react-router-dom';

const reports = [
  { to: '/reports/trial-balance', title: 'ميزان المراجعة', desc: 'إجمالي مدين/دائن لكل حساب من القيود المرحَّلة، حتى تاريخ معيّن.' },
  { to: '/reports/inventory-valuation', title: 'تقييم المخزون', desc: 'الكمية والقيمة الحالية لكل صنف/مخزن بمتوسط التكلفة المرجَّح.' },
  { to: '/reports/sales-summary', title: 'ملخَّص المبيعات', desc: 'إجمالي المبيعات لفترة، مُجمَّعًا حسب الصنف أو العميل أو اليوم.' },
  { to: '/reports/purchase-summary', title: 'ملخَّص المشتريات', desc: 'إجمالي المشتريات لفترة، مُجمَّعًا حسب الصنف أو المورد أو اليوم.' },
  { to: '/reports/financial', title: 'التقارير المالية', desc: 'أعمار المدينين والدائنين، قائمة الدخل، المركز المالي، واقتراحات إعادة الطلب.' },
];

export default function ReportsHomePage() {
  return (
    <div>
      <h1 className="mb-6 text-xl font-bold text-slate-900">التقارير</h1>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {reports.map((r) => (
          <Link key={r.to} to={r.to} className="block rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200 transition hover:ring-slate-400">
            <h2 className="mb-2 font-semibold text-slate-900">{r.title}</h2>
            <p className="text-sm text-slate-500">{r.desc}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}

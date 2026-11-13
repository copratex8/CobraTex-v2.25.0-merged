import { Link } from 'react-router-dom';

const sections = [
  { to: '/treasury/safes', title: 'الخزائن والبنوك', desc: 'الخزائن النقدية والحسابات البنكية، وإنشاء خزينة/بنك جديد.' },
  { to: '/treasury/transactions', title: 'سندات القبض والصرف', desc: 'تحصيل أو صرف مبلغ من/إلى عميل أو مورد أو طرف آخر، وترحيله.' },
  { to: '/treasury/transfers', title: 'التحويلات', desc: 'تحويل مبلغ بين خزينتين أو حسابين بنكيين.' },
  { to: '/treasury/checks', title: 'الشيكات', desc: 'تسجيل شيكات واردة وصادرة ومتابعة دورة حياتها حتى التحصيل أو الصرف.' },
  { to: '/treasury/reconciliations', title: 'التسوية البنكية', desc: 'مطابقة كشف الحساب البنكي مع سندات وتحويلات النظام المرحَّلة.' },
];

export default function TreasuryHomePage() {
  return (
    <div>
      <h1 className="mb-6 text-xl font-bold text-slate-900">الخزينة</h1>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {sections.map((s) => (
          <Link key={s.to} to={s.to} className="block rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200 transition hover:ring-slate-400">
            <h2 className="mb-2 font-semibold text-slate-900">{s.title}</h2>
            <p className="text-sm text-slate-500">{s.desc}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}

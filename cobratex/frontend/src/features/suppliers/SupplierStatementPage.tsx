import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useSupplierStatement } from '@/features/suppliers/api';

export default function SupplierStatementPage() {
  const { id } = useParams<{ id: string }>();
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const { data, isLoading, isError } = useSupplierStatement(id ?? null, fromDate || undefined, toDate || undefined);

  return (
    <div>
      <div className="mb-4">
        <Link to="/suppliers" className="text-sm text-slate-500 hover:underline">
          → العودة لقائمة الموردين
        </Link>
      </div>
      <h1 className="mb-6 text-xl font-bold text-slate-900">كشف حساب المورد</h1>

      <div className="mb-4 flex gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">من تاريخ</span>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">إلى تاريخ</span>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2" />
        </label>
      </div>

      <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        {isLoading && <p className="p-6 text-sm text-slate-500">جارٍ التحميل...</p>}
        {isError && <p className="p-6 text-sm text-red-600">تعذَّر تحميل كشف الحساب.</p>}

        {data && (
          <>
            <table className="w-full text-start text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">التاريخ</th>
                  <th className="px-4 py-3 font-medium">البيان</th>
                  <th className="px-4 py-3 font-medium">مدين</th>
                  <th className="px-4 py-3 font-medium">دائن</th>
                  <th className="px-4 py-3 font-medium">الرصيد</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((line) => (
                  <tr key={line.journal_entry_id + line.entry_date} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3 text-slate-600">{line.entry_date}</td>
                    <td className="px-4 py-3 text-slate-600">{line.description ?? line.source_document_type}</td>
                    <td className="px-4 py-3 text-slate-900">{Number(line.debit) > 0 ? line.debit : '—'}</td>
                    <td className="px-4 py-3 text-slate-900">{Number(line.credit) > 0 ? line.credit : '—'}</td>
                    <td className="px-4 py-3 font-medium text-slate-900">{line.running_balance}</td>
                  </tr>
                ))}
                {data.lines.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                      لا حركة على هذا الحساب في الفترة المحدَّدة
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <div className="border-t border-slate-200 px-4 py-3 text-end text-sm font-semibold text-slate-900">
              الرصيد الختامي: {data.closingBalance}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

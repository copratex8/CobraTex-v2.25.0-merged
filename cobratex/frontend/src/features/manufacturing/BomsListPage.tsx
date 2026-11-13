import { Link } from 'react-router-dom';
import { useBoms } from '@/features/manufacturing/api';
import { useItems } from '@/features/catalog/api';

export default function BomsListPage() {
  const { data: boms, isLoading, isError } = useBoms();
  const { data: items } = useItems();
  const itemName = (id: string) => items?.find((i) => i.id === id)?.name_ar ?? id;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">قوائم المواد (BOM)</h1>
        <Link to="/manufacturing/boms/new" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
          + قائمة مواد جديدة
        </Link>
      </div>

      <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        {isLoading && <p className="p-6 text-sm text-slate-500">جارٍ التحميل...</p>}
        {isError && <p className="p-6 text-sm text-red-600">تعذَّر تحميل قوائم المواد.</p>}
        {boms && (
          <table className="w-full text-start text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">الكود</th>
                <th className="px-4 py-3 font-medium">الاسم</th>
                <th className="px-4 py-3 font-medium">الصنف المُنتَج</th>
                <th className="px-4 py-3 font-medium">كمية الوصفة</th>
                <th className="px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {boms.map((b) => (
                <tr key={b.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3 text-slate-600">{b.code}</td>
                  <td className="px-4 py-3 font-medium text-slate-900">{b.name_ar}</td>
                  <td className="px-4 py-3 text-slate-600">{itemName(b.output_item_id)}</td>
                  <td className="px-4 py-3 text-slate-600">{b.output_quantity}</td>
                  <td className="px-4 py-3 text-end">
                    <Link to={`/manufacturing/boms/${b.id}`} className="text-sm font-medium text-slate-700 hover:underline">عرض</Link>
                  </td>
                </tr>
              ))}
              {boms.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">لا توجد قوائم مواد بعد</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

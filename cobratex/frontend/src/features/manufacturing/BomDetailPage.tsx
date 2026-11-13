import { useParams, Link } from 'react-router-dom';
import { useBom } from '@/features/manufacturing/api';
import { useItems } from '@/features/catalog/api';

const costTypeLabels: Record<string, string> = { labor: 'عمالة', overhead: 'مصاريف تشغيل', other: 'أخرى' };

export default function BomDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: bom, isLoading, isError } = useBom(id ?? null);
  const { data: items } = useItems();
  const itemName = (itemId: string) => items?.find((i) => i.id === itemId)?.name_ar ?? itemId;

  if (isLoading) return <p className="text-sm text-slate-500">جارٍ التحميل...</p>;
  if (isError || !bom) return <p className="text-sm text-red-600">تعذَّر تحميل قائمة المواد.</p>;

  return (
    <div>
      <div className="mb-4">
        <Link to="/manufacturing/boms" className="text-sm text-slate-500 hover:underline">→ العودة لقوائم المواد</Link>
      </div>

      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">{bom.name_ar} ({bom.code})</h1>
          <p className="text-sm text-slate-500">الصنف المُنتَج: {itemName(bom.output_item_id)} — كمية الوصفة: {bom.output_quantity}</p>
        </div>
        <Link
          to={`/manufacturing/orders/new?bomId=${bom.id}`}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          + أمر تصنيع من هذه الوصفة
        </Link>
      </div>

      <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        <table className="w-full text-start text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">المكوِّن</th>
              <th className="px-4 py-2 font-medium">الكمية اللازمة</th>
              <th className="px-4 py-2 font-medium">هالك %</th>
            </tr>
          </thead>
          <tbody>
            {bom.lines?.map((line) => (
              <tr key={line.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-3">{itemName(line.component_item_id)}</td>
                <td className="px-4 py-3 text-slate-600">{line.quantity}</td>
                <td className="px-4 py-3 text-slate-500">{Number(line.waste_percent) > 0 ? `${line.waste_percent}%` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {bom.operations && bom.operations.length > 0 && (
        <div className="mt-6 overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
          <h2 className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-900">مراحل التصنيع وتكلفة التحويل</h2>
          <table className="w-full text-start text-sm">
            <thead className="border-b border-slate-200 text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">#</th>
                <th className="px-4 py-2 font-medium">المرحلة</th>
                <th className="px-4 py-2 font-medium">النوع</th>
                <th className="px-4 py-2 font-medium">التكلفة (لكمية الوصفة)</th>
              </tr>
            </thead>
            <tbody>
              {bom.operations.map((o, i) => (
                <tr key={o.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3 text-slate-400">{i + 1}</td>
                  <td className="px-4 py-3">{o.name}</td>
                  <td className="px-4 py-3 text-slate-600">{costTypeLabels[o.cost_type]}</td>
                  <td className="px-4 py-3 text-slate-600">{o.cost_amount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';
import { useItemsPage, useUpdateItemStatus, useUoms } from '@/features/catalog/api';
import PaginationControls from '@/components/PaginationControls';
import ItemCreateModal from '@/features/catalog/ItemCreateModal';
import Modal from '@/components/Modal';
import AttachmentsPanel from '@/features/attachments/AttachmentsPanel';

const kindLabels: Record<string, string> = {
  raw_material: 'مادة خام', fabric: 'قماش', thread: 'خيط', finished_good: 'منتج تام', generic: 'عام',
};

export default function ItemsListPage() {
  const [page, setPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);
  const [attachmentsFor, setAttachmentsFor] = useState<{ id: string; name: string } | null>(null);
  const { data, isLoading, isError } = useItemsPage(page);
  const { data: uoms } = useUoms();
  const updateStatus = useUpdateItemStatus();

  const uomLabel = (uomId: string) => uoms?.find((u) => u.id === uomId)?.name_ar ?? '—';

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">الأصناف</h1>
        <button onClick={() => setShowCreate(true)} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
          + صنف جديد
        </button>
      </div>

      <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        {isLoading && <p className="p-6 text-sm text-slate-500">جارٍ التحميل...</p>}
        {isError && <p className="p-6 text-sm text-red-600">تعذَّر تحميل قائمة الأصناف.</p>}
        {data && (
          <>
            <table className="w-full text-start text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">الكود</th>
                  <th className="px-4 py-3 font-medium">الاسم</th>
                  <th className="px-4 py-3 font-medium">النوع</th>
                  <th className="px-4 py-3 font-medium">وحدة القياس</th>
                  <th className="px-4 py-3 font-medium">الحالة</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((item) => (
                  <tr key={item.id} className={`border-b border-slate-100 last:border-0 ${item.is_active ? '' : 'opacity-50'}`}>
                    <td className="px-4 py-3 text-slate-600">{item.code}</td>
                    <td className="px-4 py-3 font-medium text-slate-900">{item.name_ar}</td>
                    <td className="px-4 py-3 text-slate-600">{kindLabels[item.item_kind]}</td>
                    <td className="px-4 py-3 text-slate-600">{uomLabel(item.base_uom_id)}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${item.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
                        {item.is_active ? 'نشط' : 'معطَّل'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-end">
                      <div className="flex items-center justify-end gap-3">
                        <button
                          onClick={() => setAttachmentsFor({ id: item.id, name: item.name_ar })}
                          className="text-sm font-medium text-slate-700 hover:underline"
                        >
                          المرفقات
                        </button>
                        <button
                          onClick={() => updateStatus.mutate({ id: item.id, isActive: !item.is_active })}
                          disabled={updateStatus.isPending}
                          className="text-sm font-medium text-slate-700 hover:underline disabled:opacity-50"
                        >
                          {item.is_active ? 'تعطيل' : 'تفعيل'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {data.data.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">لا توجد أصناف بعد</td></tr>
                )}
              </tbody>
            </table>
            <PaginationControls page={data.page} pageSize={data.pageSize} total={data.total} totalPages={data.totalPages} onPageChange={setPage} />
          </>
        )}
      </div>

      {showCreate && <ItemCreateModal onClose={() => setShowCreate(false)} />}

      {attachmentsFor && (
        <Modal title={`مرفقات: ${attachmentsFor.name}`} onClose={() => setAttachmentsFor(null)}>
          <AttachmentsPanel entityType="item" entityId={attachmentsFor.id} />
        </Modal>
      )}
    </div>
  );
}

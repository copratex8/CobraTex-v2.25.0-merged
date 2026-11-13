import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useCustomers, useUpdateCustomerStatus } from '@/features/customers/api';
import PaginationControls from '@/components/PaginationControls';
import CustomerCreateModal from '@/features/customers/CustomerCreateModal';

export default function CustomersListPage() {
  const [page, setPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);
  const { data, isLoading, isError } = useCustomers(page);
  const updateStatus = useUpdateCustomerStatus();

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">العملاء</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          + عميل جديد
        </button>
      </div>

      <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        {isLoading && <p className="p-6 text-sm text-slate-500">جارٍ التحميل...</p>}
        {isError && <p className="p-6 text-sm text-red-600">تعذَّر تحميل قائمة العملاء.</p>}

        {data && (
          <>
            <table className="w-full text-start text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">الكود</th>
                  <th className="px-4 py-3 font-medium">الاسم</th>
                  <th className="px-4 py-3 font-medium">العملة</th>
                  <th className="px-4 py-3 font-medium">حد الائتمان</th>
                  <th className="px-4 py-3 font-medium">الحالة</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((customer) => (
                  <tr key={customer.id} className={`border-b border-slate-100 last:border-0 ${customer.is_active ? '' : 'opacity-50'}`}>
                    <td className="px-4 py-3 text-slate-600">{customer.code}</td>
                    <td className="px-4 py-3 font-medium text-slate-900">{customer.name_ar}</td>
                    <td className="px-4 py-3 text-slate-600">{customer.currency_code}</td>
                    <td className="px-4 py-3 text-slate-600">{customer.credit_limit}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${customer.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
                        {customer.is_active ? 'نشط' : 'معطَّل'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-end">
                      <div className="flex items-center justify-end gap-3">
                        <button
                          onClick={() => updateStatus.mutate({ id: customer.id, isActive: !customer.is_active })}
                          disabled={updateStatus.isPending}
                          className="text-sm font-medium text-slate-700 hover:underline disabled:opacity-50"
                        >
                          {customer.is_active ? 'تعطيل' : 'تفعيل'}
                        </button>
                        <Link to={`/customers/${customer.id}/statement`} className="text-sm font-medium text-slate-700 hover:underline">
                          كشف الحساب
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
                {data.data.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                      لا يوجد عملاء بعد
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <PaginationControls page={data.page} pageSize={data.pageSize} total={data.total} totalPages={data.totalPages} onPageChange={setPage} />
          </>
        )}
      </div>

      {showCreate && <CustomerCreateModal onClose={() => setShowCreate(false)} />}
    </div>
  );
}

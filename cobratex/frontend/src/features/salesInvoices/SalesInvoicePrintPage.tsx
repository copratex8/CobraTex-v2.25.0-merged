import { useParams, Link } from 'react-router-dom';
import { useSalesInvoice } from '@/features/salesInvoices/api';
import { useCustomers } from '@/features/customers/api';
import { useCompany, useBranches, useItems } from '@/features/catalog/api';

const statusLabels: Record<string, string> = { draft: 'مسودة', posted: 'مرحَّلة', cancelled: 'ملغاة', reversed: 'معكوسة' };

/**
 * صفحة طباعة/PDF مستقلة (بلا AppLayout — لا قائمة جانبية ولا ترويسة تطبيق) تعتمد على طباعة
 * المتصفح ("حفظ كـPDF") بدل توليد PDF من الباك إند: هذا يمنح دعمًا صحيحًا 100% للعربية/RTL من
 * محرك عرض المتصفح نفسه، بلا أي تبعية ثقيلة (لا Puppeteer/Chromium يستهلك ذاكرة على خطة استضافة
 * مجانية، ولا مكتبات تشكيل نص عربي هشة مثل pdfkit+arabic-reshaper). القرار موثَّق كمعماري مقصود.
 */
export default function SalesInvoicePrintPage() {
  const { id } = useParams<{ id: string }>();
  const { data: invoice, isLoading, isError } = useSalesInvoice(id ?? null);
  const { data: company } = useCompany();
  const { data: branches } = useBranches();
  const { data: customersPage } = useCustomers(1, 100);
  const { data: items } = useItems();

  if (isLoading) return <p className="p-6 text-sm text-slate-500">جارٍ التحميل...</p>;
  if (isError || !invoice) return <p className="p-6 text-sm text-red-600">تعذَّر تحميل الفاتورة.</p>;

  const branch = branches?.find((b) => b.id === invoice.branch_id);
  const customer = customersPage?.data.find((c) => c.id === invoice.customer_id);
  const itemName = (itemId: string) => items?.find((i) => i.id === itemId)?.name_ar ?? itemId;

  const totals = (invoice.lines ?? []).reduce(
    (acc, l) => ({
      subtotal: acc.subtotal + Number(l.subtotal),
      tax: acc.tax + Number(l.tax_amount),
      total: acc.total + Number(l.line_total),
    }),
    { subtotal: 0, tax: 0, total: 0 },
  );

  return (
    <div className="mx-auto max-w-3xl bg-white p-8 text-slate-900 print:p-0">
      <div className="mb-6 flex items-center justify-between gap-4 print:hidden">
        <Link to={`/sales/invoices/${invoice.id}`} className="text-sm text-slate-500 hover:underline">→ العودة لتفاصيل الفاتورة</Link>
        <button onClick={() => window.print()} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
          طباعة / حفظ كـPDF
        </button>
      </div>

      <div className="mb-8 flex items-start justify-between border-b border-slate-300 pb-6">
        <div>
          <h1 className="text-lg font-bold text-slate-900">{company?.display_name ?? '—'}</h1>
          {branch && <p className="text-sm text-slate-500">{branch.name_ar}{branch.address ? ` — ${branch.address}` : ''}</p>}
        </div>
        <div className="text-end">
          <h2 className="text-xl font-bold text-slate-900">فاتورة مبيعات</h2>
          <p className="text-sm text-slate-600">رقم: {invoice.document_number}</p>
          <p className="text-sm text-slate-600">التاريخ: {invoice.invoice_date}</p>
          <p className="text-sm text-slate-600">الحالة: {statusLabels[invoice.status]}</p>
        </div>
      </div>

      <div className="mb-6">
        <p className="text-xs font-medium text-slate-500">العميل</p>
        <p className="font-semibold text-slate-900">{customer?.name_ar ?? '—'}</p>
        {customer?.tax_number && <p className="text-sm text-slate-500">الرقم الضريبي: {customer.tax_number}</p>}
      </div>

      <table className="w-full border-collapse text-start text-sm">
        <thead>
          <tr className="border-y border-slate-300 bg-slate-50 print:bg-transparent">
            <th className="px-2 py-2 font-medium">الصنف</th>
            <th className="px-2 py-2 font-medium">الكمية</th>
            <th className="px-2 py-2 font-medium">سعر الوحدة</th>
            <th className="px-2 py-2 font-medium">الخصم %</th>
            <th className="px-2 py-2 font-medium">الصافي</th>
            <th className="px-2 py-2 font-medium">الضريبة</th>
            <th className="px-2 py-2 font-medium">الإجمالي</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines?.map((line) => (
            <tr key={line.id} className="border-b border-slate-200">
              <td className="px-2 py-2">{itemName(line.item_id)}</td>
              <td className="px-2 py-2">{line.quantity}</td>
              <td className="px-2 py-2">{line.unit_price}</td>
              <td className="px-2 py-2">{line.discount_percent}</td>
              <td className="px-2 py-2">{line.subtotal}</td>
              <td className="px-2 py-2">{line.tax_amount}</td>
              <td className="px-2 py-2 font-medium">{line.line_total}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-6 flex justify-end">
        <div className="w-64 space-y-1 text-sm">
          <div className="flex justify-between"><span className="text-slate-500">الصافي</span><span>{totals.subtotal.toFixed(4)}</span></div>
          <div className="flex justify-between"><span className="text-slate-500">الضريبة</span><span>{totals.tax.toFixed(4)}</span></div>
          <div className="flex justify-between border-t border-slate-300 pt-1 text-base font-bold">
            <span>الإجمالي ({invoice.currency_code})</span><span>{totals.total.toFixed(4)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

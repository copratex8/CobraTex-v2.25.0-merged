import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse, SalesInvoice } from '@/api/types';

/** الفلترة (الحالة/العميل) تتم في الباك إند لا محليًا: التصفية المحلية على أول 100 فاتورة كانت تُسقِط
 * أي فاتورة مرحَّلة تتجاوز هذا الحد وتُعطي عدّادات خاطئة، بينما total من الباك إند دقيق دائمًا. */
export function useSalesInvoices(page: number, pageSize = 20, filters: { status?: string; customerId?: string } = {}) {
  return useQuery({
    queryKey: ['sales-invoices', page, pageSize, filters.status ?? null, filters.customerId ?? null],
    queryFn: async () => (await apiClient.get<PaginatedResponse<SalesInvoice>>('/sales/invoices', {
      params: { page, pageSize, status: filters.status || undefined, customerId: filters.customerId || undefined },
    })).data,
  });
}

export function useSalesInvoice(id: string | null) {
  return useQuery({
    queryKey: ['sales-invoice', id],
    queryFn: async () => (await apiClient.get<SalesInvoice>(`/sales/invoices/${id}`)).data,
    enabled: !!id,
  });
}

export interface SalesInvoiceLineInput {
  itemId: string;
  uomId: string;
  quantity: string;
  unitPrice: string;
  discountPercent?: string;
}

export interface CreateSalesInvoiceInput {
  branchId: string;
  warehouseId: string;
  customerId: string;
  fiscalPeriodId: string;
  currencyCode: string;
  /** فارغ = يُجلب من جدول أسعار الصرف (سعر البيع) للعملة الأجنبية. */
  exchangeRate?: string;
  paymentType?: 'cash' | 'credit' | 'cheque' | 'transfer';
  invoiceDate: string;
  lines: SalesInvoiceLineInput[];
}

function invalidateInvoices(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['sales-invoices'] });
}

export function useCreateSalesInvoice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateSalesInvoiceInput) => (await apiClient.post<SalesInvoice>('/sales/invoices', input)).data,
    onSuccess: () => invalidateInvoices(queryClient),
  });
}

export function usePostSalesInvoice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await apiClient.post(`/sales/invoices/${id}/post`)).data,
    onSuccess: (_data, id) => {
      invalidateInvoices(queryClient);
      queryClient.invalidateQueries({ queryKey: ['sales-invoice', id] });
    },
  });
}

export function useCancelSalesInvoice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => (await apiClient.post(`/sales/invoices/${id}/cancel`, { reason })).data,
    onSuccess: (_data, { id }) => {
      invalidateInvoices(queryClient);
      queryClient.invalidateQueries({ queryKey: ['sales-invoice', id] });
    },
  });
}

export function useReverseSalesInvoice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => (await apiClient.post(`/sales/invoices/${id}/reverse`, { reason })).data,
    onSuccess: (_data, { id }) => {
      invalidateInvoices(queryClient);
      queryClient.invalidateQueries({ queryKey: ['sales-invoice', id] });
    },
  });
}

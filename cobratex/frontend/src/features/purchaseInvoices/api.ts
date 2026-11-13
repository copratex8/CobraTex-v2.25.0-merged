import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse, PurchaseInvoice } from '@/api/types';

/** راجع تعليق useSalesInvoices — نفس المبدأ (فلترة بالحالة/المورد في الباك إند). */
export function usePurchaseInvoices(page: number, pageSize = 20, filters: { status?: string; supplierId?: string } = {}) {
  return useQuery({
    queryKey: ['purchase-invoices', page, pageSize, filters.status ?? null, filters.supplierId ?? null],
    queryFn: async () => (await apiClient.get<PaginatedResponse<PurchaseInvoice>>('/purchasing/invoices', {
      params: { page, pageSize, status: filters.status || undefined, supplierId: filters.supplierId || undefined },
    })).data,
  });
}

export function usePurchaseInvoice(id: string | null) {
  return useQuery({
    queryKey: ['purchase-invoice', id],
    queryFn: async () => (await apiClient.get<PurchaseInvoice>(`/purchasing/invoices/${id}`)).data,
    enabled: !!id,
  });
}

export interface PurchaseInvoiceLineInput {
  goodsReceiptLineId: string;
  quantity: string;
  unitCost: string;
  taxTypeId?: string;
}

export interface CreatePurchaseInvoiceInput {
  branchId: string;
  supplierId: string;
  fiscalPeriodId: string;
  currencyCode: string;
  exchangeRate?: string;
  invoiceDate: string;
  lines: PurchaseInvoiceLineInput[];
}

function invalidate(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['purchase-invoices'] });
}

export function useCreatePurchaseInvoice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreatePurchaseInvoiceInput) => (await apiClient.post<PurchaseInvoice>('/purchasing/invoices', input)).data,
    onSuccess: () => invalidate(queryClient),
  });
}

export function usePostPurchaseInvoice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await apiClient.post(`/purchasing/invoices/${id}/post`)).data,
    onSuccess: (_d, id) => {
      invalidate(queryClient);
      queryClient.invalidateQueries({ queryKey: ['purchase-invoice', id] });
    },
  });
}

export function useReversePurchaseInvoice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => (await apiClient.post(`/purchasing/invoices/${id}/reverse`, { reason })).data,
    onSuccess: (_d, { id }) => {
      invalidate(queryClient);
      queryClient.invalidateQueries({ queryKey: ['purchase-invoice', id] });
    },
  });
}

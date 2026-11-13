import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse, RemainingBalance, SupplierPayment } from '@/api/types';

export function useSupplierPayments(page: number, pageSize = 20) {
  return useQuery({
    queryKey: ['supplier-payments', page, pageSize],
    queryFn: async () => (await apiClient.get<PaginatedResponse<SupplierPayment>>('/purchasing/payments', { params: { page, pageSize } })).data,
  });
}

export function useSupplierPayment(id: string | null) {
  return useQuery({
    queryKey: ['supplier-payment', id],
    queryFn: async () => (await apiClient.get<SupplierPayment>(`/purchasing/payments/${id}`)).data,
    enabled: !!id,
  });
}

/** مرآة تامة لـ useCustomerOpenInvoices (راجع تعليقها في customerPayments/api.ts). */
export function useSupplierOpenInvoices(supplierId: string | null) {
  return useQuery({
    queryKey: ['supplier-open-invoices', supplierId],
    queryFn: async () => {
      const list = await apiClient.get('/purchasing/invoices', { params: { page: 1, pageSize: 100, status: 'posted' } });
      const forSupplier = list.data.data.filter((inv: { supplier_id: string }) => inv.supplier_id === supplierId);
      const withBalances = await Promise.all(
        forSupplier.map(async (inv: { id: string; document_number: string; invoice_date: string }) => {
          const balance = await apiClient.get<RemainingBalance>(`/purchasing/invoices/${inv.id}/remaining-balance`);
          return { ...inv, ...balance.data };
        }),
      );
      return withBalances.filter((inv) => Number(inv.remaining) > 0);
    },
    enabled: !!supplierId,
  });
}

export interface CreateSupplierPaymentInput {
  branchId: string;
  supplierId: string;
  fiscalPeriodId: string;
  currencyCode: string;
  exchangeRate?: string;
  paymentDate: string;
  amount: string;
  paymentAccountId: string;
}

function invalidate(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['supplier-payments'] });
}

export function useCreateSupplierPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateSupplierPaymentInput) => (await apiClient.post<SupplierPayment>('/purchasing/payments', input)).data,
    onSuccess: () => invalidate(queryClient),
  });
}

export function usePostSupplierPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await apiClient.post(`/purchasing/payments/${id}/post`)).data,
    onSuccess: (_d, id) => { invalidate(queryClient); queryClient.invalidateQueries({ queryKey: ['supplier-payment', id] }); },
  });
}

export function useReverseSupplierPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => (await apiClient.post(`/purchasing/payments/${id}/reverse`, { reason })).data,
    onSuccess: (_d, { id }) => { invalidate(queryClient); queryClient.invalidateQueries({ queryKey: ['supplier-payment', id] }); },
  });
}

export function useAllocateSupplierPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, allocations }: { id: string; allocations: { supplierInvoiceId: string; amount: string }[] }) =>
      (await apiClient.post(`/purchasing/payments/${id}/allocate`, { allocations })).data,
    onSuccess: (_d, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['supplier-payment', id] });
      queryClient.invalidateQueries({ queryKey: ['supplier-open-invoices'] });
    },
  });
}

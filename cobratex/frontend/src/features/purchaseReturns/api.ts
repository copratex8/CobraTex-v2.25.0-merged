import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse, PurchaseReturn } from '@/api/types';

export function usePurchaseReturns(page: number, pageSize = 20) {
  return useQuery({
    queryKey: ['purchase-returns', page, pageSize],
    queryFn: async () => (await apiClient.get<PaginatedResponse<PurchaseReturn>>('/purchasing/returns', { params: { page, pageSize } })).data,
  });
}

export function usePurchaseReturn(id: string | null) {
  return useQuery({
    queryKey: ['purchase-return', id],
    queryFn: async () => (await apiClient.get<PurchaseReturn>(`/purchasing/returns/${id}`)).data,
    enabled: !!id,
  });
}

export interface PurchaseReturnLineInput {
  supplierInvoiceLineId: string;
  quantity: string;
}

export interface CreatePurchaseReturnInput {
  branchId: string;
  warehouseId: string;
  supplierInvoiceId: string;
  fiscalPeriodId: string;
  returnDate: string;
  lines: PurchaseReturnLineInput[];
}

function invalidate(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['purchase-returns'] });
}

export function useCreatePurchaseReturn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreatePurchaseReturnInput) => (await apiClient.post<PurchaseReturn>('/purchasing/returns', input)).data,
    onSuccess: () => invalidate(queryClient),
  });
}

export function usePostPurchaseReturn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await apiClient.post(`/purchasing/returns/${id}/post`)).data,
    onSuccess: (_d, id) => { invalidate(queryClient); queryClient.invalidateQueries({ queryKey: ['purchase-return', id] }); },
  });
}

export function useReversePurchaseReturn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => (await apiClient.post(`/purchasing/returns/${id}/reverse`, { reason })).data,
    onSuccess: (_d, { id }) => { invalidate(queryClient); queryClient.invalidateQueries({ queryKey: ['purchase-return', id] }); },
  });
}

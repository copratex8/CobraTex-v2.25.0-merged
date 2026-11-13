import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse, SalesReturn } from '@/api/types';

export function useSalesReturns(page: number, pageSize = 20) {
  return useQuery({
    queryKey: ['sales-returns', page, pageSize],
    queryFn: async () => (await apiClient.get<PaginatedResponse<SalesReturn>>('/sales/returns', { params: { page, pageSize } })).data,
  });
}

export function useSalesReturn(id: string | null) {
  return useQuery({
    queryKey: ['sales-return', id],
    queryFn: async () => (await apiClient.get<SalesReturn>(`/sales/returns/${id}`)).data,
    enabled: !!id,
  });
}

export interface SalesReturnLineInput {
  salesInvoiceLineId: string;
  quantity: string;
}

export interface CreateSalesReturnInput {
  branchId: string;
  warehouseId: string;
  salesInvoiceId: string;
  fiscalPeriodId: string;
  returnDate: string;
  lines: SalesReturnLineInput[];
}

function invalidate(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['sales-returns'] });
}

export function useCreateSalesReturn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateSalesReturnInput) => (await apiClient.post<SalesReturn>('/sales/returns', input)).data,
    onSuccess: () => invalidate(queryClient),
  });
}

export function usePostSalesReturn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await apiClient.post(`/sales/returns/${id}/post`)).data,
    onSuccess: (_d, id) => { invalidate(queryClient); queryClient.invalidateQueries({ queryKey: ['sales-return', id] }); },
  });
}

export function useReverseSalesReturn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => (await apiClient.post(`/sales/returns/${id}/reverse`, { reason })).data,
    onSuccess: (_d, { id }) => { invalidate(queryClient); queryClient.invalidateQueries({ queryKey: ['sales-return', id] }); },
  });
}

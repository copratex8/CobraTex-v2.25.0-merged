import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { PaginatedResponse, Stocktake } from '@/api/types';

export function useStocktakes(page: number, pageSize = 20) {
  return useQuery({
    queryKey: ['stocktakes', page, pageSize],
    queryFn: async () => (await apiClient.get<PaginatedResponse<Stocktake>>('/inventory/stocktakes', { params: { page, pageSize } })).data,
  });
}

export function useStocktake(id: string | null) {
  return useQuery({
    queryKey: ['stocktake', id],
    queryFn: async () => (await apiClient.get<Stocktake>(`/inventory/stocktakes/${id}`)).data,
    enabled: !!id,
  });
}

export interface CreateStocktakeInput {
  branchId: string;
  warehouseId: string;
  fiscalPeriodId: string;
  countDate: string;
  lines: { itemId: string; countedQuantity: string }[];
}

function invalidateStocktakes(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['stocktakes'] });
}

export function useCreateStocktake() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateStocktakeInput) => (await apiClient.post<Stocktake>('/inventory/stocktakes', input)).data,
    onSuccess: () => invalidateStocktakes(queryClient),
  });
}

export function usePostStocktake() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await apiClient.post(`/inventory/stocktakes/${id}/post`)).data,
    onSuccess: (_d, id) => { invalidateStocktakes(queryClient); queryClient.invalidateQueries({ queryKey: ['stocktake', id] }); },
  });
}

export function useReverseStocktake() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => (await apiClient.post(`/inventory/stocktakes/${id}/reverse`, { reason })).data,
    onSuccess: (_d, { id }) => { invalidateStocktakes(queryClient); queryClient.invalidateQueries({ queryKey: ['stocktake', id] }); },
  });
}

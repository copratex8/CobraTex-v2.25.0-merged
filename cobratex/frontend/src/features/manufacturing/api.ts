import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { Bom, PaginatedResponse, ProductionOrder } from '@/api/types';

/* ============================== قوائم المواد (BOM) ============================== */

export function useBoms() {
  return useQuery({
    queryKey: ['boms'],
    queryFn: async () => (await apiClient.get<Bom[]>('/manufacturing/boms')).data,
  });
}

export function useBom(id: string | null) {
  return useQuery({
    queryKey: ['bom', id],
    queryFn: async () => (await apiClient.get<Bom>(`/manufacturing/boms/${id}`)).data,
    enabled: !!id,
  });
}

export interface CreateBomInput {
  code: string;
  nameAr: string;
  nameEn: string;
  outputItemId: string;
  outputQuantity?: string;
  activityId?: string;
  lines: { componentItemId: string; quantity: string; wastePercent?: string }[];
  operations?: { name: string; costType: 'labor' | 'overhead' | 'other'; costAmount: string }[];
}

export function useCreateBom() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateBomInput) => (await apiClient.post<Bom>('/manufacturing/boms', input)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['boms'] }),
  });
}

/* ============================== أوامر التصنيع ============================== */

export function useProductionOrders(page: number, pageSize = 20) {
  return useQuery({
    queryKey: ['production-orders', page, pageSize],
    queryFn: async () => (await apiClient.get<PaginatedResponse<ProductionOrder>>('/manufacturing/orders', { params: { page, pageSize } })).data,
  });
}

export function useProductionOrder(id: string | null) {
  return useQuery({
    queryKey: ['production-order', id],
    queryFn: async () => (await apiClient.get<ProductionOrder>(`/manufacturing/orders/${id}`)).data,
    enabled: !!id,
  });
}

export interface CreateProductionOrderInput {
  branchId: string;
  warehouseId: string;
  bomId: string;
  fiscalPeriodId: string;
  orderDate: string;
  plannedOutputQuantity: string;
  activityId?: string;
}

function invalidateOrders(queryClient: ReturnType<typeof useQueryClient>, id?: string) {
  queryClient.invalidateQueries({ queryKey: ['production-orders'] });
  if (id) queryClient.invalidateQueries({ queryKey: ['production-order', id] });
}

export function useCreateProductionOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateProductionOrderInput) => (await apiClient.post<ProductionOrder>('/manufacturing/orders', input)).data,
    onSuccess: () => invalidateOrders(queryClient),
  });
}

export function usePostProductionOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await apiClient.post<{ id: string; journalEntryId: string; totalCost: string }>(`/manufacturing/orders/${id}/post`)).data,
    onSuccess: (_d, id) => invalidateOrders(queryClient, id),
  });
}

export function useReverseProductionOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => (await apiClient.post(`/manufacturing/orders/${id}/reverse`, { reason })).data,
    onSuccess: (_d, { id }) => invalidateOrders(queryClient, id),
  });
}

/** تعديل التكلفة الفعلية لمراحل أمر في المسودة (تحل محل المخطَّطة عند الترحيل). */
export function useUpdateOperationCosts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, operations }: { id: string; operations: { operationId: string; actualCost: string }[] }) =>
      (await apiClient.put(`/manufacturing/orders/${id}/operations`, { operations })).data,
    onSuccess: (_d, { id }) => queryClient.invalidateQueries({ queryKey: ['production-order', id] }),
  });
}

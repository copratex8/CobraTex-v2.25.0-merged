import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { GoodsReceipt, PaginatedResponse } from '@/api/types';

export function useGoodsReceipts(page: number, pageSize = 20) {
  return useQuery({
    queryKey: ['goods-receipts', page, pageSize],
    queryFn: async () => (await apiClient.get<PaginatedResponse<GoodsReceipt>>('/purchasing/receipts', { params: { page, pageSize } })).data,
  });
}

export function useGoodsReceipt(id: string | null) {
  return useQuery({
    queryKey: ['goods-receipt', id],
    queryFn: async () => (await apiClient.get<GoodsReceipt>(`/purchasing/receipts/${id}`)).data,
    enabled: !!id,
  });
}

/** يُستخدَم في نموذج فاتورة المورد: استلامات مرحَّلة لمورد محدَّد فقط، بكامل أسطرها (تفاصيل كل
 * استلام تُجلَب فرديًا لأن مسار القائمة لا يُرجع الأسطر — نفس نمط getXById في كل الوحدات). */
export function usePostedReceiptsForSupplier(supplierId: string | null) {
  return useQuery({
    queryKey: ['goods-receipts', 'posted-for-supplier', supplierId],
    queryFn: async () => {
      const list = await apiClient.get<PaginatedResponse<GoodsReceipt>>('/purchasing/receipts', {
        params: { page: 1, pageSize: 100, status: 'posted' },
      });
      const forSupplier = list.data.data.filter((r) => r.supplier_id === supplierId);
      const detailed = await Promise.all(
        forSupplier.map((r) => apiClient.get<GoodsReceipt>(`/purchasing/receipts/${r.id}`).then((res) => res.data)),
      );
      return detailed;
    },
    enabled: !!supplierId,
  });
}

export interface GoodsReceiptLineInput {
  itemId: string;
  uomId: string;
  quantity: string;
  unitCost: string;
}

export interface CreateGoodsReceiptInput {
  branchId: string;
  warehouseId: string;
  supplierId: string;
  receiptDate: string;
  lines: GoodsReceiptLineInput[];
}

function invalidateReceipts(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['goods-receipts'] });
}

export function useCreateGoodsReceipt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateGoodsReceiptInput) => (await apiClient.post<GoodsReceipt>('/purchasing/receipts', input)).data,
    onSuccess: () => invalidateReceipts(queryClient),
  });
}

export function usePostGoodsReceipt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await apiClient.post(`/purchasing/receipts/${id}/post`)).data,
    onSuccess: (_d, id) => {
      invalidateReceipts(queryClient);
      queryClient.invalidateQueries({ queryKey: ['goods-receipt', id] });
    },
  });
}

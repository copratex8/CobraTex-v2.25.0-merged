import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { AccountStatement, PaginatedResponse, Supplier } from '@/api/types';

export function useSuppliers(page: number, pageSize = 20) {
  return useQuery({
    queryKey: ['suppliers', page, pageSize],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<Supplier>>('/suppliers', { params: { page, pageSize } });
      return res.data;
    },
  });
}

export interface CreateSupplierInput {
  code: string;
  nameAr: string;
  nameEn: string;
  currencyCode: string;
  paymentTermDays?: number;
  taxNumber?: string;
}

export function useCreateSupplier() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateSupplierInput) => {
      const res = await apiClient.post<Supplier>('/suppliers', input);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suppliers'] });
    },
  });
}

export function useSupplierStatement(supplierId: string | null, fromDate?: string, toDate?: string) {
  return useQuery({
    queryKey: ['supplier-statement', supplierId, fromDate, toDate],
    queryFn: async () => {
      const res = await apiClient.get<AccountStatement>(`/suppliers/${supplierId}/statement`, { params: { fromDate, toDate } });
      return res.data;
    },
    enabled: !!supplierId,
  });
}

/** راجع نفس التعليق في customers/api.ts useUpdateCustomerStatus — نفس المبدأ بالضبط. */
export function useUpdateSupplierStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      const res = await apiClient.patch<Supplier>(`/suppliers/${id}`, { isActive });
      return res.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['suppliers'] }),
  });
}

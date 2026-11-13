import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { AccountStatement, Customer, PaginatedResponse } from '@/api/types';

export function useCustomers(page: number, pageSize = 20) {
  return useQuery({
    queryKey: ['customers', page, pageSize],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<Customer>>('/customers', { params: { page, pageSize } });
      return res.data;
    },
  });
}

export interface CreateCustomerInput {
  code: string;
  nameAr: string;
  nameEn: string;
  currencyCode: string;
  creditLimit?: string;
  paymentTermDays?: number;
  taxNumber?: string;
}

export function useCreateCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateCustomerInput) => {
      const res = await apiClient.post<Customer>('/customers', input);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}

export function useCustomerStatement(customerId: string | null, fromDate?: string, toDate?: string) {
  return useQuery({
    queryKey: ['customer-statement', customerId, fromDate, toDate],
    queryFn: async () => {
      const res = await apiClient.get<AccountStatement>(`/customers/${customerId}/statement`, { params: { fromDate, toDate } });
      return res.data;
    },
    enabled: !!customerId,
  });
}

/** تعطيل/تفعيل (Soft Toggle) — لا حذف مادي إطلاقًا؛ العميل المُعطَّل يختفي من قوائم الاختيار في
 * المستندات الجديدة فقط، وتاريخه المحاسبي القديم يبقى سليمًا تمامًا. */
export function useUpdateCustomerStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      const res = await apiClient.patch<Customer>(`/customers/${id}`, { isActive });
      return res.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['customers'] }),
  });
}

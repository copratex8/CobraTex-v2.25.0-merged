import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { CustomerPayment, PaginatedResponse, RemainingBalance } from '@/api/types';

export function useCustomerPayments(page: number, pageSize = 20) {
  return useQuery({
    queryKey: ['customer-payments', page, pageSize],
    queryFn: async () => (await apiClient.get<PaginatedResponse<CustomerPayment>>('/sales/payments', { params: { page, pageSize } })).data,
  });
}

export function useCustomerPayment(id: string | null) {
  return useQuery({
    queryKey: ['customer-payment', id],
    queryFn: async () => (await apiClient.get<CustomerPayment>(`/sales/payments/${id}`)).data,
    enabled: !!id,
  });
}

/** فواتير العميل المرحَّلة ذات المتبقي > 0 فقط — تُجلَب فواتير العميل من القائمة العامة (لا فلتر
 * customer_id في الباك إند بعد) ثم يُستعلَم متبقي كل فاتورة فرديًا، مطابقةً لنمط استلامات المورد. */
export function useCustomerOpenInvoices(customerId: string | null) {
  return useQuery({
    queryKey: ['customer-open-invoices', customerId],
    queryFn: async () => {
      const list = await apiClient.get('/sales/invoices', { params: { page: 1, pageSize: 100, status: 'posted' } });
      const forCustomer = list.data.data.filter((inv: { customer_id: string }) => inv.customer_id === customerId);
      const withBalances = await Promise.all(
        forCustomer.map(async (inv: { id: string; document_number: string; invoice_date: string }) => {
          const balance = await apiClient.get<RemainingBalance>(`/sales/invoices/${inv.id}/remaining-balance`);
          return { ...inv, ...balance.data };
        }),
      );
      return withBalances.filter((inv) => Number(inv.remaining) > 0);
    },
    enabled: !!customerId,
  });
}

export interface CreateCustomerPaymentInput {
  branchId: string;
  customerId: string;
  fiscalPeriodId: string;
  currencyCode: string;
  exchangeRate?: string;
  paymentDate: string;
  amount: string;
  receiptAccountId: string;
}

function invalidate(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['customer-payments'] });
}

export function useCreateCustomerPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateCustomerPaymentInput) => (await apiClient.post<CustomerPayment>('/sales/payments', input)).data,
    onSuccess: () => invalidate(queryClient),
  });
}

export function usePostCustomerPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await apiClient.post(`/sales/payments/${id}/post`)).data,
    onSuccess: (_d, id) => { invalidate(queryClient); queryClient.invalidateQueries({ queryKey: ['customer-payment', id] }); },
  });
}

export function useReverseCustomerPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => (await apiClient.post(`/sales/payments/${id}/reverse`, { reason })).data,
    onSuccess: (_d, { id }) => { invalidate(queryClient); queryClient.invalidateQueries({ queryKey: ['customer-payment', id] }); },
  });
}

export function useAllocateCustomerPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, allocations }: { id: string; allocations: { salesInvoiceId: string; amount: string }[] }) =>
      (await apiClient.post(`/sales/payments/${id}/allocate`, { allocations })).data,
    onSuccess: (_d, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['customer-payment', id] });
      queryClient.invalidateQueries({ queryKey: ['customer-open-invoices'] });
    },
  });
}

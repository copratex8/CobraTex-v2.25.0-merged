import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { Check, PaginatedResponse, TreasuryTransaction, TreasuryTransfer } from '@/api/types';

/* ============================== سندات القبض والصرف ============================== */

export function useTreasuryTransactions(page: number, pageSize = 20, filters: { status?: string } = {}) {
  return useQuery({
    queryKey: ['treasury-transactions', page, pageSize, filters.status ?? null],
    queryFn: async () =>
      (await apiClient.get<PaginatedResponse<TreasuryTransaction>>('/treasury/transactions', { params: { page, pageSize, status: filters.status || undefined } })).data,
  });
}

export function useTreasuryTransaction(id: string | null) {
  return useQuery({
    queryKey: ['treasury-transaction', id],
    queryFn: async () => (await apiClient.get<TreasuryTransaction>(`/treasury/transactions/${id}`)).data,
    enabled: !!id,
  });
}

export interface CreateTreasuryTransactionInput {
  branchId: string;
  safeOrBankId: string;
  transactionType: 'receipt' | 'payment';
  counterpartyType: 'customer' | 'supplier' | 'other';
  counterpartyCustomerId?: string;
  counterpartySupplierId?: string;
  contraAccountId?: string;
  amount: string;
  currencyCode: string;
  transactionDate: string;
  fiscalPeriodId: string;
  description?: string;
}

function invalidateTransactions(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['treasury-transactions'] });
}

export function useCreateTreasuryTransaction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateTreasuryTransactionInput) => (await apiClient.post<TreasuryTransaction>('/treasury/transactions', input)).data,
    onSuccess: () => invalidateTransactions(queryClient),
  });
}

export function usePostTreasuryTransaction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await apiClient.post(`/treasury/transactions/${id}/post`)).data,
    onSuccess: (_d, id) => { invalidateTransactions(queryClient); queryClient.invalidateQueries({ queryKey: ['treasury-transaction', id] }); },
  });
}

export function useReverseTreasuryTransaction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => (await apiClient.post(`/treasury/transactions/${id}/reverse`, { reason })).data,
    onSuccess: (_d, { id }) => { invalidateTransactions(queryClient); queryClient.invalidateQueries({ queryKey: ['treasury-transaction', id] }); },
  });
}

/* ============================== تحويلات بين خزينتين/بنكين ============================== */

export function useTreasuryTransfers(page: number, pageSize = 20) {
  return useQuery({
    queryKey: ['treasury-transfers', page, pageSize],
    queryFn: async () =>
      (await apiClient.get<PaginatedResponse<TreasuryTransfer>>('/treasury/transfers', { params: { page, pageSize } })).data,
  });
}

export function useTreasuryTransfer(id: string | null) {
  return useQuery({
    queryKey: ['treasury-transfer', id],
    queryFn: async () => (await apiClient.get<TreasuryTransfer>(`/treasury/transfers/${id}`)).data,
    enabled: !!id,
  });
}

export interface CreateTreasuryTransferInput {
  branchId: string;
  fromSafeOrBankId: string;
  toSafeOrBankId: string;
  amount: string;
  currencyCode: string;
  transferDate: string;
  fiscalPeriodId: string;
}

function invalidateTransfers(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['treasury-transfers'] });
}

export function useCreateTreasuryTransfer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateTreasuryTransferInput) => (await apiClient.post<TreasuryTransfer>('/treasury/transfers', input)).data,
    onSuccess: () => invalidateTransfers(queryClient),
  });
}

export function usePostTreasuryTransfer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await apiClient.post(`/treasury/transfers/${id}/post`)).data,
    onSuccess: (_d, id) => { invalidateTransfers(queryClient); queryClient.invalidateQueries({ queryKey: ['treasury-transfer', id] }); },
  });
}

export function useReverseTreasuryTransfer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => (await apiClient.post(`/treasury/transfers/${id}/reverse`, { reason })).data,
    onSuccess: (_d, { id }) => { invalidateTransfers(queryClient); queryClient.invalidateQueries({ queryKey: ['treasury-transfer', id] }); },
  });
}

/* ============================== الشيكات ============================== */

export function useChecks(page: number, pageSize = 20) {
  return useQuery({
    queryKey: ['checks', page, pageSize],
    queryFn: async () => (await apiClient.get<PaginatedResponse<Check>>('/treasury/checks', { params: { page, pageSize } })).data,
  });
}

export function useCheck(id: string | null) {
  return useQuery({
    queryKey: ['check', id],
    queryFn: async () => (await apiClient.get<Check>(`/treasury/checks/${id}`)).data,
    enabled: !!id,
  });
}

export interface RegisterCheckInput {
  branchId: string;
  safeOrBankId: string;
  checkType: 'incoming' | 'outgoing';
  checkNumber: string;
  checkDate: string;
  dueDate: string;
  amount: string;
  currencyCode: string;
  counterpartyCustomerId?: string;
  counterpartySupplierId?: string;
  notes?: string;
}

function invalidateChecks(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['checks'] });
}

export function useRegisterCheck() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: RegisterCheckInput) => (await apiClient.post<Check>('/treasury/checks', input)).data,
    onSuccess: () => invalidateChecks(queryClient),
  });
}

export interface TransitionCheckInput {
  id: string;
  target: 'deposited' | 'cleared' | 'bounced' | 'cancelled';
  reason?: string;
  fiscalPeriodId?: string;
  clearDate?: string;
}

export function useTransitionCheck() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }: TransitionCheckInput) => (await apiClient.post(`/treasury/checks/${id}/transition`, body)).data,
    onSuccess: (_d, { id }) => { invalidateChecks(queryClient); queryClient.invalidateQueries({ queryKey: ['check', id] }); },
  });
}

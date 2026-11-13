import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { BankReconciliation, PaginatedResponse } from '@/api/types';

export function useReconciliations(page: number, pageSize = 20) {
  return useQuery({
    queryKey: ['reconciliations', page, pageSize],
    queryFn: async () => (await apiClient.get<PaginatedResponse<BankReconciliation>>('/treasury/reconciliations', { params: { page, pageSize } })).data,
  });
}

export function useReconciliation(id: string | null) {
  return useQuery({
    queryKey: ['reconciliation', id],
    queryFn: async () => (await apiClient.get<BankReconciliation>(`/treasury/reconciliations/${id}`)).data,
    enabled: !!id,
  });
}

export interface CreateReconciliationInput {
  branchId: string;
  safeOrBankId: string;
  statementDate: string;
  openingBalance?: string;
  statementEndingBalance: string;
  lines: { lineDate: string; description?: string; amount: string; reference?: string }[];
}

function invalidate(queryClient: ReturnType<typeof useQueryClient>, id?: string) {
  queryClient.invalidateQueries({ queryKey: ['reconciliations'] });
  if (id) queryClient.invalidateQueries({ queryKey: ['reconciliation', id] });
}

export function useCreateReconciliation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateReconciliationInput) => (await apiClient.post<BankReconciliation>('/treasury/reconciliations', input)).data,
    onSuccess: () => invalidate(queryClient),
  });
}

export function useAutoMatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await apiClient.post<{ matchedCount: number; ambiguousCount: number }>(`/treasury/reconciliations/${id}/auto-match`)).data,
    onSuccess: (_d, id) => invalidate(queryClient, id),
  });
}

export function useMatchLine() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ reconciliationId, lineId, treasuryTransactionId, treasuryTransferId }: {
      reconciliationId: string; lineId: string; treasuryTransactionId?: string; treasuryTransferId?: string;
    }) => (await apiClient.post(`/treasury/reconciliations/${reconciliationId}/lines/${lineId}/match`, { treasuryTransactionId, treasuryTransferId })).data,
    onSuccess: (_d, { reconciliationId }) => invalidate(queryClient, reconciliationId),
  });
}

export function useUnmatchLine() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ reconciliationId, lineId }: { reconciliationId: string; lineId: string }) =>
      (await apiClient.post(`/treasury/reconciliations/${reconciliationId}/lines/${lineId}/unmatch`)).data,
    onSuccess: (_d, { reconciliationId }) => invalidate(queryClient, reconciliationId),
  });
}

export function useCompleteReconciliation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await apiClient.post(`/treasury/reconciliations/${id}/complete`)).data,
    onSuccess: (_d, id) => invalidate(queryClient, id),
  });
}

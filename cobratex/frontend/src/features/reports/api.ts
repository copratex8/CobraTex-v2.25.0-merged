import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { InventoryValuationReport, PurchaseSummaryReport, SalesSummaryReport, TrialBalanceReport } from '@/api/types';

export function useTrialBalance(asOfDate: string, fromDate?: string, onlyWithActivity = false) {
  return useQuery({
    queryKey: ['trial-balance', asOfDate, fromDate, onlyWithActivity],
    queryFn: async () =>
      (await apiClient.get<TrialBalanceReport>('/accounting/reports/trial-balance', {
        params: { asOfDate, fromDate, onlyWithActivity },
      })).data,
    enabled: !!asOfDate,
  });
}

export function useInventoryValuation(warehouseId?: string, onlyWithStock = true) {
  return useQuery({
    queryKey: ['inventory-valuation', warehouseId, onlyWithStock],
    queryFn: async () =>
      (await apiClient.get<InventoryValuationReport>('/inventory/reports/valuation', {
        params: { warehouseId: warehouseId || undefined, onlyWithStock },
      })).data,
  });
}

export function useSalesSummary(fromDate: string, toDate: string, groupBy: 'item' | 'customer' | 'day') {
  return useQuery({
    queryKey: ['sales-summary', fromDate, toDate, groupBy],
    queryFn: async () =>
      (await apiClient.get<SalesSummaryReport>('/sales/reports/summary', { params: { fromDate, toDate, groupBy } })).data,
    enabled: !!fromDate && !!toDate,
  });
}

export function usePurchaseSummary(fromDate: string, toDate: string, groupBy: 'item' | 'supplier' | 'day') {
  return useQuery({
    queryKey: ['purchase-summary', fromDate, toDate, groupBy],
    queryFn: async () =>
      (await apiClient.get<PurchaseSummaryReport>('/purchasing/reports/summary', { params: { fromDate, toDate, groupBy } })).data,
    enabled: !!fromDate && !!toDate,
  });
}

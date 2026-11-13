import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import type { Account, Activity, Branch, Company, PaginatedResponse } from '@/api/types';

export interface Item {
  id: string;
  code: string;
  name_ar: string;
  name_en: string;
  item_kind: 'raw_material' | 'fabric' | 'thread' | 'finished_good' | 'generic';
  base_uom_id: string;
  category_id: string | null;
  is_active: boolean;
}

export interface ItemCategory {
  id: string;
  name_ar: string;
  name_en: string;
  item_kind: string;
}

export interface Uom {
  id: string;
  name_ar: string;
  name_en: string;
  symbol: string;
}

export interface Warehouse {
  id: string;
  branch_id: string;
  name_ar: string;
  name_en: string;
}

export interface FiscalPeriod {
  id: string;
  start_date: string;
  end_date: string;
  status: 'open' | 'closed';
}

/** الأصناف قد تكون كثيرة — pageSize=100 (الحد الأقصى المسموح) كافٍ لعرض قائمة اختيار عملية بلا صفحات معقّدة في هذه المرحلة. */
/** بلا تصفية على is_active هنا عمدًا — تُستخدَم من مكانين بحاجتين متعارضتين: قوائم اختيار صنف
 * جديد (تحتاج النشط فقط، تُصفِّي بنفسها عند العرض) وصفحات طباعة الفواتير القديمة (تحتاج حتى
 * الأصناف المُعطَّلة لاحقًا، لعرض اسمها الصحيح بدل UUID خام في فاتورة قديمة تخصّها). */
export function useItems() {
  return useQuery({
    queryKey: ['items'],
    queryFn: async () => {
      const res = await apiClient.get<PaginatedResponse<Item>>('/items', { params: { page: 1, pageSize: 100 } });
      return res.data.data;
    },
  });
}

/** نسخة مُصفَّحة (بصفحات فعلية) من نفس المسار — لصفحة إدارة الأصناف (ItemsListPage)، بخلاف
 * useItems أعلاه المخصَّصة لقوائم الاختيار (dropdown) في نماذج المستندات. */
export function useItemsPage(page: number, pageSize = 20) {
  return useQuery({
    queryKey: ['items-page', page, pageSize],
    queryFn: async () => (await apiClient.get<PaginatedResponse<Item>>('/items', { params: { page, pageSize } })).data,
  });
}

export function useItemCategories() {
  return useQuery({
    queryKey: ['item-categories'],
    queryFn: async () => (await apiClient.get<ItemCategory[]>('/item-categories')).data,
  });
}

export interface CreateItemInput {
  code: string;
  nameAr: string;
  nameEn: string;
  itemKind: 'raw_material' | 'fabric' | 'thread' | 'finished_good' | 'generic';
  baseUomId: string;
  categoryId?: string;
  barcode?: string;
}

export function useCreateItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateItemInput) => (await apiClient.post<Item>('/items', input)).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['items-page'] });
    },
  });
}

/** راجع نفس التعليق في customers/api.ts useUpdateCustomerStatus — نفس المبدأ بالضبط (تعطيل/تفعيل بلا حذف مادي). */
export function useUpdateItemStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => (await apiClient.patch<Item>(`/items/${id}`, { isActive })).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['items-page'] });
    },
  });
}

export function useUoms() {
  return useQuery({
    queryKey: ['uoms'],
    queryFn: async () => (await apiClient.get<Uom[]>('/uoms')).data,
  });
}

export function useWarehouses() {
  return useQuery({
    queryKey: ['warehouses'],
    queryFn: async () => (await apiClient.get<Warehouse[]>('/warehouses')).data,
  });
}

export function useFiscalPeriods() {
  return useQuery({
    queryKey: ['fiscal-periods'],
    queryFn: async () => (await apiClient.get<FiscalPeriod[]>('/accounting/fiscal-periods')).data,
  });
}

export interface TaxType {
  id: string;
  name_ar: string;
  name_en: string;
  current_rate_percent: string | null;
  current_is_exempt: boolean | null;
}

export function useTaxTypes() {
  return useQuery({
    queryKey: ['tax-types'],
    queryFn: async () => (await apiClient.get<TaxType[]>('/accounting/tax-types')).data,
  });
}

export interface SafeOrBank {
  id: string;
  branch_id: string;
  code: string;
  name_ar: string;
  name_en: string;
  kind: 'safe' | 'bank';
  currency_code: string;
  linked_account_id: string;
  bank_name: string | null;
  account_number: string | null;
  iban: string | null;
}

export function useSafes() {
  return useQuery({
    queryKey: ['safes'],
    queryFn: async () => (await apiClient.get<PaginatedResponse<SafeOrBank>>('/treasury/safes', { params: { page: 1, pageSize: 100 } })).data.data,
  });
}

export interface CreateSafeOrBankInput {
  branchId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  kind: 'safe' | 'bank';
  currencyCode: string;
  bankName?: string;
  accountNumber?: string;
  iban?: string;
}

export function useCreateSafeOrBank() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateSafeOrBankInput) => (await apiClient.post<SafeOrBank>('/treasury/safes', input)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['safes'] }),
  });
}

/** دليل الحسابات كاملًا بلا صفحات (مطابق لنمط useFiscalPeriods) — يُستخدم لاختيار الحساب المقابل
 * عند سند خزينة بطرف 'other' (إيراد متنوع/مصروف/رأس مال...) بدل عميل أو مورد. */
export function useAccounts() {
  return useQuery({
    queryKey: ['accounts'],
    queryFn: async () => (await apiClient.get<Account[]>('/accounting/accounts')).data,
  });
}

/** بيانات الشركة الأساسية (الاسم، الشعار...) — لم يكن لها أي مسار قراءة من قبل؛ أُضيفت أثناء بناء
 * ترويسة طباعة الفواتير، والتي تحتاج اسم الشركة. */
export function useCompany() {
  return useQuery({
    queryKey: ['company'],
    queryFn: async () => (await apiClient.get<Company>('/company')).data,
  });
}

/** تشغيل/إيقاف وحدة التصنيع كاملة لهذه الشركة — فصلها عن البرنامج الأساسي (بلا حذف كود أو بيانات). */
export function useUpdateManufacturingEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) => (await apiClient.put<Company>('/company/settings/manufacturing-enabled', { enabled })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['company'] }),
  });
}

/** قائمة الفروع كاملة بلا صفحات — لم يكن لها أي مسار قراءة من قبل؛ نفس السبب أعلاه (عنوان الفرع
 * في ترويسة الفاتورة المطبوعة). */
export function useBranches() {
  return useQuery({
    queryKey: ['branches'],
    queryFn: async () => (await apiClient.get<Branch[]>('/branches')).data,
  });
}

/**
 * الأنشطة (Activities): بُعد تصنيفي عام — كل شركة تُعرِّف أنشطتها الخاصة (غزل، نسيج، تجميع نوافذ
 * uPVC، أو أي تصنيف آخر) ثم تُصنِّف عليها BOM/أوامر التصنيع وحركات المخزون اختياريًا. هذا ما يجعل
 * وحدة التصنيع تصلح لأي نشاط بدل افتراض صناعة بعينها في الكود.
 */
export function useActivities() {
  return useQuery({
    queryKey: ['activities'],
    queryFn: async () => (await apiClient.get<Activity[]>('/activities')).data,
  });
}

export interface CreateActivityInput {
  nameAr: string;
  nameEn: string;
  templateKey?: string;
}

export function useCreateActivity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateActivityInput) => (await apiClient.post<Activity>('/activities', input)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['activities'] }),
  });
}

export function useUpdateActivityStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => (await apiClient.patch<Activity>(`/activities/${id}`, { isActive })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['activities'] }),
  });
}

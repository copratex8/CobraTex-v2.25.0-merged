/** يطابق تمامًا شكل الاستجابة الموحَّد من paginatedList في الباك إند (src/shared/pagination.ts). */
export interface PaginatedResponse<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface Customer {
  id: string;
  code: string;
  name_ar: string;
  name_en: string;
  tax_number: string | null;
  credit_limit: string;
  payment_term_days: number;
  currency_code: string;
  linked_account_id: string;
  is_active: boolean;
  created_at: string;
}

export interface Supplier {
  id: string;
  code: string;
  name_ar: string;
  name_en: string;
  tax_number: string | null;
  payment_term_days: number;
  currency_code: string;
  linked_account_id: string;
  is_active: boolean;
  created_at: string;
}

export interface StatementLine {
  journal_entry_id: string;
  entry_date: string;
  source_document_type: string;
  source_document_id: string | null;
  debit: string;
  credit: string;
  description: string | null;
  running_balance: string;
}

export interface AccountStatement {
  customerId?: string;
  supplierId?: string;
  accountId: string;
  lines: StatementLine[];
  closingBalance: string;
}

export interface SalesInvoiceLine {
  id: string;
  item_id: string;
  uom_id: string;
  quantity: string;
  unit_price: string;
  discount_percent: string;
  subtotal: string;
  tax_amount: string;
  line_total: string;
  /** الكمية المُرجَعة تراكميًا عبر كل مرتجعات هذا السطر (تحجزها createSalesReturn ذريًا) —
   * الكمية القابلة للإرجاع فعليًا الآن = quantity - returned_quantity. الحقل موجود في قاعدة
   * البيانات وتُعيده SELECT * في الباك إند منذ migration 0017، لكنه كان مفقودًا من هذا النوع فقط. */
  returned_quantity: string;
}

export interface SalesInvoice {
  id: string;
  branch_id: string;
  warehouse_id: string;
  customer_id: string;
  document_number: string;
  currency_code: string;
  invoice_date: string;
  status: 'draft' | 'posted' | 'cancelled' | 'reversed';
  journal_entry_id?: string | null;
  lines?: SalesInvoiceLine[];
}

export interface GoodsReceiptLine {
  id: string;
  item_id: string;
  uom_id: string;
  quantity: string;
  unit_cost: string;
  invoiced_quantity: string;
}

export interface GoodsReceipt {
  id: string;
  branch_id: string;
  warehouse_id: string;
  supplier_id: string;
  document_number: string;
  receipt_date: string;
  status: 'draft' | 'posted' | 'cancelled';
  lines?: GoodsReceiptLine[];
}

export interface PurchaseInvoiceLine {
  id: string;
  goods_receipt_line_id: string;
  item_id: string;
  quantity: string;
  unit_cost: string;
  subtotal: string;
  tax_amount: string;
  line_total: string;
  /** راجع نفس التعليق في SalesInvoiceLine.returned_quantity — العمود موجود في supplier_invoice_lines
   * منذ migration 0017 ويعود مع SELECT *، وكان مفقودًا من هذا النوع فقط. */
  returned_quantity: string;
}

export interface TrialBalanceAccount {
  id: string;
  code: string;
  name_ar: string;
  name_en: string;
  account_type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  total_debit: string;
  total_credit: string;
}

export interface TrialBalanceReport {
  asOfDate: string;
  fromDate: string | null;
  accounts: TrialBalanceAccount[];
  totals: { debit: number; credit: number };
}

export interface InventoryValuationLine {
  warehouse_id: string;
  warehouse_name_ar: string;
  warehouse_name_en: string;
  item_id: string;
  item_code: string;
  item_name_ar: string;
  item_name_en: string;
  batch_id: string | null;
  quantity_on_hand: string;
  quantity_reserved: string;
  weighted_average_cost: string;
  stock_value: string;
}

export interface InventoryValuationReport {
  warehouseId: string | null;
  lines: InventoryValuationLine[];
  totalValue: string;
}

export interface SalesSummaryLine {
  item_id?: string;
  item_code?: string;
  item_name_ar?: string;
  customer_id?: string;
  customer_code?: string;
  customer_name_ar?: string;
  day?: string;
  invoice_count: number;
  total_quantity?: string;
  total_sales: string;
}

export interface SalesSummaryReport {
  fromDate: string;
  toDate: string;
  groupBy: 'item' | 'customer' | 'day';
  lines: SalesSummaryLine[];
  grandTotal: string;
}

export interface PurchaseSummaryLine {
  item_id?: string;
  item_code?: string;
  item_name_ar?: string;
  supplier_id?: string;
  supplier_code?: string;
  supplier_name_ar?: string;
  day?: string;
  invoice_count: number;
  total_quantity?: string;
  total_purchases: string;
}

export interface PurchaseSummaryReport {
  fromDate: string;
  toDate: string;
  groupBy: 'item' | 'supplier' | 'day';
  lines: PurchaseSummaryLine[];
  grandTotal: string;
}

export interface PurchaseInvoice {
  id: string;
  branch_id: string;
  supplier_id: string;
  document_number: string;
  currency_code: string;
  invoice_date: string;
  status: 'draft' | 'posted' | 'cancelled' | 'reversed';
  journal_entry_id?: string | null;
  lines?: PurchaseInvoiceLine[];
}

export interface SalesReturnLine {
  id: string;
  sales_invoice_line_id: string;
  item_id: string;
  quantity: string;
  subtotal: string;
  tax_amount: string;
  line_total: string;
}

export interface SalesReturn {
  id: string;
  branch_id: string;
  warehouse_id: string;
  sales_invoice_id: string;
  document_number: string;
  return_date: string;
  status: 'draft' | 'posted' | 'cancelled' | 'reversed';
  lines?: SalesReturnLine[];
}

export interface PurchaseReturnLine {
  id: string;
  supplier_invoice_line_id: string;
  item_id: string;
  quantity: string;
  unit_cost: string;
  subtotal: string;
  tax_amount: string;
  line_total: string;
}

export interface PurchaseReturn {
  id: string;
  branch_id: string;
  warehouse_id: string;
  supplier_invoice_id: string;
  document_number: string;
  return_date: string;
  status: 'draft' | 'posted' | 'cancelled' | 'reversed';
  lines?: PurchaseReturnLine[];
}

export interface RemainingBalance {
  total: string;
  allocated: string;
  remaining: string;
}

export interface PaymentAllocation {
  id: string;
  sales_invoice_id?: string;
  supplier_invoice_id?: string;
  allocated_amount: string;
  fx_difference_amount: string;
}

export interface CustomerPayment {
  id: string;
  branch_id: string;
  customer_id: string;
  document_number: string;
  currency_code: string;
  payment_date: string;
  amount: string;
  receipt_account_id: string;
  status: 'draft' | 'posted' | 'cancelled' | 'reversed';
  allocations?: PaymentAllocation[];
}

export interface SupplierPayment {
  id: string;
  branch_id: string;
  supplier_id: string;
  document_number: string;
  currency_code: string;
  payment_date: string;
  amount: string;
  payment_account_id: string;
  status: 'draft' | 'posted' | 'cancelled' | 'reversed';
  allocations?: PaymentAllocation[];
}

export interface Account {
  id: string;
  code: string;
  name_ar: string;
  name_en: string;
  account_type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  parent_id: string | null;
  currency_code: string | null;
}

export interface Company {
  id: string;
  legal_name: string;
  display_name: string;
  country_code: string;
  base_currency_code: string;
  logo_url: string | null;
  manufacturing_enabled: boolean;
}

export interface Branch {
  id: string;
  company_id: string;
  name_ar: string;
  name_en: string;
  address: string | null;
  is_active: boolean;
}

export interface StocktakeLine {
  id: string;
  item_id: string;
  batch_id: string | null;
  system_quantity: string;
  counted_quantity: string;
  unit_cost: string;
  variance_quantity: string;
  variance_value: string;
}

export interface Stocktake {
  id: string;
  branch_id: string;
  warehouse_id: string;
  fiscal_period_id: string;
  document_number: string;
  currency_code: string;
  count_date: string;
  status: 'draft' | 'posted' | 'reversed';
  journal_entry_id: string | null;
  cancelled_reason: string | null;
  lines?: StocktakeLine[];
}

export interface BankStatementLine {
  id: string;
  reconciliation_id: string;
  line_date: string;
  description: string | null;
  amount: string;
  reference: string | null;
  matched_treasury_transaction_id: string | null;
  matched_treasury_transfer_id: string | null;
}

export interface BankReconciliation {
  id: string;
  branch_id: string;
  safe_or_bank_id: string;
  statement_date: string;
  opening_balance: string;
  statement_ending_balance: string;
  status: 'in_progress' | 'completed';
  lines?: BankStatementLine[];
  unmatchedTransactions?: TreasuryTransaction[];
  unmatchedTransfers?: TreasuryTransfer[];
}

export interface TreasuryTransaction {
  id: string;
  branch_id: string;
  safe_or_bank_id: string;
  document_number: string;
  transaction_type: 'receipt' | 'payment';
  counterparty_type: 'customer' | 'supplier' | 'other';
  counterparty_customer_id: string | null;
  counterparty_supplier_id: string | null;
  contra_account_id: string | null;
  amount: string;
  currency_code: string;
  exchange_rate: string;
  transaction_date: string;
  description: string | null;
  status: 'draft' | 'posted' | 'cancelled' | 'reversed';
  journal_entry_id: string | null;
}

export interface TreasuryTransfer {
  id: string;
  branch_id: string;
  from_safe_or_bank_id: string;
  to_safe_or_bank_id: string;
  document_number: string;
  amount: string;
  currency_code: string;
  exchange_rate: string;
  transfer_date: string;
  status: 'draft' | 'posted' | 'cancelled' | 'reversed';
  journal_entry_id: string | null;
}

export interface Check {
  id: string;
  branch_id: string;
  safe_or_bank_id: string;
  check_type: 'incoming' | 'outgoing';
  check_number: string;
  check_date: string;
  due_date: string;
  amount: string;
  currency_code: string;
  counterparty_customer_id: string | null;
  counterparty_supplier_id: string | null;
  status: 'pending' | 'deposited' | 'cleared' | 'bounced' | 'cancelled';
  notes: string | null;
  treasury_transaction_id: string | null;
}

export interface Activity {
  id: string;
  company_id: string;
  name_ar: string;
  name_en: string;
  template_key: string;
  is_active: boolean;
}

export interface BomLine {
  id: string;
  bom_id: string;
  component_item_id: string;
  quantity: string;
  waste_percent: string;
  sequence: number;
}

export type OperationCostType = 'labor' | 'overhead' | 'other';

export interface BomOperation {
  id: string;
  sequence: number;
  name: string;
  cost_type: OperationCostType;
  cost_amount: string;
}

export interface ProductionOrderOperation {
  id: string;
  sequence: number;
  name: string;
  cost_type: OperationCostType;
  planned_cost: string;
  actual_cost: string | null;
}

export interface Bom {
  id: string;
  company_id: string;
  output_item_id: string;
  code: string;
  name_ar: string;
  name_en: string;
  output_quantity: string;
  activity_id: string | null;
  is_active: boolean;
  lines?: BomLine[];
  operations?: BomOperation[];
}

export interface ProductionOrderLine {
  id: string;
  production_order_id: string;
  component_item_id: string;
  planned_quantity: string;
  waste_percent: string;
  consumed_quantity: string | null;
  unit_cost: string | null;
  line_cost: string | null;
}

export interface ProductionOrder {
  id: string;
  branch_id: string;
  warehouse_id: string;
  bom_id: string;
  output_item_id: string;
  activity_id: string | null;
  document_number: string;
  fiscal_period_id: string;
  order_date: string;
  currency_code: string;
  planned_output_quantity: string;
  actual_output_quantity: string | null;
  total_cost: string | null;
  materials_cost: string | null;
  conversion_cost: string | null;
  status: 'draft' | 'posted' | 'reversed';
  journal_entry_id: string | null;
  cancelled_reason: string | null;
  lines?: ProductionOrderLine[];
  operations?: ProductionOrderOperation[];
}

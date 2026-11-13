-- 0060_sales_payment_type.sql
-- نوع الدفع على فاتورة المبيعات (نقدي/آجل/شيك/تحويل) لتقرير البيع حسب نوع الدفع. اختياري؛ الفواتير القديمة تبقى بلا نوع.
ALTER TABLE sales_invoices ADD COLUMN payment_type TEXT CHECK (payment_type IS NULL OR payment_type IN ('cash','credit','cheque','transfer'));

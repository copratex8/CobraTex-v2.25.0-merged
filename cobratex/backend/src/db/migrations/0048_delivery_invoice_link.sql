-- 0048_delivery_invoice_link.sql: ربط إذن التسليم بفاتورة البيع (اختياري، عدّة أذون لفاتورة واحدة). أعمدة إضافية فقط.
ALTER TABLE delivery_notes ADD COLUMN sales_invoice_id UUID REFERENCES sales_invoices(id);
CREATE INDEX idx_delivery_notes_invoice ON delivery_notes(company_id, sales_invoice_id) WHERE sales_invoice_id IS NOT NULL;

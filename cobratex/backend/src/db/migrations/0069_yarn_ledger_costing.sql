-- 0069_yarn_ledger_costing.sql — ربط دفتر الخيوط بأوامر التصنيع وسعر الكيلو (2.20.0). تحليلي: لا قيود.
ALTER TABLE yarn_receipts ADD COLUMN unit_price NUMERIC(14,4) CHECK (unit_price IS NULL OR unit_price >= 0);
ALTER TABLE yarn_runs ADD COLUMN production_order_id UUID;
ALTER TABLE yarn_runs ADD FOREIGN KEY (production_order_id, company_id) REFERENCES production_orders (id, company_id);
CREATE INDEX idx_yarn_runs_order ON yarn_runs(company_id, production_order_id) WHERE production_order_id IS NOT NULL;

-- 0005_inventory_stock.sql

CREATE TABLE stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  branch_id UUID NOT NULL,
  warehouse_id UUID NOT NULL,
  item_id UUID NOT NULL,
  batch_id UUID,
  movement_type TEXT NOT NULL CHECK (movement_type IN
    ('opening','in','out','transfer_in','transfer_out','adjustment_in','adjustment_out','loss')),
  quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  unit_cost NUMERIC(18,4), -- إلزامي منطقيًا لحركات الوارد، يُتحقق منه في طبقة الخدمة
  movement_date DATE NOT NULL,
  effective_date DATE NOT NULL,
  source_document_type TEXT NOT NULL,
  source_document_id UUID,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  reversed_by_movement_id UUID REFERENCES stock_movements(id),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (warehouse_id, company_id) REFERENCES warehouses (id, company_id),
  FOREIGN KEY (item_id, company_id) REFERENCES items (id, company_id),
  FOREIGN KEY (batch_id, company_id) REFERENCES batches (id, company_id)
);
CREATE INDEX idx_stock_movements_lookup ON stock_movements(company_id, warehouse_id, item_id, effective_date);

CREATE TABLE stock_valuation_layers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  item_id UUID NOT NULL,
  warehouse_id UUID NOT NULL,
  batch_id UUID,
  source_movement_id UUID NOT NULL REFERENCES stock_movements(id),
  layer_date DATE NOT NULL,
  quantity_in NUMERIC(18,4) NOT NULL CHECK (quantity_in > 0),
  unit_cost NUMERIC(18,4) NOT NULL CHECK (unit_cost >= 0),
  total_cost NUMERIC(18,4) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (item_id, company_id) REFERENCES items (id, company_id),
  FOREIGN KEY (warehouse_id, company_id) REFERENCES warehouses (id, company_id)
);
CREATE INDEX idx_valuation_layers_lookup ON stock_valuation_layers(company_id, item_id, warehouse_id, layer_date);

-- الكمية المتبقية في كل طبقة تُشتق دائمًا من مجموع الاستهلاكات، وليست عمودًا يُستبدَل،
-- لذلك لا حاجة لعمود remaining_quantity قابل للتعديل هنا (يُحافَظ على append-only حقيقي).
CREATE TABLE stock_valuation_consumptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  consuming_movement_id UUID NOT NULL REFERENCES stock_movements(id),
  valuation_layer_id UUID NOT NULL REFERENCES stock_valuation_layers(id),
  quantity_consumed NUMERIC(18,4) NOT NULL CHECK (quantity_consumed > 0),
  unit_cost_at_consumption NUMERIC(18,4) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_consumptions_layer ON stock_valuation_consumptions(valuation_layer_id);
CREATE INDEX idx_consumptions_movement ON stock_valuation_consumptions(consuming_movement_id);

-- منع أي UPDATE أو DELETE بنيويًا على دفتر الحركات ودفتر التقييم (append-only حقيقي، لا اتفاق برمجي فقط)
CREATE OR REPLACE FUNCTION forbid_ledger_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % not allowed on table %', TG_TABLE_NAME, TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stock_movements_no_update BEFORE UPDATE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
CREATE TRIGGER trg_stock_movements_no_delete BEFORE DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

CREATE TRIGGER trg_valuation_layers_no_update BEFORE UPDATE ON stock_valuation_layers
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
CREATE TRIGGER trg_valuation_layers_no_delete BEFORE DELETE ON stock_valuation_layers
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

CREATE TRIGGER trg_consumptions_no_update BEFORE UPDATE ON stock_valuation_consumptions
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
CREATE TRIGGER trg_consumptions_no_delete BEFORE DELETE ON stock_valuation_consumptions
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

-- StockBalance: جدول مُشتَق (Materialized) لأداء القراءة فقط، قابل لإعادة البناء الكامل من الدفاتر أعلاه.
-- يُسمح بتحديثه (ليس append-only) لأنه "كاش" وليس مصدر حقيقة.
CREATE TABLE stock_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  warehouse_id UUID NOT NULL,
  item_id UUID NOT NULL,
  batch_id UUID,
  quantity_on_hand NUMERIC(18,4) NOT NULL DEFAULT 0,
  quantity_reserved NUMERIC(18,4) NOT NULL DEFAULT 0,
  weighted_average_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  last_recalculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (warehouse_id, company_id) REFERENCES warehouses (id, company_id),
  FOREIGN KEY (item_id, company_id) REFERENCES items (id, company_id)
);
-- تفريد حسب الدفعة عند وجودها، وحسب الصنف/المخزن عند غيابها (فهرسان جزئيان بدل UNIQUE تقليدي)
CREATE UNIQUE INDEX uq_stock_balance_with_batch
  ON stock_balances(company_id, warehouse_id, item_id, batch_id) WHERE batch_id IS NOT NULL;
CREATE UNIQUE INDEX uq_stock_balance_no_batch
  ON stock_balances(company_id, warehouse_id, item_id) WHERE batch_id IS NULL;

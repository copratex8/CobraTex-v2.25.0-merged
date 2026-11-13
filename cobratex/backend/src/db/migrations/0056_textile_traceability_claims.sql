-- 0056_textile_traceability_claims.sql
-- (١) تتبّع الدفعات (Genealogy) ثنائي الاتجاه: لوطات الخامات/الخيوط التي صُرفت لكل أمر تصنيع (مورّد/لوط ألياف/رقم اللوط)
--     ← الأوامر ← الرولات المنتَجة ← أذون التسليم ← العملاء. يُسجَّل يدويًا عند الصرف لأن حركات المخزون لا تحمل اللوط دائمًا.
-- (٢) مطالبات/شكاوى العملاء الجودية مرتبطة بالرول/وحدة التعبئة/إذن التسليم مع السبب الجذري والتسوية.
CREATE TABLE order_material_lots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  production_order_id UUID NOT NULL,
  item_id UUID NOT NULL,
  lot_ref TEXT NOT NULL CHECK (length(btrim(lot_ref)) > 0),
  fiber_lot_id UUID,
  supplier_id UUID,
  quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (production_order_id, item_id, lot_ref),
  FOREIGN KEY (production_order_id, company_id) REFERENCES production_orders (id, company_id),
  FOREIGN KEY (item_id, company_id) REFERENCES items (id, company_id),
  FOREIGN KEY (fiber_lot_id, company_id) REFERENCES fiber_lots (id, company_id)
);
CREATE INDEX idx_oml_lot ON order_material_lots(company_id, lot_ref);
CREATE INDEX idx_oml_order ON order_material_lots(production_order_id);

CREATE TABLE quality_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID NOT NULL,
  claim_no TEXT NOT NULL,
  customer_id UUID NOT NULL,
  claim_date DATE NOT NULL,
  delivery_note_id UUID,
  fabric_roll_id UUID,
  packing_unit_id UUID,
  category TEXT NOT NULL CHECK (category IN ('shade','defect','count','strength','shrinkage','width','gsm','contamination','packing','delay','other')),
  severity TEXT NOT NULL DEFAULT 'minor' CHECK (severity IN ('minor','major','critical')),
  claimed_quantity NUMERIC(14,3) CHECK (claimed_quantity IS NULL OR claimed_quantity > 0),
  claimed_unit TEXT CHECK (claimed_unit IS NULL OR claimed_unit IN ('kg','m')),
  claimed_value NUMERIC(18,4) CHECK (claimed_value IS NULL OR claimed_value >= 0),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','accepted','rejected','settled')),
  root_cause TEXT,
  root_cause_stage_id UUID,
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('credit_note','replacement','discount','return','none')),
  settled_value NUMERIC(18,4) CHECK (settled_value IS NULL OR settled_value >= 0),
  closed_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, claim_no),
  UNIQUE (id, company_id),
  CHECK ((claimed_quantity IS NULL) = (claimed_unit IS NULL)),
  CHECK (status NOT IN ('accepted','rejected','settled') OR root_cause IS NOT NULL OR status = 'rejected'),
  CHECK (status <> 'settled' OR (resolution IS NOT NULL AND settled_value IS NOT NULL)),
  CHECK ((status IN ('settled','rejected')) = (closed_at IS NOT NULL)),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (customer_id, company_id) REFERENCES customers (id, company_id),
  FOREIGN KEY (delivery_note_id, company_id) REFERENCES delivery_notes (id, company_id),
  FOREIGN KEY (fabric_roll_id) REFERENCES fabric_rolls (id),
  FOREIGN KEY (packing_unit_id) REFERENCES packing_units (id),
  FOREIGN KEY (root_cause_stage_id, company_id) REFERENCES textile_stages (id, company_id)
);
CREATE INDEX idx_claims_customer ON quality_claims(company_id, customer_id, claim_date);

ALTER TABLE order_material_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_claims ENABLE ROW LEVEL SECURITY;
INSERT INTO permissions(code) VALUES ('textile.trace.view'), ('textile.trace.manage'), ('textile.claims.view'), ('textile.claims.manage') ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_id, permission_id, scope)
SELECT r.id, p.id, 'all_branches' FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Owner' AND r.is_system_role = TRUE AND p.code IN ('textile.trace.view','textile.trace.manage','textile.claims.view','textile.claims.manage')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- 0054_textile_blend_recipes.sql
-- نسب الخيوط (وصفات الخلط/التركيب) لكل صنف وكل ماكينة، مع «تثبيت» غير قابل للتعديل وإصدارات جديدة عند تغيّر النسب.
-- وصفة بلا ماكينة = الافتراضية للصنف؛ وصفة بماكينة = تخصّ تلك الماكينة وتتقدّم على الافتراضية.
-- كل نطاق (صنف + ماكينة/افتراضي) له وصفة مثبَّتة واحدة «حالية» فقط؛ تثبيت إصدار جديد يُحيل السابق إلى superseded.
CREATE TABLE yarn_blend_recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  item_id UUID NOT NULL,
  machine_id UUID,
  name TEXT NOT NULL,
  version_no INT NOT NULL CHECK (version_no >= 1),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','locked','superseded')),
  waste_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (waste_percent >= 0 AND waste_percent < 100),
  parent_recipe_id UUID,
  change_reason TEXT,
  notes TEXT,
  locked_at TIMESTAMPTZ,
  locked_by UUID,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  FOREIGN KEY (item_id, company_id) REFERENCES items (id, company_id),
  FOREIGN KEY (machine_id, company_id) REFERENCES machines (id, company_id),
  FOREIGN KEY (parent_recipe_id, company_id) REFERENCES yarn_blend_recipes (id, company_id),
  CHECK ((status = 'draft') = (locked_at IS NULL))
);
CREATE UNIQUE INDEX uq_blend_version ON yarn_blend_recipes(company_id, item_id, COALESCE(machine_id, '00000000-0000-0000-0000-000000000000'::uuid), version_no);
CREATE UNIQUE INDEX uq_blend_current ON yarn_blend_recipes(company_id, item_id, COALESCE(machine_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status = 'locked';
CREATE INDEX idx_blend_lookup ON yarn_blend_recipes(company_id, item_id, machine_id);

CREATE TABLE yarn_blend_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  recipe_id UUID NOT NULL,
  yarn_item_id UUID NOT NULL,
  role TEXT NOT NULL DEFAULT 'main' CHECK (role IN ('main','warp','weft','pile','ground')),
  percent NUMERIC(7,4) NOT NULL CHECK (percent > 0 AND percent <= 100),
  notes TEXT,
  UNIQUE (recipe_id, yarn_item_id, role),
  FOREIGN KEY (recipe_id, company_id) REFERENCES yarn_blend_recipes (id, company_id) ON DELETE CASCADE,
  FOREIGN KEY (yarn_item_id, company_id) REFERENCES items (id, company_id)
);

-- التثبيت حقيقي على مستوى القاعدة: بنود وصفة غير مسودة لا تُضاف ولا تُعدَّل ولا تُحذف، والوصفة المثبَّتة لا يتغيّر صنفها/ماكينتها/هالكها.
CREATE FUNCTION trg_blend_lines_frozen() RETURNS trigger AS $$
DECLARE st TEXT; rid UUID;
BEGIN
  rid := COALESCE(NEW.recipe_id, OLD.recipe_id);
  SELECT status INTO st FROM yarn_blend_recipes WHERE id = rid;
  IF st IS NOT NULL AND st <> 'draft' THEN RAISE EXCEPTION 'الوصفة مثبَّتة ولا يمكن تعديل بنودها؛ أنشئ إصدارًا جديدًا' USING ERRCODE = '23514'; END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER blend_lines_frozen BEFORE INSERT OR UPDATE OR DELETE ON yarn_blend_lines FOR EACH ROW EXECUTE FUNCTION trg_blend_lines_frozen();

CREATE FUNCTION trg_blend_recipe_frozen() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'لا تُحذف وصفة مثبَّتة' USING ERRCODE = '23514'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (NEW.item_id <> OLD.item_id OR NEW.machine_id IS DISTINCT FROM OLD.machine_id OR NEW.waste_percent <> OLD.waste_percent OR NEW.version_no <> OLD.version_no OR NEW.name <> OLD.name) THEN
    RAISE EXCEPTION 'الوصفة مثبَّتة ولا يمكن تعديلها؛ أنشئ إصدارًا جديدًا' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'superseded' AND NEW.status <> 'superseded' THEN RAISE EXCEPTION 'إصدار قديم لا يُعاد تفعيله' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER blend_recipe_frozen BEFORE UPDATE OR DELETE ON yarn_blend_recipes FOR EACH ROW EXECUTE FUNCTION trg_blend_recipe_frozen();

ALTER TABLE production_orders ADD COLUMN blend_recipe_id UUID;
ALTER TABLE production_orders ADD FOREIGN KEY (blend_recipe_id, company_id) REFERENCES yarn_blend_recipes (id, company_id);
CREATE INDEX idx_production_orders_blend ON production_orders(company_id, blend_recipe_id) WHERE blend_recipe_id IS NOT NULL;

ALTER TABLE yarn_blend_recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE yarn_blend_lines ENABLE ROW LEVEL SECURITY;
INSERT INTO permissions(code) VALUES ('textile.blend.view'), ('textile.blend.manage'), ('textile.blend.lock') ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions(role_id, permission_id, scope)
SELECT r.id, p.id, 'all_branches' FROM roles r CROSS JOIN permissions p
WHERE r.name = 'Owner' AND r.is_system_role = TRUE AND p.code IN ('textile.blend.view','textile.blend.manage','textile.blend.lock')
ON CONFLICT (role_id, permission_id) DO NOTHING;

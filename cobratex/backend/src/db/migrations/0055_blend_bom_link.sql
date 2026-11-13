-- 0055_blend_bom_link.sql — توليد قائمة المواد (BOM) من وصفة نسب مثبَّتة: ربط BOM بالوصفة التي ولّدته (واحدة لكل وصفة).
ALTER TABLE bill_of_materials ADD COLUMN blend_recipe_id UUID;
ALTER TABLE bill_of_materials ADD FOREIGN KEY (blend_recipe_id, company_id) REFERENCES yarn_blend_recipes (id, company_id);
CREATE UNIQUE INDEX uq_bom_per_blend_recipe ON bill_of_materials(company_id, blend_recipe_id) WHERE blend_recipe_id IS NOT NULL;

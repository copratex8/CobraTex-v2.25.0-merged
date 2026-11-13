-- 0035_manufacturing_toggle_and_waste.sql
--
-- (١) فصل التصنيع عن البرنامج الأساسي: التصنيع كان مبنيًا بالفعل كوحدة مستقلة تمامًا (لا أي ملف
-- خارج backend/src/modules/manufacturing و frontend/src/features/manufacturing يستورد من كودها —
-- فقط app.ts وbootstrapRoutes.ts وApp.tsx/AppLayout.tsx تربطها بسلك توصيل، لا منطق عمل). الناقص كان
-- مفتاح تشغيل/إيقاف حي بلا حذف كود. الآن: is_manufacturing_enabled على الشركة، يُتحقَّق منه في بداية
-- كل دالة بالوحدة (raise كأن الوحدة غير موجودة عند الإيقاف). لإزالتها فعليًا من الكود لاحقًا: حذف
-- backend/src/modules/manufacturing/ وfrontend/src/features/manufacturing/ وسطر التسجيل في app.ts
-- وأسطر الاستيراد/المسارات في App.tsx وAppLayout.tsx، وسطري seedAccount/seedPostingRule الخاصّين
-- بالتصنيع في bootstrapRoutes.ts — بلا أي أثر آخر في الباقي.
ALTER TABLE companies ADD COLUMN manufacturing_enabled BOOLEAN NOT NULL DEFAULT true;

-- (٢) نسبة هالك لكل سطر BOM: بعض المكوّنات (خيط في النسيج مثلًا) تُفقَد نسبة منها فعليًا أثناء
-- التشغيل فوق الكمية النظرية. 5.00 تعني 5%. تُطبَّق على كمية السطر عند إنشاء أمر التصنيع
-- (الكمية المخطَّطة = الكمية النظرية × (1 + النسبة/100))، وتُنسَخ لسطر الأمر للتوثيق والعرض.
ALTER TABLE bom_lines ADD COLUMN waste_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (waste_percent >= 0 AND waste_percent < 100);
ALTER TABLE production_order_lines ADD COLUMN waste_percent NUMERIC(5,2) NOT NULL DEFAULT 0;

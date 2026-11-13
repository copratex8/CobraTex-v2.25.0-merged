-- 0008_switch_valuation_to_weighted_average.sql
-- تصحيح مطلوب في المراجعة: القرار الرسمي للمشروع (REQUIREMENTS.md §7, DECISIONS.md #5) هو
-- المتوسط المرجح (Weighted Average)، بينما الكود السابق نفّذ FIFO عبر طبقات تقييم منفصلة.
-- هذا خلط بين طريقتين، وهو ممنوع صراحة. الحل: اعتماد Weighted Average فعليًا، وحذف جداول
-- طبقات FIFO التي لم تُستخدم بعد في أي بيانات إنتاجية (لا خسارة بيانات حقيقية).
--
-- التصميم الجديد: stock_movements يبقى دفتر الحركة الوحيد append-only (لم يتغير)، ويحمل الآن
-- unit_cost دائمًا (لحركات الوارد: التكلفة المُدخَلة؛ لحركات الصرف: متوسط التكلفة الفعلي وقت
-- الصرف، مُسجَّلًا على الحركة نفسها للتدقيق). stock_balances يبقى الكاش المُشتق القابل لإعادة
-- البناء الكامل عبر إعادة تشغيل (replay) كل الحركات بالترتيب الزمني وحساب المتوسط المرجح تراكميًا
-- — لا حاجة لجدول طبقات منفصل مع هذه الطريقة.

DROP TRIGGER IF EXISTS trg_consumptions_no_update ON stock_valuation_consumptions;
DROP TRIGGER IF EXISTS trg_consumptions_no_delete ON stock_valuation_consumptions;
DROP TRIGGER IF EXISTS trg_valuation_layers_no_update ON stock_valuation_layers;
DROP TRIGGER IF EXISTS trg_valuation_layers_no_delete ON stock_valuation_layers;

DROP TABLE IF EXISTS stock_valuation_consumptions;
DROP TABLE IF EXISTS stock_valuation_layers;

-- unit_cost إلزامي الآن لكل حركة (وارد: التكلفة المُدخَلة، صرف: المتوسط وقت الصرف)
ALTER TABLE stock_movements ALTER COLUMN unit_cost SET NOT NULL;
ALTER TABLE stock_movements ADD CONSTRAINT chk_stock_movements_unit_cost_nonneg CHECK (unit_cost >= 0);

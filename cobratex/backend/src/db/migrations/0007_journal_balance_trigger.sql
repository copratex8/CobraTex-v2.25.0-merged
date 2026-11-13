-- 0007_journal_balance_trigger.sql
-- تصحيح جوهري مطلوب في المراجعة: توازن القيد لا يمكن فرضه بـ CHECK عادي (يعمل على الصف
-- الواحد فقط). الحل: Deferred Constraint Trigger يعمل عند COMMIT بعد اكتمال كل الأسطر.

-- (أ) عند إدراج/تعديل/حذف أي سطر قيد: تحقق من توازن مجموع القيد الذي يتبعه هذا السطر،
--     لكن فقط إذا كان القيد بحالة posted (القيود Draft يُسمح لها بعدم التوازن أثناء التحرير).
CREATE OR REPLACE FUNCTION check_journal_balance_from_line() RETURNS TRIGGER AS $$
DECLARE
  v_entry_id UUID;
  v_status TEXT;
  v_total_debit NUMERIC(18,4);
  v_total_credit NUMERIC(18,4);
  v_line_count INT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_entry_id := OLD.journal_entry_id;
  ELSE
    v_entry_id := NEW.journal_entry_id;
  END IF;

  SELECT status INTO v_status FROM journal_entries WHERE id = v_entry_id;

  IF v_status = 'posted' THEN
    SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0), COUNT(*)
      INTO v_total_debit, v_total_credit, v_line_count
      FROM journal_lines WHERE journal_entry_id = v_entry_id;

    IF v_line_count = 0 THEN
      RAISE EXCEPTION 'قيد محاسبي مرحّل بلا أسطر: %', v_entry_id;
    END IF;

    IF v_total_debit <> v_total_credit THEN
      RAISE EXCEPTION 'قيد محاسبي غير متوازن (مرحّل): % — مدين=% دائن=%',
        v_entry_id, v_total_debit, v_total_credit;
    END IF;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_journal_line_balance
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_journal_balance_from_line();

-- (ب) عند تحديث/إدراج رأس القيد نفسه (مثال: تغيير الحالة إلى posted بعد أن كانت الأسطر
--     مكتملة مسبقًا دون أي INSERT/UPDATE جديد على journal_lines فيؤدي ذلك لعدم إطلاق المشغّل أعلاه):
CREATE OR REPLACE FUNCTION check_journal_balance_from_entry() RETURNS TRIGGER AS $$
DECLARE
  v_total_debit NUMERIC(18,4);
  v_total_credit NUMERIC(18,4);
  v_line_count INT;
BEGIN
  IF NEW.status = 'posted' THEN
    SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0), COUNT(*)
      INTO v_total_debit, v_total_credit, v_line_count
      FROM journal_lines WHERE journal_entry_id = NEW.id;

    IF v_line_count = 0 THEN
      RAISE EXCEPTION 'قيد محاسبي مرحّل بلا أسطر: %', NEW.id;
    END IF;

    IF v_total_debit <> v_total_credit THEN
      RAISE EXCEPTION 'قيد محاسبي غير متوازن (مرحّل): % — مدين=% دائن=%',
        NEW.id, v_total_debit, v_total_credit;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_journal_entry_status_balance
  AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_journal_balance_from_entry();

-- منع تعديل/حذف قيد بحالة posted مباشرة (التعديل الوحيد المسموح هو عكس موثّق عبر قيد جديد)
CREATE OR REPLACE FUNCTION forbid_posted_journal_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'posted' AND TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'لا يمكن حذف قيد مرحّل: %', OLD.id;
  END IF;
  IF OLD.status = 'posted' AND TG_OP = 'UPDATE' THEN
    -- يُسمح فقط بتحديث الحالة إلى reversed أو تعبئة حقول الإلغاء المرتبطة بالعكس،
    -- لا يُسمح بأي تعديل آخر على قيد مرحّل (مبالغ/حسابات/تاريخ).
    IF NEW.status NOT IN ('posted','reversed') THEN
      RAISE EXCEPTION 'لا يمكن تغيير حالة قيد مرحّل إلا إلى reversed: %', OLD.id;
    END IF;
    IF NEW.entry_date <> OLD.entry_date OR NEW.currency_code <> OLD.currency_code THEN
      RAISE EXCEPTION 'لا يمكن تعديل بيانات قيد مرحّل: %', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_forbid_posted_journal_mutation
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_posted_journal_mutation();

-- 0010_journal_lifecycle_hardening.sql

-- (أ) تشديد حماية القيد المرحّل: منع تعديل أي حقل جوهري (لا فقط التاريخ/العملة كما في 0007)،
--     والسماح فقط بالانتقال إلى reversed، وفقط إذا وُجد قيد عكسي متوازن مرتبط فعلًا عبر reversal_of_entry_id.
CREATE OR REPLACE FUNCTION forbid_posted_journal_mutation() RETURNS TRIGGER AS $$
DECLARE
  v_has_reversal BOOLEAN;
BEGIN
  IF OLD.status = 'posted' AND TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'لا يمكن حذف قيد مرحّل: %', OLD.id;
  END IF;

  IF OLD.status = 'posted' AND TG_OP = 'UPDATE' THEN
    IF NEW.status NOT IN ('posted','reversed') THEN
      RAISE EXCEPTION 'لا يمكن تغيير حالة قيد مرحّل إلا إلى reversed: %', OLD.id;
    END IF;

    -- أي تغيير في الحقول الجوهرية ممنوع كليًا، حتى عند الانتقال إلى reversed
    IF NEW.company_id <> OLD.company_id OR NEW.branch_id <> OLD.branch_id
       OR COALESCE(NEW.activity_id::text,'') <> COALESCE(OLD.activity_id::text,'')
       OR COALESCE(NEW.project_id::text,'') <> COALESCE(OLD.project_id::text,'')
       OR NEW.fiscal_period_id <> OLD.fiscal_period_id
       OR NEW.entry_date <> OLD.entry_date
       OR NEW.currency_code <> OLD.currency_code
       OR NEW.exchange_rate <> OLD.exchange_rate
       OR COALESCE(NEW.source_document_type,'') <> COALESCE(OLD.source_document_type,'')
       OR COALESCE(NEW.source_document_id::text,'') <> COALESCE(OLD.source_document_id::text,'')
    THEN
      RAISE EXCEPTION 'لا يمكن تعديل بيانات قيد مرحّل: %', OLD.id;
    END IF;

    IF NEW.status = 'reversed' THEN
      SELECT EXISTS(
        SELECT 1 FROM journal_entries
        WHERE reversal_of_entry_id = OLD.id AND company_id = OLD.company_id AND status = 'posted'
      ) INTO v_has_reversal;
      IF NOT v_has_reversal THEN
        RAISE EXCEPTION 'لا يمكن تحويل القيد % إلى reversed بدون قيد عكسي متوازن مرتبط فعليًا عبر reversal_of_entry_id', OLD.id;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- (الـ trigger نفسه trg_forbid_posted_journal_mutation من migration 0007 يستخدم هذه الدالة تلقائيًا بعد CREATE OR REPLACE)

-- (ب) منع أي تعديل أو حذف على أسطر قيد مرحّل أو معكوس (سواء بتغيير المبلغ أو بنقل السطر لقيد آخر)
CREATE OR REPLACE FUNCTION forbid_posted_journal_line_mutation() RETURNS TRIGGER AS $$
DECLARE
  v_old_status TEXT;
  v_new_status TEXT;
BEGIN
  SELECT status INTO v_old_status FROM journal_entries WHERE id = OLD.journal_entry_id;

  IF v_old_status IN ('posted','reversed') THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'لا يمكن حذف سطر من قيد مرحّل: %', OLD.journal_entry_id;
    END IF;
    RAISE EXCEPTION 'لا يمكن تعديل سطر من قيد مرحّل: %', OLD.journal_entry_id;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.journal_entry_id <> OLD.journal_entry_id THEN
    SELECT status INTO v_new_status FROM journal_entries WHERE id = NEW.journal_entry_id;
    IF v_new_status IN ('posted','reversed') THEN
      RAISE EXCEPTION 'لا يمكن نقل سطر إلى قيد مرحّل: %', NEW.journal_entry_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_forbid_posted_journal_line_mutation
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_posted_journal_line_mutation();

-- (ج) تصحيح: عند إعادة تعيين journal_entry_id لسطر (UPDATE)، افحص توازن القيد القديم
--     والجديد معًا ضمن نفس المعاملة المؤجَّلة (دفاع متعدد الطبقات، حتى لو عُطِّل المشغّل (ب) أعلاه
--     مؤقتًا لأي سبب إداري استثنائي).
CREATE OR REPLACE FUNCTION check_single_journal_entry_balance(p_entry_id UUID) RETURNS VOID AS $$
DECLARE
  v_status TEXT;
  v_total_debit NUMERIC(18,4);
  v_total_credit NUMERIC(18,4);
  v_line_count INT;
BEGIN
  SELECT status INTO v_status FROM journal_entries WHERE id = p_entry_id;
  IF v_status = 'posted' THEN
    SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0), COUNT(*)
      INTO v_total_debit, v_total_credit, v_line_count
      FROM journal_lines WHERE journal_entry_id = p_entry_id;

    IF v_line_count = 0 THEN
      RAISE EXCEPTION 'قيد محاسبي مرحّل بلا أسطر: %', p_entry_id;
    END IF;
    IF v_total_debit <> v_total_credit THEN
      RAISE EXCEPTION 'قيد محاسبي غير متوازن (مرحّل): % — مدين=% دائن=%', p_entry_id, v_total_debit, v_total_credit;
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION check_journal_balance_from_line() RETURNS TRIGGER AS $$
DECLARE
  v_entry_id UUID;
  v_second_entry_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_entry_id := OLD.journal_entry_id;
  ELSIF TG_OP = 'UPDATE' AND NEW.journal_entry_id <> OLD.journal_entry_id THEN
    v_entry_id := NEW.journal_entry_id;
    v_second_entry_id := OLD.journal_entry_id;
  ELSE
    v_entry_id := NEW.journal_entry_id;
  END IF;

  PERFORM check_single_journal_entry_balance(v_entry_id);
  IF v_second_entry_id IS NOT NULL THEN
    PERFORM check_single_journal_entry_balance(v_second_entry_id);
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

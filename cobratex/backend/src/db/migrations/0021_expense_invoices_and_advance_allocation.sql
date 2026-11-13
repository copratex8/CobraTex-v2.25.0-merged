-- 0021_expense_invoices_and_advance_allocation.sql
-- المرحلة: فواتير المصروفات غير المخزنية + تخصيص الدفعة المقدمة لاحقًا لفاتورة/فواتير.
--
-- قرار تصميم صريح لفاتورة المصروفات (لم يكن موثّقًا سابقًا، اتُّخذ الآن بوضوح):
-- الفاتورة إما مرتبطة بمورد (supplier_id) فتُقيَّد كالتزام (دائن حساب المورد الفرعي، تُسدَّد لاحقًا
-- عبر نفس دورة supplier_payments/التخصيص)، أو غير مرتبطة بمورد وتُدفَع فورًا من حساب خزينة/بنك
-- محدَّد (paid_from_account_id) — الحالتان متنافيتان بقيد CHECK صريح، لا حالة وسطى غامضة.
--
-- ملاحظة مهمة (موثَّقة بالتفصيل في تقرير هذه المرحلة): فروق عملة الموردين/العملاء **لم تُنفَّذ**
-- في هذه المرحلة عمدًا رغم أنها كانت مطلوبة — الفحص الفعلي للكود أظهر أن exchange_rate لا
-- يُستخدَم لتحويل أي مبلغ قيد فعليًا في أي وحدة (فواتير البيع/الشراء/الدفعات كلها تُرحِّل القيمة
-- الاسمية مباشرة بصرف النظر عن العملة)، فإضافة "فرق عملة" الآن كانت ستُنتج رقمًا غير قابل
-- للتصالح مع بقية الدفتر — ميزة شكلية لا قيمة محاسبية حقيقية لها. القرار الهندسي الصريح: تأجيلها
-- حتى تُوحَّد آلية تحويل العملة عبر كل الوحدات أولًا (بند مستقل في خطة المرحلة القادمة).

CREATE TABLE expense_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  branch_id UUID NOT NULL,
  supplier_id UUID,
  paid_from_account_id UUID,
  fiscal_period_id UUID NOT NULL,
  document_number TEXT NOT NULL,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  exchange_rate NUMERIC(18,6) NOT NULL DEFAULT 1,
  invoice_date DATE NOT NULL,
  description TEXT,
  activity_id UUID,
  project_id UUID,
  cost_center_id UUID,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled','reversed')),
  journal_entry_id UUID REFERENCES journal_entries(id),
  reversal_of_invoice_id UUID REFERENCES expense_invoices(id),
  cancelled_reason TEXT,
  cancelled_by UUID,
  cancelled_at TIMESTAMPTZ,
  created_by UUID,
  posted_by UUID,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, branch_id, document_number),
  CHECK (
    (supplier_id IS NOT NULL AND paid_from_account_id IS NULL) OR
    (supplier_id IS NULL AND paid_from_account_id IS NOT NULL)
  ),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id),
  FOREIGN KEY (supplier_id, company_id) REFERENCES suppliers (id, company_id),
  FOREIGN KEY (paid_from_account_id, company_id) REFERENCES accounts (id, company_id),
  FOREIGN KEY (fiscal_period_id, company_id) REFERENCES fiscal_periods (id, company_id),
  FOREIGN KEY (activity_id, company_id) REFERENCES activities (id, company_id),
  FOREIGN KEY (project_id, company_id) REFERENCES projects (id, company_id),
  FOREIGN KEY (cost_center_id, company_id) REFERENCES cost_centers (id, company_id)
);

CREATE TABLE expense_invoice_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_invoice_id UUID NOT NULL REFERENCES expense_invoices(id),
  company_id UUID NOT NULL,
  expense_account_id UUID NOT NULL, -- حساب المصروف المباشر؛ لا صنف ولا حركة مخزون لهذا المستند
  description TEXT NOT NULL,
  amount NUMERIC(18,4) NOT NULL CHECK (amount > 0), -- المبلغ قبل الخصم/الضريبة (سعر × كمية مجمَّعين هنا كرقم واحد، لا كمية/سعر منفصلين لأنها خدمة لا صنف)
  discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
  tax_type_id UUID,
  subtotal NUMERIC(18,4) NOT NULL,
  tax_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
  line_total NUMERIC(18,4) NOT NULL,
  FOREIGN KEY (expense_account_id, company_id) REFERENCES accounts (id, company_id),
  FOREIGN KEY (tax_type_id, company_id) REFERENCES tax_types (id, company_id)
);
CREATE INDEX idx_expense_invoice_lines_invoice ON expense_invoice_lines(expense_invoice_id);

-- تتبّع فرق العملة لكل تخصيص (مبقًى على 0 حاليًا لعدم تفعيل الحساب بعد — راجع الملاحظة أعلاه)،
-- يُضاف الآن كعمود بدل تعديل مزدوج للجدول لاحقًا عند تفعيل فروق العملة فعليًا.
ALTER TABLE customer_payment_allocations ADD COLUMN fx_difference_amount NUMERIC(18,4) NOT NULL DEFAULT 0;
ALTER TABLE supplier_payment_allocations ADD COLUMN fx_difference_amount NUMERIC(18,4) NOT NULL DEFAULT 0;

INSERT INTO permissions(code) VALUES
  ('purchasing.expense_invoice.create'), ('purchasing.expense_invoice.view'),
  ('purchasing.expense_invoice.post'), ('purchasing.expense_invoice.reverse'),
  ('sales.payment.allocate'), ('purchasing.payment.allocate')
ON CONFLICT (code) DO NOTHING;

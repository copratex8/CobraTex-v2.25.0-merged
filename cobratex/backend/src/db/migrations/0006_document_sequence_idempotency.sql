-- 0006_document_sequence_idempotency.sql

CREATE TABLE document_sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  branch_id UUID,
  document_type TEXT NOT NULL,
  prefix TEXT NOT NULL DEFAULT '',
  next_number BIGINT NOT NULL DEFAULT 1,
  reset_policy TEXT NOT NULL DEFAULT 'never' CHECK (reset_policy IN ('never','yearly','monthly')),
  FOREIGN KEY (branch_id, company_id) REFERENCES branches (id, company_id)
);
-- تصحيح مطلوب: UNIQUE تقليدي على (company_id, branch_id, document_type) لا يمنع تكرار الصفوف
-- التي branch_id فيها NULL، لأن NULL لا يساوي NULL في مقارنات UNIQUE القياسية.
-- الحل: فهرسان جزئيان منفصلان لمستندات مستوى الفرع ومستندات مستوى الشركة.
CREATE UNIQUE INDEX uq_doc_seq_branch_level
  ON document_sequences(company_id, branch_id, document_type) WHERE branch_id IS NOT NULL;
CREATE UNIQUE INDEX uq_doc_seq_company_level
  ON document_sequences(company_id, document_type) WHERE branch_id IS NULL;

CREATE TABLE idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INT,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, idempotency_key, endpoint)
);

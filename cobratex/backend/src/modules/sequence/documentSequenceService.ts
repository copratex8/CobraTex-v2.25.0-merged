import { PoolClient } from 'pg';
import { pool, withTransaction } from '@/db/pool';

interface GetNextNumberParams {
  companyId: string;
  branchId: string | null;
  documentType: string;
  prefix?: string;
}

/**
 * يضمن رقمًا فريدًا متسلسلًا بلا فجوة وبلا تكرار حتى مع طلبات متزامنة، عبر قفل صف صريح
 * (SELECT ... FOR UPDATE) ضمن نفس المعاملة التي تُنشئ المستند (راجع ARCHITECTURE.md §6).
 * يفصل صراحة بين تسلسل مستوى الفرع (branch_id NOT NULL) وتسلسل مستوى الشركة (branch_id NULL)
 * تماشيًا مع الفهرسين الجزئيين في migration 0006 (يمنع تعارض NULL في UNIQUE التقليدي).
 */
export async function getNextDocumentNumber(
  params: GetNextNumberParams,
  externalClient?: PoolClient,
): Promise<string> {
  const run = async (client: PoolClient) => {
    const branchCondition = params.branchId
      ? 'branch_id = $2'
      : 'branch_id IS NULL';
    const values = params.branchId
      ? [params.companyId, params.branchId, params.documentType]
      : [params.companyId, params.documentType];
    const docTypeIdx = params.branchId ? 3 : 2;

    const existing = await client.query(
      `SELECT id, next_number, prefix FROM document_sequences
       WHERE company_id = $1 AND ${branchCondition} AND document_type = $${docTypeIdx}
       FOR UPDATE`,
      values,
    );

    let sequenceId: string;
    let nextNumber: number;
    let prefix: string;

    if (existing.rows.length === 0) {
      prefix = params.prefix ?? '';
      nextNumber = 1;
      const inserted = await client.query(
        `INSERT INTO document_sequences(company_id, branch_id, document_type, prefix, next_number)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [params.companyId, params.branchId, params.documentType, prefix, nextNumber + 1],
      );
      sequenceId = inserted.rows[0].id;
    } else {
      sequenceId = existing.rows[0].id;
      nextNumber = existing.rows[0].next_number;
      prefix = existing.rows[0].prefix;
      await client.query(
        `UPDATE document_sequences SET next_number = next_number + 1 WHERE id = $1`,
        [sequenceId],
      );
    }

    return `${prefix}${String(nextNumber).padStart(6, '0')}`;
  };

  if (externalClient) return run(externalClient);
  return withTransaction(run);
}

export { pool as _poolForTests };

import { PoolClient } from 'pg';
import { RequestContext } from '@/shared/requestContext';
import { ValidationError } from '@/shared/errors';
import { createDraftJournalEntry, transitionJournalEntryStatus, JournalLineInput } from '@/modules/accounting/accountingService';

/** الفترة المالية المفتوحة التي تغطي التاريخ، وإلا رفض صريح. */
export async function openPeriodFor(client: PoolClient, companyId: string, date: string): Promise<string> {
  const p = (await client.query(`SELECT id, status FROM fiscal_periods WHERE company_id=$1 AND start_date<=$2 AND end_date>=$2 LIMIT 1`, [companyId, date])).rows[0];
  if (!p) throw new ValidationError(`لا توجد فترة مالية تغطي التاريخ ${date}`);
  if (p.status !== 'open') throw new ValidationError(`الفترة المالية لتاريخ ${date} مغلقة`);
  return p.id;
}

/** قيد بعملة الأساس بسعر 1 ويُرحَّل عبر دورة الحياة الكاملة (مسودة ← مراجعة ← معتمد ← مرحَّل) داخل معاملة المستدعي. */
export async function postBaseEntry(ctx: RequestContext, client: PoolClient, a: { branchId: string; date: string; lines: JournalLineInput[]; sourceType: string; sourceId?: string }) {
  const base = (await client.query(`SELECT base_currency_code FROM companies WHERE id=$1`, [ctx.companyId])).rows[0].base_currency_code;
  const fiscalPeriodId = await openPeriodFor(client, ctx.companyId, a.date);
  const e = await createDraftJournalEntry(ctx, { branchId: a.branchId, fiscalPeriodId, entryDate: a.date, currencyCode: base, exchangeRate: '1', sourceDocumentType: a.sourceType, sourceDocumentId: a.sourceId, lines: a.lines }, client);
  await transitionJournalEntryStatus(ctx, e.id, 'pending_review', undefined, client);
  await transitionJournalEntryStatus(ctx, e.id, 'approved', undefined, client);
  await transitionJournalEntryStatus(ctx, e.id, 'posted', undefined, client);
  return e.id as string;
}

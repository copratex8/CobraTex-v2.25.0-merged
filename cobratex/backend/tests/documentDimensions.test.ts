import { describe, it, expect } from 'vitest';
import { pool } from '@/db/pool';
import { createCustomer } from '@/modules/sales/customerService';
import { createTaxType } from '@/modules/accounting/taxService';
import { createPostingRule } from '@/modules/accounting/accountingService';
import { recordInMovement } from '@/modules/inventory/stockService';
import { createSalesInvoice, postSalesInvoice } from '@/modules/sales/salesInvoiceService';
import { createFullTenantStack, createAccountAndFiscalPeriod, createItemCategoryWithAccounts, createBaseItem } from './helpers';

async function createActivityAndProject(companyId: string) {
  const activity = await pool.query(
    `INSERT INTO activities(company_id, name_ar, name_en) VALUES ($1,'نشاط تجريبي','Demo Activity') RETURNING id`,
    [companyId],
  );
  const project = await pool.query(
    `INSERT INTO projects(company_id, name_ar, name_en) VALUES ($1,'مشروع تجريبي','Demo Project') RETURNING id`,
    [companyId],
  );
  const costCenter = await pool.query(
    `INSERT INTO cost_centers(company_id, name) VALUES ($1,'مركز تكلفة تجريبي') RETURNING id`,
    [companyId],
  );
  return { activityId: activity.rows[0].id, projectId: project.rows[0].id, costCenterId: costCenter.rows[0].id };
}

describe('أبعاد النشاط/المشروع/مركز التكلفة على المستندات', () => {
  it('تنتقل من فاتورة البيع إلى حركة المخزون والقيد المحاسبي معًا عند الترحيل', async () => {
    const stack = await createFullTenantStack('dim-propagate');
    const { revenueAccountId, inventoryAccountId, cogsAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
    const { categoryId } = await createItemCategoryWithAccounts(stack.companyId, inventoryAccountId, cogsAccountId);
    const { itemId, uomId } = await createBaseItem(stack.companyId);
    await pool.query(`UPDATE items SET category_id=$1 WHERE id=$2`, [categoryId, itemId]);
    const { activityId, projectId, costCenterId } = await createActivityAndProject(stack.companyId);
    const customer = await createCustomer(stack.ctx, { code: 'DIM-C1', nameAr: 'ع', nameEn: 'C', currencyCode: 'EGP' });

    await createPostingRule(stack.ctx, {
      operationType: 'sales_invoice_revenue',
      debitAccountSourceType: 'CUSTOMER_RECEIVABLE',
      creditAccountSourceType: 'FIXED_ACCOUNT', creditFixedAccountId: revenueAccountId,
    });
    await createPostingRule(stack.ctx, {
      operationType: 'sales_invoice_cogs',
      debitAccountSourceType: 'ITEM_CATEGORY_COGS', creditAccountSourceType: 'ITEM_CATEGORY_INVENTORY',
    });

    await recordInMovement(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, itemId,
      quantity: '50', unitCost: '10', movementDate: '2026-01-01', sourceDocumentType: 'opening',
    });

    const invoice = await createSalesInvoice(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, customerId: customer.id,
      fiscalPeriodId, currencyCode: 'EGP', invoiceDate: '2026-02-01',
      activityId, projectId, costCenterId,
      lines: [{ itemId, uomId, quantity: '5', unitPrice: '20' }],
    });

    const invoiceRow = await pool.query(`SELECT activity_id, project_id, cost_center_id FROM sales_invoices WHERE id=$1`, [invoice.id]);
    expect(invoiceRow.rows[0].activity_id).toBe(activityId);
    expect(invoiceRow.rows[0].project_id).toBe(projectId);
    expect(invoiceRow.rows[0].cost_center_id).toBe(costCenterId);

    const result = await postSalesInvoice(stack.ctx, invoice.id);

    const movement = await pool.query(
      `SELECT activity_id, project_id FROM stock_movements WHERE source_document_type='sales_invoice' AND source_document_id=$1`,
      [invoice.id],
    );
    expect(movement.rows[0].activity_id).toBe(activityId);
    expect(movement.rows[0].project_id).toBe(projectId);

    const journalEntry = await pool.query(`SELECT activity_id, project_id FROM journal_entries WHERE id=$1`, [result.journalEntryId]);
    expect(journalEntry.rows[0].activity_id).toBe(activityId);
    expect(journalEntry.rows[0].project_id).toBe(projectId);

    const journalLines = await pool.query(`SELECT cost_center_id FROM journal_lines WHERE journal_entry_id=$1`, [result.journalEntryId]);
    expect(journalLines.rows.every((l) => l.cost_center_id === costCenterId)).toBe(true);
  });

  it('يمنع بنيويًا ربط مستند بنشاط أو مشروع تابع لشركة أخرى (قيد FK مركّب)', async () => {
    const companyA = await createFullTenantStack('dim-iso-a');
    const companyB = await createFullTenantStack('dim-iso-b');
    const { activityId: activityOfB } = await createActivityAndProject(companyB.companyId);
    const { fiscalPeriodId } = await createAccountAndFiscalPeriod(companyA.companyId);
    const customer = await createCustomer(companyA.ctx, { code: 'DIM-ISO-C', nameAr: 'ع', nameEn: 'C', currencyCode: 'EGP' });
    const { itemId, uomId } = await createBaseItem(companyA.companyId);

    await expect(
      createSalesInvoice(companyA.ctx, {
        branchId: companyA.branchId, warehouseId: companyA.warehouseId, customerId: customer.id,
        fiscalPeriodId, currencyCode: 'EGP', invoiceDate: '2026-02-01',
        activityId: activityOfB, // نشاط تابع لشركة أخرى
        lines: [{ itemId, uomId, quantity: '1', unitPrice: '10' }],
      }),
    ).rejects.toThrow(); // فشل قيد FK المركّب (activity_id, company_id)
  });

  it('لا تسرّب بين فرعين مختلفين لنفس الشركة عند تصفية حركات مخزون بالنشاط/المشروع', async () => {
    const stack = await createFullTenantStack('dim-branch-iso');
    const { activityId: activityX } = await createActivityAndProject(stack.companyId);
    const { activityId: activityY } = await createActivityAndProject(stack.companyId);
    const { itemId } = await createBaseItem(stack.companyId);

    await recordInMovement(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, itemId,
      quantity: '10', unitCost: '5', movementDate: '2026-01-01', sourceDocumentType: 'test', activityId: activityX,
    });
    await recordInMovement(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, itemId,
      quantity: '20', unitCost: '5', movementDate: '2026-01-02', sourceDocumentType: 'test', activityId: activityY,
    });

    const forX = await pool.query(`SELECT count(*) FROM stock_movements WHERE company_id=$1 AND activity_id=$2`, [stack.companyId, activityX]);
    const forY = await pool.query(`SELECT count(*) FROM stock_movements WHERE company_id=$1 AND activity_id=$2`, [stack.companyId, activityY]);
    expect(forX.rows[0].count).toBe('1');
    expect(forY.rows[0].count).toBe('1'); // لا اختلاط بين النشاطين رغم نفس الشركة/الفرع/الصنف
  });
});

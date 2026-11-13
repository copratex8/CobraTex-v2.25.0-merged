import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { pool } from '@/db/pool';

const app = createApp();

describe('بذرة الإعداد الأول (/bootstrap): دليل حسابات + قواعد ترحيل + فترة مالية + خزينة افتراضية', () => {
  it('شركة جديدة تمامًا (بلا أي إعداد يدوي إضافي) تستطيع ترحيل فاتورة بيع كاملة فورًا', async () => {
    const boot = await request(app).post('/api/bootstrap').send({
      tenantName: 'شركة بذرة', companyLegalName: 'شركة بذرة', ownerEmail: `seed-${Date.now()}@test.local`, ownerPassword: 'Seed@12345',
    });
    expect(boot.status).toBe(201);
    expect(boot.body.defaultItemCategoryId).toBeDefined();
    expect(boot.body.defaultFiscalPeriodId).toBeDefined();
    expect(boot.body.defaultTaxTypeId).toBeDefined();
    expect(boot.body.defaultSafeId).toBeDefined();

    const token = boot.body.accessToken;
    const auth = { Authorization: `Bearer ${token}` };

    // وحدة قياس + صنف بالفئة الافتراضية المزروعة من bootstrap مباشرة (بلا إنشاء حسابات يدويًا)
    const uom = await request(app).post('/api/uoms').set(auth).send({ nameAr: 'قطعة', nameEn: 'Piece', symbol: 'pc' });
    expect(uom.status).toBe(201);

    const item = await request(app).post('/api/items').set(auth).send({
      code: 'SEED-1', nameAr: 'صنف بذرة', nameEn: 'Seed Item', itemKind: 'generic',
      baseUomId: uom.body.id, categoryId: boot.body.defaultItemCategoryId,
    });
    expect(item.status).toBe(201);

    // رصيد افتتاحي بسيط ليكون هناك ما يُباع فعليًا (عبر حركة إدخال مباشرة)
    await pool.query(
      `INSERT INTO stock_balances(company_id, warehouse_id, item_id, quantity_on_hand, weighted_average_cost)
       VALUES ($1,$2,$3,'100','10')`,
      [boot.body.companyId, boot.body.warehouseId, item.body.id],
    );

    const customer = await request(app).post('/api/customers').set(auth).send({
      code: 'SEED-C1', nameAr: 'عميل بذرة', nameEn: 'Seed Customer', currencyCode: 'EGP',
    });
    expect(customer.status).toBe(201);

    const invoice = await request(app).post('/api/sales/invoices').set(auth).send({
      branchId: boot.body.branchId, warehouseId: boot.body.warehouseId, customerId: customer.body.id,
      fiscalPeriodId: boot.body.defaultFiscalPeriodId, currencyCode: 'EGP', invoiceDate: `${new Date().getFullYear()}-03-01`,
      lines: [{ itemId: item.body.id, uomId: uom.body.id, quantity: '5', unitPrice: '100', discountPercent: '0', taxTypeId: boot.body.defaultTaxTypeId }],
    });
    expect(invoice.status).toBe(201);

    // الاختبار الحقيقي: الترحيل يعمل بلا أي إعداد إضافي — هذا ما كان مستحيلًا قبل بذرة هذه المرحلة
    const posted = await request(app).post(`/api/sales/invoices/${invoice.body.id}/post`).set(auth).send();
    expect(posted.status).toBe(200);

    const stored = await request(app).get(`/api/sales/invoices/${invoice.body.id}`).set(auth);
    expect(stored.body.status).toBe('posted');

    // القيد المُرحَّل متوازن فعليًا (لا مجرد عدم رمي خطأ)
    const lines = await pool.query(`SELECT debit, credit FROM journal_lines WHERE journal_entry_id=$1`, [stored.body.journal_entry_id]);
    const totalDebit = lines.rows.reduce((s, r) => s + Number(r.debit), 0);
    const totalCredit = lines.rows.reduce((s, r) => s + Number(r.credit), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 4);
    expect(totalDebit).toBeGreaterThan(0);
  });

  it('الدفعة المستلمة يمكن ربطها بالخزينة الافتراضية المزروعة (defaultSafeId) فورًا', async () => {
    const boot = await request(app).post('/api/bootstrap').send({
      tenantName: 'شركة بذرة 2', companyLegalName: 'شركة بذرة 2', ownerEmail: `seed2-${Date.now()}@test.local`, ownerPassword: 'Seed@12345',
    });
    const token = boot.body.accessToken;
    const auth = { Authorization: `Bearer ${token}` };

    const safe = await pool.query(`SELECT linked_account_id FROM safe_or_banks WHERE id=$1`, [boot.body.defaultSafeId]);
    expect(safe.rows[0].linked_account_id).toBeDefined();

    const customer = await request(app).post('/api/customers').set(auth).send({
      code: 'SEED-C2', nameAr: 'عميل', nameEn: 'Customer', currencyCode: 'EGP',
    });
    const payment = await request(app).post('/api/sales/payments').set(auth).send({
      branchId: boot.body.branchId, customerId: customer.body.id, fiscalPeriodId: boot.body.defaultFiscalPeriodId,
      currencyCode: 'EGP', paymentDate: `${new Date().getFullYear()}-03-01`, amount: '500',
      receiptAccountId: safe.rows[0].linked_account_id,
    });
    expect(payment.status).toBe(201);
    const posted = await request(app).post(`/api/sales/payments/${payment.body.id}/post`).set(auth).send();
    expect(posted.status).toBe(200);
  });

  it('دورة شراء كاملة (استلام → فاتورة مورد) تعمل فورًا بلا أي إعداد يدوي إضافي', async () => {
    const boot = await request(app).post('/api/bootstrap').send({
      tenantName: 'شركة بذرة شراء', companyLegalName: 'شركة بذرة شراء', ownerEmail: `seed3-${Date.now()}@test.local`, ownerPassword: 'Seed@12345',
    });
    const token = boot.body.accessToken;
    const auth = { Authorization: `Bearer ${token}` };

    const uom = await request(app).post('/api/uoms').set(auth).send({ nameAr: 'قطعة', nameEn: 'Piece', symbol: 'pc' });
    const item = await request(app).post('/api/items').set(auth).send({
      code: 'SEED-P1', nameAr: 'صنف شراء', nameEn: 'Purchase Item', itemKind: 'generic',
      baseUomId: uom.body.id, categoryId: boot.body.defaultItemCategoryId,
    });
    const supplier = await request(app).post('/api/suppliers').set(auth).send({
      code: 'SEED-S1', nameAr: 'مورد بذرة', nameEn: 'Seed Supplier', currencyCode: 'EGP',
    });

    const receipt = await request(app).post('/api/purchasing/receipts').set(auth).send({
      branchId: boot.body.branchId, warehouseId: boot.body.warehouseId, supplierId: supplier.body.id,
      receiptDate: `${new Date().getFullYear()}-03-01`,
      lines: [{ itemId: item.body.id, uomId: uom.body.id, quantity: '20', unitCost: '50' }],
    });
    expect(receipt.status).toBe(201);
    const receiptPosted = await request(app).post(`/api/purchasing/receipts/${receipt.body.id}/post`).set(auth).send();
    expect(receiptPosted.status).toBe(200);

    const receiptDetail = await request(app).get(`/api/purchasing/receipts/${receipt.body.id}`).set(auth);
    const lineId = receiptDetail.body.lines[0].id;

    const invoice = await request(app).post('/api/purchasing/invoices').set(auth).send({
      branchId: boot.body.branchId, supplierId: supplier.body.id, fiscalPeriodId: boot.body.defaultFiscalPeriodId,
      currencyCode: 'EGP', invoiceDate: `${new Date().getFullYear()}-03-02`,
      lines: [{ goodsReceiptLineId: lineId, quantity: '20', unitCost: '50', taxTypeId: boot.body.defaultTaxTypeId }],
    });
    expect(invoice.status).toBe(201);

    const invoicePosted = await request(app).post(`/api/purchasing/invoices/${invoice.body.id}/post`).set(auth).send();
    expect(invoicePosted.status).toBe(200);

    const lines = await pool.query(`SELECT debit, credit FROM journal_lines WHERE journal_entry_id=$1`, [invoicePosted.body.journalEntryId]);
    const totalDebit = lines.rows.reduce((s, r) => s + Number(r.debit), 0);
    const totalCredit = lines.rows.reduce((s, r) => s + Number(r.credit), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 4);
    expect(totalDebit).toBeCloseTo(1140, 2); // 20*50=1000 + ضريبة 14% = 1140
  });

  it('مرتجع بيع جزئي يُرحَّل بنجاح بلا أي إعداد يدوي إضافي (قواعد الترحيل العكسية مزروعة من bootstrap)', async () => {
    const boot = await request(app).post('/api/bootstrap').send({
      tenantName: 'شركة بذرة مرتجع', companyLegalName: 'شركة بذرة مرتجع', ownerEmail: `seed4-${Date.now()}@test.local`, ownerPassword: 'Seed@12345',
    });
    const token = boot.body.accessToken;
    const auth = { Authorization: `Bearer ${token}` };

    const uom = await request(app).post('/api/uoms').set(auth).send({ nameAr: 'قطعة', nameEn: 'Piece', symbol: 'pc' });
    const item = await request(app).post('/api/items').set(auth).send({
      code: 'SEED-R1', nameAr: 'صنف مرتجع', nameEn: 'Return Item', itemKind: 'generic',
      baseUomId: uom.body.id, categoryId: boot.body.defaultItemCategoryId,
    });
    const customer = await request(app).post('/api/customers').set(auth).send({
      code: 'SEED-RC1', nameAr: 'عميل مرتجع', nameEn: 'Return Customer', currencyCode: 'EGP',
    });
    await pool.query(
      `INSERT INTO stock_balances(company_id, warehouse_id, item_id, quantity_on_hand, weighted_average_cost) VALUES ($1,$2,$3,'100','10')`,
      [boot.body.companyId, boot.body.warehouseId, item.body.id],
    );

    const invoice = await request(app).post('/api/sales/invoices').set(auth).send({
      branchId: boot.body.branchId, warehouseId: boot.body.warehouseId, customerId: customer.body.id, fiscalPeriodId: boot.body.defaultFiscalPeriodId,
      currencyCode: 'EGP', invoiceDate: `${new Date().getFullYear()}-03-01`,
      lines: [{ itemId: item.body.id, uomId: uom.body.id, quantity: '10', unitPrice: '100' }],
    });
    await request(app).post(`/api/sales/invoices/${invoice.body.id}/post`).set(auth).send();
    const invoiceDetail = await request(app).get(`/api/sales/invoices/${invoice.body.id}`).set(auth);
    const lineId = invoiceDetail.body.lines[0].id;

    const ret = await request(app).post('/api/sales/returns').set(auth).send({
      branchId: boot.body.branchId, warehouseId: boot.body.warehouseId, salesInvoiceId: invoice.body.id,
      fiscalPeriodId: boot.body.defaultFiscalPeriodId, returnDate: `${new Date().getFullYear()}-03-05`,
      lines: [{ salesInvoiceLineId: lineId, quantity: '3' }],
    });
    expect(ret.status).toBe(201);

    const retPosted = await request(app).post(`/api/sales/returns/${ret.body.id}/post`).set(auth).send();
    expect(retPosted.status).toBe(200);

    const lines = await pool.query(`SELECT debit, credit FROM journal_lines WHERE journal_entry_id=$1`, [retPosted.body.journalEntryId]);
    const totalDebit = lines.rows.reduce((s, r) => s + Number(r.debit), 0);
    const totalCredit = lines.rows.reduce((s, r) => s + Number(r.credit), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 4);
    // مجموع المدين يشمل سطرين معًا في نفس القيد: عكس الإيراد (3×100=300) + عكس تكلفة البضاعة
    // المباعة (3×10 متوسط تكلفة مرجَّح=30) = 330. الأهم أعلاه: متوازن رقميًا فعليًا، لا افتراضًا.
    expect(totalDebit).toBeCloseTo(330, 2);
  });
});

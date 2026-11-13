import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { pool } from '@/db/pool';
import { createPostingRule } from '@/modules/accounting/accountingService';
import { recordInMovement } from '@/modules/inventory/stockService';
import { createCustomer } from '@/modules/sales/customerService';
import { createSalesInvoice, postSalesInvoice } from '@/modules/sales/salesInvoiceService';
import {
  createFullTenantStack, createAccountAndFiscalPeriod, createItemCategoryWithAccounts, createBaseItem,
} from './helpers';

const app = createApp();

describe('مركز الإشعارات — ربط حقيقي بحدث أعمال (ترحيل فاتورة بيع)', () => {
  it('ترحيل فاتورة بيع فعليًا يُنشئ إشعارًا حقيقيًا للمستخدم المُرحِّل', async () => {
    const stack = await createFullTenantStack('notif-invoice');
    const { revenueAccountId, inventoryAccountId, cogsAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
    const { categoryId } = await createItemCategoryWithAccounts(stack.companyId, inventoryAccountId, cogsAccountId);
    const { itemId, uomId } = await createBaseItem(stack.companyId);
    await pool.query(`UPDATE items SET category_id=$1 WHERE id=$2`, [categoryId, itemId]);
    await createPostingRule(stack.ctx, {
      operationType: 'sales_invoice_revenue', debitAccountSourceType: 'CUSTOMER_RECEIVABLE',
      creditAccountSourceType: 'FIXED_ACCOUNT', creditFixedAccountId: revenueAccountId,
    });
    await createPostingRule(stack.ctx, {
      operationType: 'sales_invoice_cogs', debitAccountSourceType: 'ITEM_CATEGORY_COGS', creditAccountSourceType: 'ITEM_CATEGORY_INVENTORY',
    });
    await recordInMovement(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, itemId, quantity: '50', unitCost: '10',
      movementDate: '2026-01-01', sourceDocumentType: 'opening',
    });
    const customer = await createCustomer(stack.ctx, { code: 'NOTIF-C', nameAr: 'عميل', nameEn: 'Customer', currencyCode: 'EGP' });

    const before = await request(app).get('/api/notifications').set('Authorization', `Bearer ${stack.token}`);
    expect(before.body.unreadCount).toBe(0);

    const invoice = await createSalesInvoice(stack.ctx, {
      branchId: stack.branchId, warehouseId: stack.warehouseId, customerId: customer.id, fiscalPeriodId,
      currencyCode: 'EGP', invoiceDate: '2026-02-01', lines: [{ itemId, uomId, quantity: '2', unitPrice: '100' }],
    });
    await postSalesInvoice(stack.ctx, invoice.id);

    const after = await request(app).get('/api/notifications').set('Authorization', `Bearer ${stack.token}`);
    expect(after.body.unreadCount).toBe(1);
    expect(after.body.data[0].type).toBe('sales_invoice_posted');
    expect(after.body.data[0].source_document_id).toBe(invoice.id);
  });
});

describe('مركز الإشعارات — API القراءة والتعليم كمقروء', () => {
  it('POST /notifications/:id/read يُعلِّم إشعارًا واحدًا كمقروء ويُنقِص unreadCount', async () => {
    const stack = await createFullTenantStack('notif-read');
    const { fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);
    void fiscalPeriodId;
    const { createNotification } = await import('@/modules/notifications/notificationService');
    const notif = await createNotification({ companyId: stack.companyId, userId: stack.userId, type: 'test', title: 'إشعار تجريبي' });

    const markRead = await request(app).post(`/api/notifications/${notif.id}/read`).set('Authorization', `Bearer ${stack.token}`);
    expect(markRead.status).toBe(200);
    expect(markRead.body.readAt).toBeTruthy();

    const list = await request(app).get('/api/notifications').set('Authorization', `Bearer ${stack.token}`);
    expect(list.body.unreadCount).toBe(0);
  });

  it('POST /notifications/read-all يُعلِّم كل الإشعارات غير المقروءة دفعة واحدة', async () => {
    const stack = await createFullTenantStack('notif-readall');
    const { createNotification } = await import('@/modules/notifications/notificationService');
    await createNotification({ companyId: stack.companyId, userId: stack.userId, type: 'test', title: 'إشعار 1' });
    await createNotification({ companyId: stack.companyId, userId: stack.userId, type: 'test', title: 'إشعار 2' });

    const res = await request(app).post('/api/notifications/read-all').set('Authorization', `Bearer ${stack.token}`);
    expect(res.status).toBe(200);
    expect(res.body.markedCount).toBe(2);

    const list = await request(app).get('/api/notifications').set('Authorization', `Bearer ${stack.token}`);
    expect(list.body.unreadCount).toBe(0);
  });

  it('عزل المستخدم: مستخدم آخر لا يرى إشعارات مستخدم غيره', async () => {
    const stack1 = await createFullTenantStack('notif-iso-1');
    const stack2 = await createFullTenantStack('notif-iso-2');
    const { createNotification } = await import('@/modules/notifications/notificationService');
    await createNotification({ companyId: stack1.companyId, userId: stack1.userId, type: 'test', title: 'سرّي' });

    const list2 = await request(app).get('/api/notifications').set('Authorization', `Bearer ${stack2.token}`);
    expect(list2.body.total).toBe(0);
  });
});

describe('اشتراكات Web Push', () => {
  it('حفظ اشتراك Push ثم حذفه يعملان دون أخطاء', async () => {
    const stack = await createFullTenantStack('push-sub');
    const save = await request(app).post('/api/notifications/push-subscriptions').set('Authorization', `Bearer ${stack.token}`).send({
      endpoint: `https://fcm.googleapis.com/fcm/send/test-${Date.now()}`,
      keys: { p256dh: 'test-p256dh-key', auth: 'test-auth-key' },
    });
    expect(save.status).toBe(201);

    const endpointRow = await pool.query(`SELECT endpoint FROM push_subscriptions WHERE id=$1`, [save.body.id]);
    const remove = await request(app).delete('/api/notifications/push-subscriptions').set('Authorization', `Bearer ${stack.token}`).send({
      endpoint: endpointRow.rows[0].endpoint,
    });
    expect(remove.status).toBe(200);

    const check = await pool.query(`SELECT id FROM push_subscriptions WHERE id=$1`, [save.body.id]);
    expect(check.rows.length).toBe(0);
  });

  it('GET /notifications/vapid-public-key يُرجع المفتاح العام (أو null إن لم يُضبط)', async () => {
    const stack = await createFullTenantStack('push-vapid');
    const res = await request(app).get('/api/notifications/vapid-public-key').set('Authorization', `Bearer ${stack.token}`);
    expect(res.status).toBe(200);
    expect('publicKey' in res.body).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { pool } from '@/db/pool';
import { reverseJournalEntry } from '@/modules/accounting/accountingService';
import { createFullTenantStack, createAccountAndFiscalPeriod } from './helpers';

const app = createApp();

describe('سجل التدقيق (AuditLog) — تغطية شاملة، وليس تسجيل الدخول فقط', () => {
  it('يسجّل إنشاء مستخدم (bootstrap) وتسجيل الدخول', async () => {
    const bootstrap = await request(app).post('/api/bootstrap').send({
      tenantName: 'Audit Tenant', companyLegalName: 'Audit Co', companyDisplayName: 'Audit Co',
      branchName: 'Main', warehouseName: 'Main WH', ownerFullName: 'Owner', ownerEmail: 'audit-owner@example.com',
      ownerPassword: 'Str0ngPass!2026',
    });
    expect(bootstrap.status).toBe(201);

    const logs = await pool.query(
      `SELECT action, entity_type FROM audit_logs WHERE user_id=$1 ORDER BY created_at ASC`,
      [bootstrap.body.ownerUserId],
    );
    const actions = logs.rows.map((r) => `${r.entity_type}:${r.action}`);
    expect(actions).toContain('user:create');
    expect(actions).toContain('user:login');
  });

  it('يسجّل إنشاء صنف عبر API', async () => {
    const stack = await createFullTenantStack('audit-item');
    const uom = await request(app).post('/api/uoms').set('Authorization', `Bearer ${stack.token}`)
      .send({ nameAr: 'م', nameEn: 'm', symbol: 'm' });
    const item = await request(app).post('/api/items').set('Authorization', `Bearer ${stack.token}`)
      .send({ code: 'AUDIT-1', nameAr: 'صنف', nameEn: 'Item', itemKind: 'generic', baseUomId: uom.body.id });

    const log = await pool.query(
      `SELECT action FROM audit_logs WHERE entity_type='item' AND entity_id=$1`,
      [item.body.id],
    );
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].action).toBe('create');
  });

  it('يسجّل إنشاء حركة مخزون (وارد وصرف) بالتفاصيل', async () => {
    const stack = await createFullTenantStack('audit-movement');
    const uom = await request(app).post('/api/uoms').set('Authorization', `Bearer ${stack.token}`)
      .send({ nameAr: 'م', nameEn: 'm', symbol: 'm' });
    const item = await request(app).post('/api/items').set('Authorization', `Bearer ${stack.token}`)
      .send({ code: 'AUDIT-MV-1', nameAr: 'صنف', nameEn: 'Item', itemKind: 'generic', baseUomId: uom.body.id });

    const movement = await request(app).post('/api/inventory/movements/in').set('Authorization', `Bearer ${stack.token}`)
      .send({
        branchId: stack.branchId, warehouseId: stack.warehouseId, itemId: item.body.id,
        quantity: '10', unitCost: '4', movementDate: '2026-01-01', sourceDocumentType: 'test',
      });

    const log = await pool.query(
      `SELECT action, after_json FROM audit_logs WHERE entity_type='stock_movement' AND entity_id=$1`,
      [movement.body.movementId],
    );
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].action).toBe('create');
    expect(log.rows[0].after_json.quantity).toBe('10.0000');
  });

  it('يسجّل كل انتقالات دورة حياة القيد (submit/approve/reject) وعكس القيد (reverse) بمن قام به ووقته وسببه', async () => {
    const stack = await createFullTenantStack('audit-journal');
    const { cashAccountId, revenueAccountId, fiscalPeriodId } = await createAccountAndFiscalPeriod(stack.companyId);

    const draftRes = await request(app).post('/api/accounting/journal-entries/draft').set('Authorization', `Bearer ${stack.token}`)
      .send({
        branchId: stack.branchId, fiscalPeriodId, entryDate: '2026-01-05', currencyCode: 'EGP',
        sourceDocumentType: 'test',
        lines: [{ accountId: cashAccountId, debit: '20', credit: '0' }, { accountId: revenueAccountId, debit: '0', credit: '20' }],
      });

    await request(app).post(`/api/accounting/journal-entries/${draftRes.body.id}/transition`).set('Authorization', `Bearer ${stack.token}`)
      .send({ target: 'pending_review' });
    await request(app).post(`/api/accounting/journal-entries/${draftRes.body.id}/transition`).set('Authorization', `Bearer ${stack.token}`)
      .send({ target: 'approved' });
    await request(app).post(`/api/accounting/journal-entries/${draftRes.body.id}/transition`).set('Authorization', `Bearer ${stack.token}`)
      .send({ target: 'posted' });

    const reversal = await reverseJournalEntry(stack.ctx, draftRes.body.id, 'اختبار تدقيق العكس');

    const logs = await pool.query(
      `SELECT action, user_id, before_json->>'reason' AS reason, created_at
       FROM audit_logs WHERE entity_type='journal_entry' AND entity_id=$1 ORDER BY created_at ASC`,
      [draftRes.body.id],
    );

    const actions = logs.rows.map((r: { action: string }) => r.action);
    expect(actions).toEqual(['create', 'submit', 'approve', 'post', 'reverse']);
    expect(logs.rows.every((r: { user_id: string }) => r.user_id === stack.userId)).toBe(true);
    const reverseLog = logs.rows.find((r: { action: string }) => r.action === 'reverse');
    expect(reverseLog.reason).toBe('اختبار تدقيق العكس');

    expect(reversal.reversalEntryId).toBeTruthy();
  });

  it('سجل التدقيق نفسه append-only: لا يمكن تعديله أو حذفه', async () => {
    const stack = await createFullTenantStack('audit-immutable');
    const uom = await request(app).post('/api/uoms').set('Authorization', `Bearer ${stack.token}`)
      .send({ nameAr: 'م', nameEn: 'm', symbol: 'm' });
    const item = await request(app).post('/api/items').set('Authorization', `Bearer ${stack.token}`)
      .send({ code: 'AUDIT-IMM-1', nameAr: 'صنف', nameEn: 'Item', itemKind: 'generic', baseUomId: uom.body.id });

    const row = await pool.query(
      `SELECT id FROM audit_logs WHERE entity_type='item' AND entity_id=$1`,
      [item.body.id],
    );

    await expect(pool.query(`UPDATE audit_logs SET action='update' WHERE id=$1`, [row.rows[0].id])).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM audit_logs WHERE id=$1`, [row.rows[0].id])).rejects.toThrow(/append-only/);
  });
});

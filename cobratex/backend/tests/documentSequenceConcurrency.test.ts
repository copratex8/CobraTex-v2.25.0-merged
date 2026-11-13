import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { pool } from '@/db/pool';
import { getNextDocumentNumber } from '@/modules/sequence/documentSequenceService';
import { createFullTenantStack, createBaseItem } from './helpers';

const app = createApp();

describe('الترقيم المتزامن للمستندات (Concurrency-safe Numbering)', () => {
  it('20 طلب إنشاء رقم متزامن لنفس الشركة/الفرع/نوع المستند ينتج أرقامًا فريدة ومتتالية بلا فجوة', async () => {
    const stack = await createFullTenantStack('seq-conc');

    const promises = Array.from({ length: 20 }, () =>
      getNextDocumentNumber({
        companyId: stack.companyId,
        branchId: stack.branchId,
        documentType: 'SALES_INVOICE',
        prefix: 'INV-',
      }),
    );
    const numbers = await Promise.all(promises);

    const numericParts = numbers.map((n) => Number(n.replace('INV-', ''))).sort((a, b) => a - b);
    const uniqueCount = new Set(numericParts).size;

    expect(uniqueCount).toBe(20); // لا تكرار
    expect(numericParts).toEqual(Array.from({ length: 20 }, (_, i) => i + 1)); // متتالية بلا فجوة: 1..20
  });

  it('تسلسل مستوى الشركة (branch_id = NULL) وتسلسل مستوى الفرع لا يتعارضان لنفس نوع المستند', async () => {
    const stack = await createFullTenantStack('seq-null');

    const companyLevel = await getNextDocumentNumber({
      companyId: stack.companyId,
      branchId: null,
      documentType: 'HR_MEMO',
    });
    const branchLevel = await getNextDocumentNumber({
      companyId: stack.companyId,
      branchId: stack.branchId,
      documentType: 'HR_MEMO',
    });
    // كلاهما ينجح بلا خطأ UNIQUE رغم تشابه company_id + document_type — يثبت أن الفهرسين الجزئيين يعملان
    expect(companyLevel).toBeTruthy();
    expect(branchLevel).toBeTruthy();
  });
});

describe('مفتاح Idempotency-Key', () => {
  it('إعادة إرسال نفس الطلب بنفس المفتاح لا يُنشئ حركة مخزون مكررة ويُعيد نفس الاستجابة', async () => {
    const stack = await createFullTenantStack('idem');
    const { itemId } = await createBaseItem(stack.companyId);
    const idempotencyKey = 'test-key-12345';

    const payload = {
      branchId: stack.branchId,
      warehouseId: stack.warehouseId,
      itemId,
      quantity: '50',
      unitCost: '12.5',
      movementDate: '2026-01-10',
      sourceDocumentType: 'manual_test',
    };

    const first = await request(app)
      .post('/api/inventory/movements/in')
      .set('Authorization', `Bearer ${stack.token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/inventory/movements/in')
      .set('Authorization', `Bearer ${stack.token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body); // نفس الاستجابة المخزَّنة تمامًا

    const movementCount = await pool.query(
      `SELECT count(*) FROM stock_movements WHERE company_id = $1 AND item_id = $2`,
      [stack.companyId, itemId],
    );
    expect(Number(movementCount.rows[0].count)).toBe(1); // حركة واحدة فقط، لا تكرار
  });

  it('نفس المفتاح بجسم طلب مختلف يُرفض بوضوح (422) بدل تنفيذ عملية خاطئة صامتة', async () => {
    const stack = await createFullTenantStack('idem-conflict');
    const { itemId } = await createBaseItem(stack.companyId);
    const key = 'conflict-key';

    await request(app)
      .post('/api/inventory/movements/in')
      .set('Authorization', `Bearer ${stack.token}`)
      .set('Idempotency-Key', key)
      .send({
        branchId: stack.branchId,
        warehouseId: stack.warehouseId,
        itemId,
        quantity: '10',
        unitCost: '5',
        movementDate: '2026-01-10',
        sourceDocumentType: 'manual_test',
      });

    const conflictingAttempt = await request(app)
      .post('/api/inventory/movements/in')
      .set('Authorization', `Bearer ${stack.token}`)
      .set('Idempotency-Key', key)
      .send({
        branchId: stack.branchId,
        warehouseId: stack.warehouseId,
        itemId,
        quantity: '999', // جسم مختلف بنفس المفتاح
        unitCost: '5',
        movementDate: '2026-01-10',
        sourceDocumentType: 'manual_test',
      });

    expect(conflictingAttempt.status).toBe(422);
  });
});

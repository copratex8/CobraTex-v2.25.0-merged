import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '@/app';
import { pool } from '@/db/pool';
import {
  uploadAttachment, listAttachments, getAttachmentFile, deleteAttachment, MAX_ATTACHMENT_SIZE_BYTES,
} from '@/modules/system/attachmentService';
import { createFullTenantStack, createBaseItem, createLimitedPermissionUser } from './helpers';

const app = createApp();

const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

describe('مرفقات الملفات (Attachments) — الخدمة كانت جاهزة كاملة بلا أي مسار HTTP يستدعيها', () => {
  it('رفع صورة صغيرة لصنف: يُخزَّن الحجم الصحيح، والقائمة لا تُعيد محتوى الملف (BYTEA) بل بياناته الوصفية فقط', async () => {
    const stack = await createFullTenantStack('att-upload');
    const { itemId } = await createBaseItem(stack.companyId);

    const uploaded = await uploadAttachment(stack.ctx, {
      branchId: stack.branchId, entityType: 'item', entityId: itemId,
      fileName: 'photo.png', mimeType: 'image/png', fileData: tinyPng,
    });
    expect(uploaded.file_size).toBe(tinyPng.length);
    expect((uploaded as Record<string, unknown>).file_data).toBeUndefined();

    const list = await listAttachments(stack.ctx, 'item', itemId);
    expect(list.length).toBe(1);
    expect(list[0].file_name).toBe('photo.png');
    expect((list[0] as Record<string, unknown>).file_data).toBeUndefined();
  });

  it('تنزيل المرفق يُعيد المحتوى الثنائي الصحيح تمامًا (بلا أي تلف/تحويل)', async () => {
    const stack = await createFullTenantStack('att-download');
    const { itemId } = await createBaseItem(stack.companyId);
    const uploaded = await uploadAttachment(stack.ctx, {
      branchId: stack.branchId, entityType: 'item', entityId: itemId,
      fileName: 'photo.png', mimeType: 'image/png', fileData: tinyPng,
    });
    const file = await getAttachmentFile(stack.ctx, uploaded.id);
    expect(Buffer.compare(file.file_data, tinyPng)).toBe(0);
    expect(file.mime_type).toBe('image/png');
  });

  it('حذف مرفق يُزيله فعليًا؛ محاولة تنزيله بعدها تُرجع NotFoundError', async () => {
    const stack = await createFullTenantStack('att-delete');
    const { itemId } = await createBaseItem(stack.companyId);
    const uploaded = await uploadAttachment(stack.ctx, {
      branchId: stack.branchId, entityType: 'item', entityId: itemId,
      fileName: 'photo.png', mimeType: 'image/png', fileData: tinyPng,
    });
    await deleteAttachment(stack.ctx, uploaded.id);
    await expect(getAttachmentFile(stack.ctx, uploaded.id)).rejects.toThrow();
  });

  it('يرفض نوع ملف غير مدعوم، وملفًا فارغًا، وملفًا يتجاوز الحد الأقصى', async () => {
    const stack = await createFullTenantStack('att-validation');
    const { itemId } = await createBaseItem(stack.companyId);

    await expect(uploadAttachment(stack.ctx, {
      branchId: stack.branchId, entityType: 'item', entityId: itemId,
      fileName: 'script.exe', mimeType: 'application/x-msdownload', fileData: tinyPng,
    })).rejects.toThrow();

    await expect(uploadAttachment(stack.ctx, {
      branchId: stack.branchId, entityType: 'item', entityId: itemId,
      fileName: 'empty.png', mimeType: 'image/png', fileData: Buffer.alloc(0),
    })).rejects.toThrow();

    await expect(uploadAttachment(stack.ctx, {
      branchId: stack.branchId, entityType: 'item', entityId: itemId,
      fileName: 'huge.png', mimeType: 'image/png', fileData: Buffer.alloc(MAX_ATTACHMENT_SIZE_BYTES + 1),
    })).rejects.toThrow();
  });

  it('يرفض نوع كيان غير مدعوم، ويرفض entityId لا ينتمي لهذه الشركة (لا تسريب بين الشركات)', async () => {
    const stack1 = await createFullTenantStack('att-entity-1');
    const stack2 = await createFullTenantStack('att-entity-2');
    const { itemId: item2 } = await createBaseItem(stack2.companyId);

    await expect(uploadAttachment(stack1.ctx, {
      branchId: stack1.branchId, entityType: 'not_a_real_entity', entityId: item2,
      fileName: 'photo.png', mimeType: 'image/png', fileData: tinyPng,
    })).rejects.toThrow();

    await expect(uploadAttachment(stack1.ctx, {
      branchId: stack1.branchId, entityType: 'item', entityId: item2, // صنف شركة أخرى
      fileName: 'photo.png', mimeType: 'image/png', fileData: tinyPng,
    })).rejects.toThrow();
  });

  it('RBAC: مستخدم بلا attachments.upload يُرفض عند الرفع', async () => {
    const stack = await createFullTenantStack('att-rbac');
    const { itemId } = await createBaseItem(stack.companyId);
    const limited = await createLimitedPermissionUser(stack.tenantId, stack.companyId, stack.branchId, []);
    await expect(uploadAttachment(limited.ctx, {
      branchId: stack.branchId, entityType: 'item', entityId: itemId,
      fileName: 'photo.png', mimeType: 'image/png', fileData: tinyPng,
    })).rejects.toThrow();
  });

  it('رفع/قائمة/تنزيل/حذف عبر HTTP فعليًا (multipart/form-data حقيقي عبر supertest)', async () => {
    const stack = await createFullTenantStack('att-http');
    const { itemId } = await createBaseItem(stack.companyId);

    const uploadRes = await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${stack.token}`)
      .field('branchId', stack.branchId)
      .field('entityType', 'item')
      .field('entityId', itemId)
      .attach('file', tinyPng, { filename: 'photo.png', contentType: 'image/png' });
    expect(uploadRes.status).toBe(201);
    const attachmentId = uploadRes.body.id;

    const listRes = await request(app)
      .get('/api/attachments')
      .query({ entityType: 'item', entityId: itemId })
      .set('Authorization', `Bearer ${stack.token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.length).toBe(1);

    const downloadRes = await request(app)
      .get(`/api/attachments/${attachmentId}/download`)
      .set('Authorization', `Bearer ${stack.token}`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers['content-type']).toContain('image/png');
    expect(Buffer.compare(downloadRes.body as Buffer, tinyPng)).toBe(0);

    const deleteRes = await request(app)
      .delete(`/api/attachments/${attachmentId}`)
      .set('Authorization', `Bearer ${stack.token}`);
    expect(deleteRes.status).toBe(200);

    const afterDelete = await request(app)
      .get(`/api/attachments/${attachmentId}/download`)
      .set('Authorization', `Bearer ${stack.token}`);
    expect(afterDelete.status).toBe(404);
  });

  it('رفع بلا ملف عبر HTTP يُرفض بـ422', async () => {
    const stack = await createFullTenantStack('att-http-novalidation');
    const { itemId } = await createBaseItem(stack.companyId);
    const res = await request(app)
      .post('/api/attachments')
      .set('Authorization', `Bearer ${stack.token}`)
      .field('branchId', stack.branchId)
      .field('entityType', 'item')
      .field('entityId', itemId);
    expect(res.status).toBe(422);
  });

  it('عزل الشركات: قائمة مرفقات كيان تعود فارغة لشركة أخرى (لا تسريب حتى لو خمَّنت entityId)', async () => {
    const stack1 = await createFullTenantStack('att-iso-1');
    const stack2 = await createFullTenantStack('att-iso-2');
    const { itemId } = await createBaseItem(stack1.companyId);
    await uploadAttachment(stack1.ctx, {
      branchId: stack1.branchId, entityType: 'item', entityId: itemId,
      fileName: 'photo.png', mimeType: 'image/png', fileData: tinyPng,
    });
    const list = await listAttachments(stack2.ctx, 'item', itemId);
    expect(list.length).toBe(0);
  });
});

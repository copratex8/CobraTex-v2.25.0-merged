import { Router } from 'express';
import multer from 'multer';
import { validate } from '@/middleware/validate';
import { idParamSchema } from '@/shared/zodSchemas';
import {
  uploadAttachment, listAttachments, getAttachmentFile, deleteAttachment, MAX_ATTACHMENT_SIZE_BYTES,
} from '@/modules/system/attachmentService';

/**
 * أول مسارات HTTP لمرفقات الملفات — الخدمة (attachmentService.ts) والجدول (migration 0032) كانا
 * جاهزين بالكامل بلا أي مسار يستدعيهما. multer.memoryStorage() عمدًا (لا diskStorage): الملف
 * يبقى في الذاكرة كـ Buffer فقط حتى يُكتَب مباشرة كـ BYTEA في قاعدة البيانات — لا يلمس قرص الخادم
 * إطلاقًا، اتساقًا مع قرار التخزين الموثَّق في migration 0032 (قرص Render المجاني مؤقت).
 */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_SIZE_BYTES } });

export const attachmentRouter = Router();

attachmentRouter.post('/attachments', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(422).json({ error: 'الملف مطلوب' });
    const { branchId, entityType, entityId } = req.body ?? {};
    if (!branchId || !entityType || !entityId) {
      return res.status(422).json({ error: 'branchId وentityType وentityId مطلوبة' });
    }
    const result = await uploadAttachment(req.ctx, {
      branchId, entityType, entityId,
      fileName: req.file.originalname, mimeType: req.file.mimetype, fileData: req.file.buffer,
    });
    res.status(201).json(result);
  } catch (err) { next(err); }
});

attachmentRouter.get('/attachments', async (req, res, next) => {
  try {
    const { entityType, entityId } = req.query;
    if (typeof entityType !== 'string' || typeof entityId !== 'string') {
      return res.status(422).json({ error: 'entityType وentityId مطلوبان كـ query params' });
    }
    res.status(200).json(await listAttachments(req.ctx, entityType, entityId));
  } catch (err) { next(err); }
});

/** بلا مصادقة إضافية غير authMiddleware العام — الصلاحية والعزل بالشركة يتحقَّقان داخل getAttachmentFile نفسها. */
attachmentRouter.get('/attachments/:id/download', validate({ params: idParamSchema }), async (req, res, next) => {
  try {
    const file = await getAttachmentFile(req.ctx, String(req.params.id));
    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.file_name)}"`);
    res.send(file.file_data);
  } catch (err) { next(err); }
});

attachmentRouter.delete('/attachments/:id', validate({ params: idParamSchema }), async (req, res, next) => {
  try { res.status(200).json(await deleteAttachment(req.ctx, String(req.params.id))); } catch (err) { next(err); }
});

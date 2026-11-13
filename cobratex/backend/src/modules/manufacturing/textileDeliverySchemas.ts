import { z } from 'zod';
import { uuid, optionalUuid } from '@/shared/zodSchemas';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ بصيغة YYYY-MM-DD');
const decPos = z.string().regex(/^\d+(\.\d{1,4})?$/, 'رقم عشري موجب').refine((v) => Number(v) > 0, 'يجب أن يكون أكبر من صفر');

export const defectTypeBodySchema = z.strictObject({
  code: z.string().min(1).max(30), nameAr: z.string().min(1).max(120),
  category: z.enum(['warp', 'weft', 'knit', 'dye', 'finish', 'yarn', 'other']).optional(),
  points: z.number().int().min(1).max(4), isActive: z.boolean().optional(),
});
export const defectTypeUpdateSchema = defectTypeBodySchema.partial();

/** رول بعيوب مسجَّلة بالنوع: النقاط تُحسب من الكتالوج (عدد × نقاط النوع) لا من إدخال يدوي. */
export const rollWithDefectsBodySchema = z.strictObject({
  rollNo: z.string().min(1).max(60), productionOrderId: optionalUuid, itemId: optionalUuid,
  lengthM: z.number().positive().max(100000), widthCm: z.number().positive().max(1000), weightKg: z.number().positive().max(1e6).optional(),
  defects: z.array(z.strictObject({ defectTypeId: uuid, occurrences: z.number().int().min(1).max(10000), positionM: z.number().min(0).max(100000).optional() })).max(500),
});

export const deliveryNoteBodySchema = z.strictObject({
  branchId: uuid, customerId: uuid, salesOrderId: optionalUuid, noteDate: date,
  vehicleNo: z.string().max(40).optional(), driverName: z.string().max(80).optional(), notes: z.string().max(500).optional(),
  packingUnitIds: z.array(uuid).max(500).default([]), fabricRollIds: z.array(uuid).max(500).default([]),
}).refine((b) => b.packingUnitIds.length + b.fabricRollIds.length > 0, { message: 'اختر وحدة تعبئة أو رولاً واحداً على الأقل' });
export const cancelNoteBodySchema = z.strictObject({ reason: z.string().min(3).max(300) });
export const deliveryListQuerySchema = z.object({ customerId: optionalUuid, from: date.optional(), to: date.optional() }).passthrough();
export const knitSpecsKeys = decPos; // (للتصدير فقط؛ المواصفات تمرّ عبر itemSpecsBodySchema)
export const linkInvoiceBodySchema = z.strictObject({ invoiceId: uuid.nullable() });

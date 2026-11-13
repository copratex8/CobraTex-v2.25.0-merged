import { z } from 'zod';
import { uuid, optionalUuid } from '@/shared/zodSchemas';

const decPos = z.string().regex(/^\d+(\.\d{1,4})?$/, 'رقم عشري غير سالب (حتى 4 خانات)').refine((v) => Number(v) > 0, 'يجب أن يكون أكبر من صفر');
const decNonNeg = z.string().regex(/^\d+(\.\d{1,4})?$/, 'رقم عشري غير سالب (حتى 4 خانات)');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ بصيغة YYYY-MM-DD');

export const subcontractJobBodySchema = z.strictObject({
  branchId: uuid, jobNo: z.string().min(1).max(50), supplierId: uuid,
  serviceType: z.enum(['spinning', 'weaving', 'dyeing', 'finishing', 'printing', 'other']),
  materialDescription: z.string().min(1).max(200), unit: z.string().min(1).max(20).optional(),
  feePerUnit: decNonNeg, feeBasis: z.enum(['received', 'sent']).optional(),
  allowedLossPercent: decNonNeg.optional(), materialValuePerUnit: decNonNeg.optional(),
  productionOrderId: optionalUuid, notes: z.string().max(500).optional(),
});
export const subcontractMovementSchema = z.strictObject({
  movementType: z.enum(['sent', 'received', 'waste_returned', 'waste_retained', 'invoice']), movementDate: date,
  quantity: decPos.optional(), amount: decPos.optional(), reference: z.string().max(100).optional(), notes: z.string().max(500).optional(),
});
export const subcontractListQuerySchema = z.object({ status: z.string().max(10).optional(), supplierId: optionalUuid }).passthrough();
export const emptyBodySchema = z.strictObject({});

import { z } from 'zod';
import { uuid, optionalUuid } from '@/shared/zodSchemas';

const decPos = z.string().regex(/^\d+(\.\d{1,4})?$/, 'رقم عشري غير سالب (حتى 4 خانات)').refine((v) => Number(v) > 0, 'يجب أن يكون أكبر من صفر');
const decNonNeg = z.string().regex(/^\d+(\.\d{1,4})?$/, 'رقم عشري غير سالب (حتى 4 خانات)');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ بصيغة YYYY-MM-DD');
const shift = z.enum(['morning', 'evening', 'night']);

export const scheduleBodySchema = z.strictObject({
  plannedStart: date, plannedEnd: date, machineId: optionalUuid, force: z.boolean().optional(),
});
export const scheduleQuerySchema = z.object({ from: date.optional(), to: date.optional(), machineId: optionalUuid }).passthrough();

export const workerBodySchema = z.strictObject({
  code: z.string().min(1).max(30), nameAr: z.string().min(1).max(120), jobTitle: z.string().max(80).optional(),
  stageId: optionalUuid, branchId: optionalUuid,
});
export const workerUpdateSchema = z.strictObject({
  nameAr: z.string().min(1).max(120).optional(), jobTitle: z.string().max(80).optional(), stageId: optionalUuid, isActive: z.boolean().optional(),
});
export const incentiveRateBodySchema = z.strictObject({
  stageId: optionalUuid, unit: z.string().min(1).max(20).optional(), ratePerUnit: decNonNeg,
  bonusThreshold: decPos.optional(), bonusRatePerUnit: decNonNeg.optional(), effectiveFrom: date,
});
export const workerLogBodySchema = z.strictObject({
  branchId: uuid, workerId: uuid, machineId: optionalUuid, stageId: optionalUuid, productionOrderId: optionalUuid,
  logDate: date, shift, quantity: decPos, defectiveQuantity: decNonNeg.optional(), unit: z.string().min(1).max(20).optional(), notes: z.string().max(300).optional(),
});
export const rangeQuerySchema = z.object({ from: date.optional(), to: date.optional(), workerId: optionalUuid, stageId: optionalUuid }).passthrough();
export const labelQuerySchema = z.object({
  kind: z.enum(['roll', 'packing', 'fiber-lot', 'dye-batch']),
  ids: z.string().regex(/^[0-9a-fA-F-]{36}(,[0-9a-fA-F-]{36}){0,99}$/, 'ids: قائمة معرّفات UUID مفصولة بفواصل (حتى 100)'),
}).strict();

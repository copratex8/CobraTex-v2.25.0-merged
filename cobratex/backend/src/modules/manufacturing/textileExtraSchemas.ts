import { z } from 'zod';
import { optionalUuid, uuid } from '@/shared/zodSchemas';

const dec = z.string().regex(/^-?\d+(\.\d{1,4})?$/, 'رقم عشري صالح (حتى 4 خانات)');
const decNonNeg = z.string().regex(/^\d+(\.\d{1,4})?$/, 'رقم عشري غير سالب (حتى 4 خانات)');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ بصيغة YYYY-MM-DD');
const name = z.string().min(1).max(200);

export const qualityTypeBodySchema = z.strictObject({
  code: z.string().min(1).max(50), nameAr: name, nameEn: name,
  appliesTo: z.enum(['fiber', 'yarn', 'fabric', 'other']), unit: z.string().max(20).optional(),
  minValue: dec.nullable().optional(), maxValue: dec.nullable().optional(), isActive: z.boolean().optional(),
});
export const qualityTypeUpdateSchema = qualityTypeBodySchema.partial();

export const qualityResultBodySchema = z.strictObject({
  testTypeId: uuid, value: dec, productionOrderId: optionalUuid, itemId: optionalUuid,
  lotNumber: z.string().min(1).max(80).optional(), notes: z.string().max(500).optional(),
});

export const maintenancePlanBodySchema = z.strictObject({
  machineId: uuid, taskName: name, intervalDays: z.number().int().min(1).max(3650), nextDueDate: date.optional(), isActive: z.boolean().optional(),
});
export const maintenancePlanUpdateSchema = z.strictObject({
  taskName: name.optional(), intervalDays: z.number().int().min(1).max(3650).optional(), nextDueDate: date.optional(), isActive: z.boolean().optional(),
});
export const maintenanceLogBodySchema = z.strictObject({
  machineId: uuid, planId: optionalUuid, logType: z.enum(['preventive', 'breakdown', 'inspection']), logDate: date,
  downtimeHours: decNonNeg.optional(), cost: decNonNeg.optional(), description: z.string().max(500).optional(),
});

export const listQuerySchema = z.object({
  from: date.optional(), to: date.optional(), lot: z.string().max(80).optional(), productionOrderId: optionalUuid,
  machineId: optionalUuid, days: z.coerce.number().int().min(0).max(365).optional(), quantity: z.coerce.number().positive().optional(),
}).passthrough();

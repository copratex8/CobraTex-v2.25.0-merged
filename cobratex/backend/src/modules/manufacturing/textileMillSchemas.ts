import { z } from 'zod';
import { optionalUuid, uuid } from '@/shared/zodSchemas';

const dec = z.string().regex(/^-?\d+(\.\d{1,4})?$/, 'رقم عشري صالح (حتى 4 خانات)');
const decPos = z.string().regex(/^\d+(\.\d{1,4})?$/, 'رقم عشري غير سالب (حتى 4 خانات)').refine((v) => Number(v) > 0, 'يجب أن يكون أكبر من صفر');
const decNonNeg = z.string().regex(/^\d+(\.\d{1,4})?$/, 'رقم عشري غير سالب (حتى 4 خانات)');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ بصيغة YYYY-MM-DD');
const name = z.string().min(1).max(200);
const code = z.string().min(1).max(50);

/* ألياف وخلط */
export const fiberLotBodySchema = z.strictObject({
  lotCode: code, fiberType: z.enum(['cotton', 'polyester', 'viscose', 'acrylic', 'wool', 'nylon', 'blend', 'other']),
  variety: z.string().max(100).optional(), origin: z.string().max(100).optional(), supplierName: z.string().max(200).optional(),
  itemId: optionalUuid, balesCount: z.number().int().min(0).optional(), netWeightKg: decPos,
  stapleLengthMm: decPos.optional(), micronaire: decNonNeg.optional(), strengthGtex: decNonNeg.optional(),
  uniformityPercent: decNonNeg.optional(), shortFiberPercent: decNonNeg.optional(), trashPercent: decNonNeg.optional(), moisturePercent: decNonNeg.optional(),
  colorGrade: z.string().max(50).optional(), pricePerKg: decNonNeg.optional(), receivedDate: date.optional(), notes: z.string().max(500).optional(),
});
export const fiberLotUpdateSchema = z.strictObject({
  status: z.enum(['available', 'in_use', 'consumed', 'rejected']).optional(), netWeightKg: decPos.optional(),
  pricePerKg: decNonNeg.optional(), notes: z.string().max(500).optional(), supplierName: z.string().max(200).optional(),
});
export const fiberListQuerySchema = z.object({ status: z.string().max(20).optional(), fiberType: z.string().max(20).optional() }).passthrough();

export const mixingPlanBodySchema = z.strictObject({
  planNo: code, name, targetCountNe: decPos.optional(), notes: z.string().max(500).optional(),
  lines: z.array(z.strictObject({ lotId: uuid, percent: decPos })).min(1).max(30),
});
export const mixingApproveSchema = z.strictObject({});

/* صباغة */
export const shadeBodySchema = z.strictObject({
  code, nameAr: name, nameEn: name, colorHex: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(), pantone: z.string().max(50).optional(),
});
export const shadeUpdateSchema = z.strictObject({ nameAr: name.optional(), nameEn: name.optional(), colorHex: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(), pantone: z.string().max(50).optional(), isActive: z.boolean().optional() });

export const recipeBodySchema = z.strictObject({
  code, shadeId: optionalUuid, fiberType: z.string().max(30).optional(),
  processType: z.enum(['exhaust', 'continuous', 'pad_batch', 'reactive', 'disperse', 'vat', 'other']).optional(),
  liquorRatio: decPos.optional(), temperatureC: dec.optional(), durationMin: z.number().int().min(1).max(3000).optional(), ph: decNonNeg.optional(), notes: z.string().max(500).optional(),
  lines: z.array(z.strictObject({ itemId: uuid, amount: decPos, basis: z.enum(['percent_owf', 'g_per_l', 'kg_per_ton']) })).min(1).max(40),
});
export const dyeBatchBodySchema = z.strictObject({
  branchId: uuid, batchNo: code, recipeId: uuid, machineId: optionalUuid, productionOrderId: optionalUuid, materialKg: decPos, batchDate: date, notes: z.string().max(500).optional(),
});
export const dyeBatchResultSchema = z.strictObject({
  status: z.enum(['planned', 'running', 'done', 'rework', 'rejected']).optional(),
  deltaE: decNonNeg.optional(), shadeResult: z.enum(['pending', 'pass', 'fail']).optional(),
  fastnessWash: decNonNeg.optional(), fastnessRub: decNonNeg.optional(), fastnessLight: decNonNeg.optional(),
  waterLiters: decNonNeg.optional(), steamKg: decNonNeg.optional(), energyKwh: decNonNeg.optional(), notes: z.string().max(500).optional(),
});

/* تشغيل للغير */
export const tollJobBodySchema = z.strictObject({
  branchId: uuid, jobNo: code, customerId: uuid, serviceType: z.enum(['spinning', 'weaving', 'dyeing', 'finishing', 'printing', 'other']),
  materialDescription: name, unit: z.string().min(1).max(20).optional(), feePerUnit: decNonNeg, feeBasis: z.enum(['output', 'received']).optional(),
  allowedLossPercent: decNonNeg.optional(), materialValuePerUnit: decNonNeg.optional(), notes: z.string().max(500).optional(),
});
export const tollMovementBodySchema = z.strictObject({
  movementType: z.enum(['receipt', 'output', 'waste_returned', 'waste_retained', 'invoice']), movementDate: date,
  quantity: decNonNeg.optional(), amount: decNonNeg.optional(), reference: z.string().max(100).optional(), notes: z.string().max(500).optional(),
});
export const tollListQuerySchema = z.object({ status: z.string().max(10).optional(), customerId: optionalUuid }).passthrough();

/* معدّلات */
export const costRateBodySchema = z.strictObject({
  rateType: z.enum(['labor_per_run_hour', 'energy_per_kwh', 'overhead_per_run_hour']), rate: decNonNeg, stageId: optionalUuid, machineId: optionalUuid, notes: z.string().max(200).optional(),
});

export const rangeSchema = z.object({ from: date.optional(), to: date.optional() }).passthrough();
export const commercialWeightQuerySchema = z.object({
  actualKg: decPos, moisturePercent: decNonNeg, fiber: z.enum(['cotton', 'wool', 'viscose', 'polyester', 'nylon', 'acrylic']).optional(), regainPercent: decNonNeg.optional(),
}).passthrough();

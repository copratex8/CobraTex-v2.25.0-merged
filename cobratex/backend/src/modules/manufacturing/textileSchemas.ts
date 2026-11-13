import { z } from 'zod';
import { uuid, optionalUuid } from '@/shared/zodSchemas';

const dec = (positive: boolean) =>
  z.string().regex(/^\d+(\.\d{1,4})?$/, 'رقم عشري صالح (حتى 4 خانات)').refine((v) => !positive || Number(v) > 0, 'يجب أن يكون أكبر من صفر');
const decPos = dec(true);
const decNonNeg = dec(false);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ بصيغة YYYY-MM-DD');
const code = z.string().min(1).max(50);
const name = z.string().min(1).max(200);

export const STAGE_TYPES = ['blowroom','carding','combing','drawing','roving','ring_spinning','open_end','winding','warping','sizing','weaving','knitting','dyeing','printing','finishing','inspection','packing','other'] as const;

export const stageBodySchema = z.strictObject({
  code, nameAr: name, nameEn: name, stageType: z.enum(STAGE_TYPES),
  standardWastePercent: decNonNeg.refine((v) => Number(v) < 100, 'أقل من 100').optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
  isActive: z.boolean().optional(),
});
export const stageUpdateBodySchema = stageBodySchema.partial();

export const wasteTypeBodySchema = z.strictObject({
  code, nameAr: name, nameEn: name, stageId: optionalUuid,
  isRecoverable: z.boolean().optional(), recoveryItemId: optionalUuid, recoveryUnitValue: decNonNeg.optional(), isActive: z.boolean().optional(),
});
export const wasteTypeUpdateBodySchema = wasteTypeBodySchema.partial();

const numOpt = z.number().positive().max(1e7).optional();
export const itemSpecsBodySchema = z.strictObject({
  countSystem: z.enum(['Ne', 'Nm', 'Tex', 'Denier']).optional(), yarnCount: numOpt, ply: z.number().int().min(1).max(12).optional(),
  twistTpi: numOpt, fiberComposition: z.string().max(300).optional(),
  spinningType: z.enum(['ring', 'compact', 'open_end', 'air_jet', 'vortex', 'other']).optional(),
  weaveType: z.enum(['plain', 'twill', 'satin', 'dobby', 'jacquard', 'knit_single', 'knit_double', 'nonwoven', 'other']).optional(),
  fabricGsm: numOpt, fabricWidthCm: numOpt, epi: numOpt, ppi: numOpt, warpCountNe: numOpt, weftCountNe: numOpt,
  shrinkagePercent: z.number().min(0).max(50).optional(), notes: z.string().max(1000).optional(),
  knitStructure: z.enum(['single_jersey', 'rib', 'interlock', 'fleece', 'pique', 'jacquard', 'other']).optional(),
  knitGauge: numOpt, machineDiameterIn: numOpt, stitchLengthMm: numOpt,
  needlesCount: z.number().int().positive().max(100000).optional(), feedersCount: z.number().int().positive().max(1000).optional(),
});

export const machineBodySchema = z.strictObject({
  code, nameAr: name, nameEn: name, branchId: optionalUuid, stageId: optionalUuid, machineType: z.string().max(100).optional(),
  unitsCount: z.number().int().min(1).max(100000).optional(), ratedOutputPerHour: decNonNeg.optional(),
  outputUnit: z.string().min(1).max(20).optional(), isActive: z.boolean().optional(),
});
export const machineUpdateBodySchema = machineBodySchema.partial();

export const machineLogBodySchema = z.strictObject({
  branchId: uuid, machineId: uuid, shift: z.enum(['morning', 'evening', 'night']), logDate: date, productionOrderId: optionalUuid,
  runHours: decNonNeg, downtimeHours: decNonNeg.optional(), downtimeReason: z.string().max(300).optional(),
  outputQuantity: decNonNeg, wasteQuantity: decNonNeg.optional(), notes: z.string().max(500).optional(),
  energyKwh: decNonNeg.optional(), operatorsCount: z.number().int().min(0).max(500).optional(),
});

export const completionBodySchema = z.strictObject({
  stageId: optionalUuid, machineId: optionalUuid, standardWastePercent: decNonNeg.optional(),
  lines: z.array(z.strictObject({ lineId: uuid, actualQuantity: decPos, isMainMaterial: z.boolean().optional(), inputLotNumbers: z.string().max(300).optional() })).optional(),
  outputs: z.array(z.strictObject({ outputItemId: uuid, grade: z.string().min(1).max(10), quantity: decPos, costWeight: decPos.optional(), lotNumber: z.string().min(1).max(80).optional() })).min(1),
  wastes: z.array(z.strictObject({ wasteTypeId: uuid, quantity: decPos, recoveryItemId: optionalUuid, recoveryUnitValue: decNonNeg.optional(), notes: z.string().max(300).optional() })).optional(),
});

export const fabricRollBodySchema = z.strictObject({
  productionOrderId: optionalUuid, itemId: optionalUuid, rollNo: z.string().min(1).max(60),
  lengthM: z.number().positive().max(100000), widthCm: z.number().positive().max(1000), weightKg: z.number().positive().max(100000).optional(),
  defectPoints: z.number().min(0).max(100000),
});

export const rangeQuerySchema = z.object({ from: date.optional(), to: date.optional(), stageId: optionalUuid, machineId: optionalUuid, productionOrderId: optionalUuid }).passthrough();

export const countConvertQuerySchema = z.object({ value: z.coerce.number().positive(), system: z.enum(['Ne', 'Nm', 'Tex', 'Denier']) }).passthrough();
export const fabricEstimateBodySchema = z.strictObject({
  epi: z.number().positive(), ppi: z.number().positive(), widthCm: z.number().positive(), warpCountNe: z.number().positive(), weftCountNe: z.number().positive(),
  warpCrimpPercent: z.number().min(0).max(30).optional(), weftCrimpPercent: z.number().min(0).max(30).optional(), sizePickupPercent: z.number().min(0).max(30).optional(),
});
export const spindleBodySchema = z.strictObject({ rpm: z.number().positive(), tpi: z.number().positive(), ne: z.number().positive(), efficiencyPercent: z.number().min(1).max(100).optional() });

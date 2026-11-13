import { z } from 'zod';
import { optionalUuid, uuid } from '@/shared/zodSchemas';

const decPos = z.string().regex(/^(?!0+(\.0+)?$)\d+(\.\d{1,4})?$/, 'رقم موجب (حتى 4 خانات)');
const decNonNeg = z.string().regex(/^\d+(\.\d{1,4})?$/, 'رقم غير سالب (حتى 4 خانات)');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ بصيغة YYYY-MM-DD');

export const beamBodySchema = z.strictObject({
  branchId: uuid, beamNo: z.string().min(1).max(60), beamType: z.enum(['warp', 'sectional']).optional(),
  yarnItemId: optionalUuid, lotNumber: z.string().min(1).max(80).optional(), yarnCountNe: z.number().positive().optional(),
  totalEnds: z.number().int().positive(), lengthM: decPos, weightKg: decPos.optional(), sizingPickupPercent: decNonNeg.optional(),
  productionOrderId: optionalUuid, notes: z.string().max(500).optional(),
});
export const beamMountSchema = z.strictObject({ machineId: uuid });
export const beamProgressSchema = z.strictObject({ meters: decPos });
export const beamScrapSchema = z.strictObject({ reason: z.string().min(1).max(300) });
export const beamListQuerySchema = z.object({ status: z.enum(['prepared', 'on_loom', 'finished', 'scrapped']).optional(), machineId: optionalUuid }).passthrough();

const packingUnit = z.strictObject({
  packingNo: z.string().min(1).max(60), unitType: z.enum(['bale', 'pallet', 'carton', 'bag', 'roll_pack']), itemId: uuid,
  lotNumber: z.string().min(1).max(80).optional(), productionOrderId: optionalUuid, packagesCount: z.number().int().min(0).optional(),
  grossKg: decPos, tareKg: decNonNeg.optional(), notes: z.string().max(300).optional(),
});
export const packingBodySchema = z.strictObject({ branchId: uuid, units: z.array(packingUnit).min(1).max(200) });
export const packingShipSchema = z.strictObject({ ids: z.array(uuid).min(1).max(500) });
export const packingListQuerySchema = z.object({ lot: z.string().max(80).optional(), status: z.enum(['in_stock', 'shipped']).optional(), itemId: optionalUuid, productionOrderId: optionalUuid }).passthrough();

export const rangeSchema = z.object({ from: date.optional(), to: date.optional() }).passthrough();

export const mrpBodySchema = z.strictObject({
  items: z.array(z.strictObject({ itemId: uuid, quantity: decPos })).min(1).max(50),
  warehouseId: optionalUuid,
});
export const bomCostQuerySchema = z.object({ warehouseId: optionalUuid }).passthrough();

export const loomBodySchema = z.strictObject({ rpm: z.number().positive(), ppi: z.number().positive(), efficiencyPercent: z.number().min(1).max(100).optional() });
export const twistBodySchema = z.strictObject({ tpi: z.number().positive(), ne: z.number().positive() });

import { z } from 'zod';
import { uuid, optionalUuid } from '@/shared/zodSchemas';

const decPos = z.string().regex(/^\d+(\.\d{1,4})?$/, 'رقم عشري غير سالب (حتى 4 خانات)').refine((v) => Number(v) > 0, 'يجب أن يكون أكبر من صفر');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ بصيغة YYYY-MM-DD');

export const promiseBodySchema = z.strictObject({
  promisedDate: date, requestedDate: date.optional(), reason: z.string().max(300).optional(),
});
export const linkBodySchema = z.strictObject({ productionOrderId: uuid });
export const createFromLineBodySchema = z.strictObject({
  branchId: uuid, warehouseId: uuid, bomId: uuid, fiscalPeriodId: uuid, orderDate: date,
  plannedOutputQuantity: decPos.optional(), // الافتراضي: المتبقي غير المخطَّط من السطر
});
export const trackingQuerySchema = z.object({
  customerId: optionalUuid, status: z.enum(['on_track', 'at_risk', 'late', 'unplanned', 'ready', 'short', 'delivered']).optional(), from: date.optional(), to: date.optional(),
}).passthrough();

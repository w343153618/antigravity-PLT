import { z } from 'zod';
import { MonetaryAmountSchema, NonnegativeMonetaryAmountSchema } from './money.ts';

export const ReconciliationDirectionSchema = z.enum(['ADJUST_IN', 'ADJUST_OUT']);

export const ReconciliationAdjustmentSchema = z.strictObject({
  managerId: z.uuid(),
  clientId: z.uuid(),
  date: z.iso.date(),
  direction: ReconciliationDirectionSchema,
  amount: MonetaryAmountSchema,
  note: z.string().trim().min(1).max(200),
});

export const ReconciliationLedgerEntrySchema = ReconciliationAdjustmentSchema.extend({
  id: z.uuid(),
  storeId: z.uuid(),
  balanceAfter: NonnegativeMonetaryAmountSchema,
  createdAt: z.date(),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});

export const ReconciliationFiltersSchema = z.strictObject({
  date: z.iso.date().optional(),
  managerId: z.uuid().optional(),
  storeId: z.uuid().optional(),
  clientId: z.uuid().optional(),
});

export type ReconciliationAdjustment = z.infer<typeof ReconciliationAdjustmentSchema>;
export type ReconciliationLedgerEntry = z.infer<typeof ReconciliationLedgerEntrySchema>;
export type ReconciliationFilters = z.infer<typeof ReconciliationFiltersSchema>;

import { z } from 'zod';
import { MonetaryAmountSchema, NonnegativeMonetaryAmountSchema, PositiveQuantitySchema } from './money.ts';

export const SettlementInputSchema = z.strictObject({
  totalAmount: MonetaryAmountSchema,
  quotaPerUnit: MonetaryAmountSchema,
  quantity: PositiveQuantitySchema,
  isHit: z.boolean(),
  adoptedStrategy: z.boolean(),
});

export const SettlementResultSchema = z.strictObject({
  grossGain: NonnegativeMonetaryAmountSchema,
  netGain: NonnegativeMonetaryAmountSchema,
  performanceFee: NonnegativeMonetaryAmountSchema,
  managerIncentive: NonnegativeMonetaryAmountSchema,
  platformMargin: NonnegativeMonetaryAmountSchema,
});

export type SettlementInput = z.infer<typeof SettlementInputSchema>;
export type SettlementResult = z.infer<typeof SettlementResultSchema>;

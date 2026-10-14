import { z } from 'zod';
import { MonetaryAmountSchema, PositiveQuantitySchema } from './money.ts';

export const ThreeDigitCodeSchema = z.string().length(3)
  .regex(/^[0-9]{3}$/, '必须为 3 位纯数字字符串');

export const OutcomeStatusSchema = z.enum(['Hit', 'Miss']);
export const VoucherStatusSchema = z.enum(['StoredInShop', 'Claimed']);

export const StrategyPortfolioSchema = z.strictObject({
  id: z.uuid(),
  date: z.iso.date(),
  combos: z.array(z.strictObject({
    code: ThreeDigitCodeSchema,
    weight: z.number().min(1).max(100),
    note: z.string().optional(),
  })).length(3, '每日策略必须且仅包含 3 组推荐标的'),
  createdAt: z.date(),
});

export const BetModeSchema = z.enum(['DIRECT', 'GROUP', 'GROUP_3', 'GROUP_6']);
export type BetMode = z.infer<typeof BetModeSchema>;

export const OrderSlipSchema = z.strictObject({
  id: z.uuid(),
  storeId: z.uuid(),
  clientId: z.uuid(),
  date: z.iso.date(),
  adoptedStrategy: z.boolean().default(true),
  selectedCode: ThreeDigitCodeSchema,
  betMode: BetModeSchema.optional(),
  quantity: PositiveQuantitySchema,
  totalAmount: MonetaryAmountSchema,
  voucherStatus: VoucherStatusSchema.default('StoredInShop'),
  createdAt: z.date(),
});

export const ResolutionEventSchema = z.strictObject({
  date: z.iso.date(),
  settlementCode: ThreeDigitCodeSchema,
  quotaPerUnit: MonetaryAmountSchema,
});

export type ThreeDigitCode = z.infer<typeof ThreeDigitCodeSchema>;
export type OutcomeStatus = z.infer<typeof OutcomeStatusSchema>;
export type StrategyPortfolio = z.infer<typeof StrategyPortfolioSchema>;
export type OrderSlip = z.infer<typeof OrderSlipSchema>;
export type OrderSlipInput = z.input<typeof OrderSlipSchema>;
export type VoucherStatus = z.infer<typeof VoucherStatusSchema>;
export type ResolutionEvent = z.infer<typeof ResolutionEventSchema>;

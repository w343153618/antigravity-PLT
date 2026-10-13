import { z } from 'zod';

const MAX_MINOR_UNITS = BigInt(Number.MAX_SAFE_INTEGER);

/** Decimal conversion avoids binary multiplication changing a cent. */
export function toMinorUnits(amount: number): bigint {
  const [whole, fraction = ''] = String(amount).split('.');
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
}

const CentAmountSchema = z.number().finite().nonnegative().refine(
  (amount) => /^\d+(?:\.\d{1,2})?$/.test(String(amount)) && toMinorUnits(amount) <= MAX_MINOR_UNITS,
  'Amount must have at most two decimal places and safe integer minor units',
);

export const MonetaryAmountSchema = CentAmountSchema.refine((amount) => amount > 0, 'Amount must be positive');
export const NonnegativeMonetaryAmountSchema = CentAmountSchema;
export const PositiveQuantitySchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

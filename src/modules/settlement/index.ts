import { SettlementInputSchema } from '../../shared/schemas/settlement.ts';
import type { SettlementInput, SettlementResult } from '../../shared/schemas/settlement.ts';
import { toMinorUnits } from '../../shared/schemas/money.ts';

export type { SettlementInput, SettlementResult } from '../../shared/schemas/settlement.ts';

function fromMinorUnits(amount: bigint): number {
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Settlement exceeds safe minor-unit precision');
  }
  const result = Number(`${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`);
  if (toMinorUnits(result) !== amount) {
    throw new RangeError('Settlement cannot preserve cent precision in a numeric result');
  }
  return result;
}

export function calculateSettlement(input: SettlementInput): SettlementResult {
  const parsed = SettlementInputSchema.parse(input);
  if (!parsed.isHit) {
    return { grossGain: 0, netGain: 0, performanceFee: 0, managerIncentive: 0, platformMargin: 0 };
  }
  const grossMinor = BigInt(parsed.quantity) * toMinorUnits(parsed.quotaPerUnit);
  const difference = grossMinor - toMinorUnits(parsed.totalAmount);
  const netMinor = difference > 0n ? difference : 0n;
  const grossGain = fromMinorUnits(grossMinor);
  const netGain = fromMinorUnits(netMinor);
  if (!parsed.adoptedStrategy || netMinor === 0n) {
    return { grossGain, netGain, performanceFee: 0, managerIncentive: 0, platformMargin: 0 };
  }
  const feeMinor = (netMinor * 20n + 50n) / 100n;
  const managerMinor = (netMinor * 10n + 50n) / 100n;
  return { grossGain, netGain, performanceFee: fromMinorUnits(feeMinor), managerIncentive: fromMinorUnits(managerMinor), platformMargin: fromMinorUnits(feeMinor - managerMinor) };
}

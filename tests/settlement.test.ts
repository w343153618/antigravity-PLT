import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { calculateSettlement } from '../src/modules/settlement/index.ts';
import type { SettlementInput } from '../src/modules/settlement/index.ts';

const validInput: SettlementInput = {
  totalAmount: 2, quotaPerUnit: 1040, quantity: 1, isHit: true, adoptedStrategy: true,
};

describe('calculateSettlement', () => {
  it('distributes an adopted positive yield at 20% and 10%', () => {
    expect(calculateSettlement({ totalAmount: 2, quotaPerUnit: 1040, quantity: 1, isHit: true, adoptedStrategy: true })).toEqual({
      grossGain: 1040, netGain: 1038, performanceFee: 207.6, managerIncentive: 103.8, platformMargin: 103.8,
    });
  });

  it('retains positive yield without charging when the strategy was not adopted', () => {
    expect(calculateSettlement({ totalAmount: 2, quotaPerUnit: 1040, quantity: 1, isHit: true, adoptedStrategy: false })).toEqual({
      grossGain: 1040, netGain: 1038, performanceFee: 0, managerIncentive: 0, platformMargin: 0,
    });
  });

  it.each([true, false])('returns zero gains and distributions on Miss (adopted: %s)', (adoptedStrategy) => {
    expect(calculateSettlement({ totalAmount: 2, quotaPerUnit: 1040, quantity: 2, isHit: false, adoptedStrategy })).toEqual({
      grossGain: 0, netGain: 0, performanceFee: 0, managerIncentive: 0, platformMargin: 0,
    });
  });

  it.each([2, 3])('clamps nonpositive yield to zero for total amount %s', (totalAmount) => {
    expect(calculateSettlement({ totalAmount, quotaPerUnit: 2, quantity: 1, isHit: true, adoptedStrategy: true })).toEqual({
      grossGain: 2, netGain: 0, performanceFee: 0, managerIncentive: 0, platformMargin: 0,
    });
  });

  it('rounds decimal half cents upward and assigns the remaining fee to the platform', () => {
    expect(calculateSettlement({ totalAmount: 0.01, quotaPerUnit: 0.36, quantity: 1, isHit: true, adoptedStrategy: true })).toEqual({
      grossGain: 0.36, netGain: 0.35, performanceFee: 0.07, managerIncentive: 0.04, platformMargin: 0.03,
    });
  });

  it('rejects gross gain beyond safe minor-unit precision', () => {
    expect(() => calculateSettlement({ totalAmount: 0.01, quotaPerUnit: 2, quantity: Number.MAX_SAFE_INTEGER, isHit: true, adoptedStrategy: true })).toThrow(RangeError);
  });

  it('rejects a computed cent amount that cannot round-trip through the numeric result', () => {
    expect(() => calculateSettlement({ totalAmount: 0.03, quotaPerUnit: 90071992547409.9, quantity: 1, isHit: true, adoptedStrategy: true })).toThrow(RangeError);
  });

  it('applies the multiplier to gross gain and subtracts total amount once', () => {
    expect(calculateSettlement({ ...validInput, quantity: 3, totalAmount: 6 })).toEqual({
      grossGain: 3120, netGain: 3114, performanceFee: 622.8, managerIncentive: 311.4, platformMargin: 311.4,
    });
  });

  it('calculates decimal products and differences without residual fractions', () => {
    expect(calculateSettlement({ ...validInput, totalAmount: 0.1, quotaPerUnit: 0.2, quantity: 3 })).toEqual({
      grossGain: 0.6, netGain: 0.5, performanceFee: 0.1, managerIncentive: 0.05, platformMargin: 0.05,
    });
  });

  it.each([
    [0.02, 0.01, 0, 0, 0],
    [0.04, 0.03, 0.01, 0, 0.01],
    [0.06, 0.05, 0.01, 0.01, 0],
    [0.16, 0.15, 0.03, 0.02, 0.01],
    [0.26, 0.25, 0.05, 0.03, 0.02],
  ])('preserves cent allocation for gross gain %s', (quotaPerUnit, netGain, performanceFee, managerIncentive, platformMargin) => {
    expect(calculateSettlement({ ...validInput, totalAmount: 0.01, quotaPerUnit })).toEqual({
      grossGain: quotaPerUnit, netGain, performanceFee, managerIncentive, platformMargin,
    });
  });

  it.each([2, 3])('clamps nonpositive yield without strategy adoption for total amount %s', (totalAmount) => {
    expect(calculateSettlement({ ...validInput, totalAmount, quotaPerUnit: 2, adoptedStrategy: false })).toEqual({
      grossGain: 2, netGain: 0, performanceFee: 0, managerIncentive: 0, platformMargin: 0,
    });
  });

  it.each(['totalAmount', 'quotaPerUnit'] as const)('rejects invalid %s before calculation, including on Miss', (field) => {
    for (const value of [0, -0, -1, 0.001, 1.005, 1e-7, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, '2', null, undefined]) {
      const input = { ...validInput, isHit: false, [field]: value };
      expect(() => calculateSettlement(input as SettlementInput)).toThrow(ZodError);
    }
  });

  it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null, undefined])('rejects invalid quantity %s', (quantity) => {
    expect(() => calculateSettlement({ ...validInput, quantity } as SettlementInput)).toThrow(ZodError);
  });

  it.each(['isHit', 'adoptedStrategy'] as const)('requires an explicit boolean %s', (field) => {
    for (const value of [0, 1, 'true', 'false', null, undefined]) {
      expect(() => calculateSettlement({ ...validInput, [field]: value } as SettlementInput)).toThrow(ZodError);
    }
  });

  it.each([undefined, null, [], 1, 'input'])('rejects a malformed input %s', (input) => {
    expect(() => calculateSettlement(input as unknown as SettlementInput)).toThrow(ZodError);
  });

  it('rejects an omitted adoption decision', () => {
    const { adoptedStrategy: _adoptedStrategy, ...input } = validInput;
    expect(() => calculateSettlement(input as SettlementInput)).toThrow(ZodError);
  });

  it('rejects undeclared fields instead of silently dropping a misspelled field', () => {
    const input = { ...validInput, managerFee: 10 };
    expect(() => calculateSettlement(input)).toThrow(ZodError);
  });

  it('accepts the largest safe quantity when the actual outcome is Miss', () => {
    expect(calculateSettlement({ ...validInput, quantity: Number.MAX_SAFE_INTEGER, isHit: false })).toEqual({
      grossGain: 0, netGain: 0, performanceFee: 0, managerIncentive: 0, platformMargin: 0,
    });
  });

  it('accepts large exactly representable cent amounts', () => {
    expect(calculateSettlement({ ...validInput, totalAmount: 0.02, quotaPerUnit: 90071992547409.9, adoptedStrategy: false })).toEqual({
      grossGain: 90071992547409.9, netGain: 90071992547409.88, performanceFee: 0, managerIncentive: 0, platformMargin: 0,
    });
  });

  it('rejects precision loss even without strategy adoption', () => {
    expect(() => calculateSettlement({ ...validInput, totalAmount: 0.03, quotaPerUnit: 90071992547409.9, adoptedStrategy: false })).toThrow(RangeError);
  });

  it('does not mutate input or share mutable results across calls', () => {
    const input = Object.freeze({ ...validInput });
    const result = calculateSettlement(input);
    result.performanceFee = 0;
    expect(input).toEqual(validInput);
    expect(calculateSettlement(input).performanceFee).toBe(207.6);
  });

  it('conserves the fee in cents across rounding boundaries', () => {
    for (let cents = 1; cents <= 1000; cents += 1) {
      const result = calculateSettlement({ ...validInput, totalAmount: 1, quotaPerUnit: (100 + cents) / 100 });
      expect(Math.round(result.managerIncentive * 100) + Math.round(result.platformMargin * 100)).toBe(Math.round(result.performanceFee * 100));
      expect(result.performanceFee).toBeGreaterThanOrEqual(0);
      expect(result.performanceFee).toBeLessThanOrEqual(result.netGain);
      expect(result.platformMargin).toBeGreaterThanOrEqual(0);
    }
  });
});

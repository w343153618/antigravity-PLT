import { describe, expect, expectTypeOf, it } from 'vitest';
import { OrderSlipSchema, OutcomeStatusSchema, ResolutionEventSchema, StrategyPortfolioSchema, ThreeDigitCodeSchema } from '../src/shared/schemas/index.ts';
import type { OrderSlip, OrderSlipInput, OutcomeStatus } from '../src/shared/schemas/index.ts';

const id = '123e4567-e89b-42d3-a456-426614174000';
const createdAt = new Date('2026-10-12T00:00:00.000Z');
const portfolio = {
  id,
  date: '2026-10-12',
  combos: [{ code: '038', weight: 1 }, { code: '083', weight: 50.5 }, { code: '999', weight: 100, note: '' }],
  createdAt,
};
const orderSlip = {
  id, storeId: id, clientId: id, date: '2026-10-12', selectedCode: '038',
  quantity: 2, totalAmount: 4, createdAt,
};

describe('ThreeDigitCode', () => {
  it('preserves leading zeroes and accepts exactly three ASCII digits', () => {
    for (const code of ['000', '038', '999']) {
      expect(ThreeDigitCodeSchema.parse(code)).toBe(code);
    }
    for (const code of [38, '', '38', '0038', '１２３', '1a3', ' 038', '038\n']) {
      expect(ThreeDigitCodeSchema.safeParse(code).success).toBe(false);
    }
    expectTypeOf(ThreeDigitCodeSchema.parse('038')).toEqualTypeOf<string>();
  });
});

describe('StrategyPortfolio', () => {
  it('requires exactly three weighted combinations and a real calendar date', () => {
    expect(StrategyPortfolioSchema.parse(portfolio)).toEqual(portfolio);
    for (const patch of [
      { id: 'invalid' },
      { date: '2026-02-29' },
      { date: '2026-13-01' },
      { date: '2026-1-01' },
      { date: '2026-10-12\n' },
      { createdAt: '2026-10-12T00:00:00Z' },
      { createdAt: new Date('invalid') },
      { combos: portfolio.combos.slice(0, 2) },
      { combos: [...portfolio.combos, portfolio.combos[0]] },
      { combos: [{ code: '12', weight: 1 }, ...portfolio.combos.slice(1)] },
      { combos: [{ code: '038', weight: 0 }, ...portfolio.combos.slice(1)] },
      { combos: [{ code: '038', weight: 101 }, ...portfolio.combos.slice(1)] },
      { combos: [{ code: '038', weight: Infinity }, ...portfolio.combos.slice(1)] },
      { combos: [{ code: '038', weight: 1, note: 123 }, ...portfolio.combos.slice(1)] },
      { extraField: true },
    ]) {
      expect(StrategyPortfolioSchema.safeParse({ ...portfolio, ...patch }).success).toBe(false);
    }
    expect(StrategyPortfolioSchema.safeParse({ ...portfolio, date: '2024-02-29' }).success).toBe(true);
  });
});

describe('OrderSlip', () => {
  it('defaults strategy adoption to true but preserves an explicit opt-out', () => {
    expect(OrderSlipSchema.parse(orderSlip)).toEqual({ ...orderSlip, adoptedStrategy: true, voucherStatus: 'StoredInShop' });
    expect(OrderSlipSchema.parse({ ...orderSlip, adoptedStrategy: false }).adoptedStrategy).toBe(false);
    expectTypeOf<OrderSlipInput['adoptedStrategy']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<OrderSlip['adoptedStrategy']>().toEqualTypeOf<boolean>();
  });

  it.each([
    ['id', 'invalid'], ['storeId', 'invalid'], ['clientId', 'invalid'],
    ['date', '2026-04-31'], ['selectedCode', '38'], ['adoptedStrategy', 'false'],
    ['quantity', 0], ['quantity', -1], ['quantity', 1.5], ['quantity', '2'],
    ['quantity', Number.MAX_SAFE_INTEGER + 1], ['quantity', NaN],
    ['totalAmount', 0], ['totalAmount', -1], ['totalAmount', 1.001],
    ['totalAmount', '4'], ['totalAmount', Infinity], ['totalAmount', NaN],
    ['totalAmount', Number.MAX_SAFE_INTEGER], ['createdAt', '2026-10-12'],
    ['extraField', true],
  ])('rejects invalid %s: %s', (field, value) => {
    expect(OrderSlipSchema.safeParse({ ...orderSlip, [field]: value }).success).toBe(false);
  });

  it('accepts exact minor units without coercing number strings', () => {
    expect(OrderSlipSchema.parse({ ...orderSlip, totalAmount: 0.29 }).totalAmount).toBe(0.29);
  });
});

describe('ResolutionEvent', () => {
  const resolutionEvent = { date: '2026-10-12', settlementCode: '038', quotaPerUnit: 1040 };

  it('validates the resolution date, code and positive per-unit amount', () => {
    expect(ResolutionEventSchema.parse(resolutionEvent)).toEqual(resolutionEvent);
    for (const patch of [
      { date: '2026-02-29' }, { settlementCode: 38 }, { settlementCode: '38' },
      { quotaPerUnit: 0 }, { quotaPerUnit: -1 }, { quotaPerUnit: Infinity },
      { quotaPerUnit: NaN }, { quotaPerUnit: '1040' }, { quotaPerUnit: 0.001 },
      { extraField: true },
    ]) {
      expect(ResolutionEventSchema.safeParse({ ...resolutionEvent, ...patch }).success).toBe(false);
    }
  });
});

describe('OutcomeStatus', () => {
  it('exposes only the two canonical statuses at runtime and compile time', () => {
    expect(OutcomeStatusSchema.parse('Hit')).toBe('Hit');
    expect(OutcomeStatusSchema.parse('Miss')).toBe('Miss');
    for (const status of ['hit', 'miss', 'Pending', '', true, null]) {
      expect(OutcomeStatusSchema.safeParse(status).success).toBe(false);
    }
    expectTypeOf<OutcomeStatus>().toEqualTypeOf<'Hit' | 'Miss'>();
  });
});

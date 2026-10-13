import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { createStrategyModule, generateCalendar } from '../src/modules/strategy/index.ts';
import { createDatabase } from '../src/shared/database.ts';
import type { AppDatabase } from '../src/shared/database.ts';
import { DomainError } from '../src/shared/errors.ts';
import type { ResolutionEvent, StrategyPortfolio } from '../src/shared/schemas/index.ts';

function portfolio(date = '2026-10-13', id = '123e4567-e89b-42d3-a456-426614174000'): StrategyPortfolio {
  return {
    id, date, createdAt: new Date('2026-10-13T00:00:00.000Z'),
    combos: [{ code: '038', weight: 33 }, { code: '148', weight: 33 }, { code: '350', weight: 34 }],
  };
}

function resolution(date = '2026-10-13', settlementCode = '038'): ResolutionEvent {
  return { date, settlementCode, quotaPerUnit: 1040 };
}

describe('generateCalendar', () => {
  it('returns exactly 30 ascending dates ending on the requested day with no invented outcomes', () => {
    const calendar = generateCalendar('2026-10-13', [], []);
    expect(calendar).toHaveLength(30);
    expect(calendar[0]).toEqual({ date: '2026-09-14', portfolio: null, resolution: null, status: null });
    expect(calendar[29]).toEqual({ date: '2026-10-13', portfolio: null, resolution: null, status: null });
    expect(new Set(calendar.map((day) => day.date)).size).toBe(30);
    expect(calendar.map((day) => day.date)).toEqual(calendar.map((day) => day.date).sort());
  });

  it.each([
    ['038', 'Hit'], ['148', 'Hit'], ['350', 'Hit'], ['083', 'Miss'], ['999', 'Miss'],
  ])('evaluates exact code %s as %s and exposes comparison details', (settlementCode, status) => {
    const strategy = portfolio();
    const event = resolution('2026-10-13', settlementCode);
    expect(generateCalendar('2026-10-13', [strategy], [event])[29]).toEqual({
      date: '2026-10-13', portfolio: strategy, resolution: event, status,
    });
  });

  it.each(['2026-02-29', '2026-13-01', '2026-1-01', '2026-10-13\n', '', '0000-01-20'])('rejects invalid or unrepresentable calendar end date %s', (date) => {
    expect(() => generateCalendar(date, [], [])).toThrow(ZodError);
  });

  it('rejects malformed records and duplicate dates instead of selecting an arbitrary outcome', () => {
    expect(() => generateCalendar('2026-10-13', [{ ...portfolio(), combos: [] }], [])).toThrow(ZodError);
    expect(() => generateCalendar('2026-10-13', [], [{ ...resolution(), settlementCode: '38' }])).toThrow(ZodError);
    expect(() => generateCalendar('2026-10-13', [portfolio(), portfolio()], [])).toThrow(/duplicate/i);
    expect(() => generateCalendar('2026-10-13', [], [resolution(), resolution('2026-10-13', '999')])).toThrow(/duplicate/i);
    expect(() => generateCalendar('2026-10-13', null as unknown as StrategyPortfolio[], [])).toThrow(ZodError);
    expect(() => generateCalendar('2026-10-13', [], null as unknown as ResolutionEvent[])).toThrow(ZodError);
  });

  it('returns independent comparison details without mutating supplied records or sharing their Date objects', () => {
    const strategy = portfolio();
    const event = resolution();
    const original = structuredClone({ strategy, event });
    const calendar = generateCalendar('2026-10-13', [strategy], [event]);
    const last = calendar[29]!;
    last.portfolio!.combos[0]!.code = '999';
    last.portfolio!.createdAt.setUTCFullYear(2020);
    last.resolution!.settlementCode = '000';
    expect({ strategy, event }).toEqual(original);
    expect(generateCalendar('2026-10-13', [strategy], [event])[29]!.status).toBe('Hit');
  });

  it.each([
    ['2024-03-01', '2024-02-01', '2024-02-29'],
    ['2025-03-01', '2025-01-31', '2025-02-28'],
    ['2026-01-01', '2025-12-03', '2025-12-31'],
    ['0099-01-01', '0098-12-03', '0098-12-31'],
    ['0000-01-30', '0000-01-01', '0000-01-29'],
  ])('keeps a continuous UTC window ending %s across calendar boundaries', (endDate, firstDate, penultimateDate) => {
    const calendar = generateCalendar(endDate, [], []);
    expect(calendar).toHaveLength(30);
    expect(calendar[0]!.date).toBe(firstDate);
    expect(calendar[28]!.date).toBe(penultimateDate);
    expect(calendar[29]!.date).toBe(endDate);
  });

  it('keeps unverified dates empty and excludes older and future records', () => {
    const portfolios = [portfolio('2026-09-13'), portfolio('2026-09-14'), portfolio('2026-10-12'), portfolio('2026-10-14')];
    const resolutions = [resolution('2026-09-13'), resolution('2026-09-14'), resolution('2026-10-13'), resolution('2026-10-14')];
    const calendar = generateCalendar('2026-10-13', portfolios, resolutions);
    expect(calendar[0]!.status).toBe('Hit');
    expect(calendar[28]).toEqual({ date: '2026-10-12', portfolio: portfolios[2], resolution: null, status: null });
    expect(calendar[29]).toEqual({ date: '2026-10-13', portfolio: null, resolution: resolutions[2], status: null });
    expect(calendar.some((day) => ['2026-09-13', '2026-10-14'].includes(day.date))).toBe(false);
  });
});

describe('createStrategyModule', () => {
  const databases: AppDatabase[] = [];
  function setup() {
    const db = createDatabase(':memory:');
    databases.push(db);
    return { db, strategy: createStrategyModule(db) };
  }
  afterEach(() => { for (const db of databases.splice(0)) db.close(); });

  it('publishes a validated portfolio that another module instance can retrieve', () => {
    const { db, strategy } = setup();
    const input = portfolio();
    expect(strategy.publishPortfolio(input)).toEqual(input);
    expect(createStrategyModule(db).getPortfolio('2026-10-13')).toEqual(input);
    expect(strategy.getPortfolio('2026-10-12')).toBeUndefined();
  });

  it('keeps published dates and IDs immutable', () => {
    const { strategy } = setup();
    const first = portfolio();
    strategy.publishPortfolio(first);
    expect(() => strategy.publishPortfolio({ ...first, combos: [...first.combos].reverse() })).toThrow(DomainError);
    expect(() => strategy.publishPortfolio({ ...first, date: '2026-10-14' })).toThrow(DomainError);
    expect(strategy.getPortfolio('2026-10-13')).toEqual(first);
    expect(strategy.getPortfolio('2026-10-14')).toBeUndefined();
  });

  it('prohibits retrospective publication after a resolution has been recorded', () => {
    const { db, strategy } = setup();
    db.insert('resolution', '2026-10-13', resolution());
    expect(() => strategy.publishPortfolio(portfolio())).toThrow(DomainError);
    expect(strategy.getPortfolio('2026-10-13')).toBeUndefined();
  });

  it('lists portfolios chronologically and builds the calendar from persisted resolution records', () => {
    const { db, strategy } = setup();
    const today = portfolio();
    const yesterday = portfolio('2026-10-12', '123e4567-e89b-42d3-a456-426614174001');
    strategy.publishPortfolio(today);
    strategy.publishPortfolio(yesterday);
    const event = resolution('2026-10-12', '999');
    db.insert('resolution', event.date, event);
    expect(strategy.listPortfolios()).toEqual([yesterday, today]);
    expect(strategy.getResolution('2026-10-12')).toEqual(event);
    expect(strategy.getResolution('2026-10-13')).toBeUndefined();
    expect(strategy.getCalendar('2026-10-13').slice(-2)).toEqual([
      { date: '2026-10-12', portfolio: yesterday, resolution: event, status: 'Miss' },
      { date: '2026-10-13', portfolio: today, resolution: null, status: null },
    ]);
  });

  it('rejects a different portfolio for an already published date', () => {
    const { strategy } = setup();
    const first = portfolio();
    strategy.publishPortfolio(first);
    expect(() => strategy.publishPortfolio(portfolio('2026-10-13', '123e4567-e89b-42d3-a456-426614174001'))).toThrow(DomainError);
    expect(strategy.listPortfolios()).toEqual([first]);
  });

  it('validates publication and lookup inputs without creating invalid records', () => {
    const { strategy } = setup();
    expect(() => strategy.publishPortfolio({ ...portfolio(), combos: [] })).toThrow(ZodError);
    expect(() => strategy.publishPortfolio({ ...portfolio(), createdAt: '2026-10-13' })).toThrow(ZodError);
    expect(() => strategy.publishPortfolio({ ...portfolio(), date: '2026-02-29' })).toThrow(ZodError);
    expect(() => strategy.publishPortfolio({ ...portfolio(), unknown: true })).toThrow(ZodError);
    expect(() => strategy.getPortfolio('2026-02-29')).toThrow(ZodError);
    expect(() => strategy.getResolution('2026-02-29')).toThrow(ZodError);
    expect(() => strategy.getCalendar('2026-02-29')).toThrow(ZodError);
    expect(strategy.listPortfolios()).toEqual([]);
  });

  it('returns defensive copies so later input or result edits cannot alter persisted history', () => {
    const { db, strategy } = setup();
    const input = portfolio();
    const original = structuredClone(input);
    const published = strategy.publishPortfolio(input);
    input.combos[0]!.code = '000';
    published.combos[1]!.code = '999';
    published.createdAt.setUTCFullYear(2020);
    const queried = strategy.getPortfolio('2026-10-13')!;
    queried.combos[0]!.weight = 1;
    queried.createdAt.setUTCFullYear(2021);
    const listed = strategy.listPortfolios();
    listed[0]!.date = '2020-01-01';
    db.insert('resolution', '2026-10-13', resolution());
    strategy.getResolution('2026-10-13')!.settlementCode = '999';
    strategy.getCalendar('2026-10-13')[29]!.portfolio!.combos[2]!.code = '000';
    expect(createStrategyModule(db).getPortfolio('2026-10-13')).toEqual(original);
    expect(strategy.getResolution('2026-10-13')).toEqual(resolution());
    expect(strategy.getCalendar('2026-10-13')[29]!.status).toBe('Hit');
  });
});

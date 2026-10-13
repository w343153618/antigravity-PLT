import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fetchOfficialDraws, syncOfficialResolutions } from '../src/modules/lottery-crawler/index.ts';
import { createDatabase } from '../src/shared/database.ts';
import { createRegistryModule } from '../src/modules/registry/index.ts';
import { createStrategyModule } from '../src/modules/strategy/index.ts';
import { createStoreModule } from '../src/modules/store/index.ts';

describe('lottery-crawler', () => {
  it('parses simulated official draw response correctly', async () => {
    const mockFetch = (async () => ({
      ok: true,
      json: async () => ({
        code: 1,
        info: '成功',
        data: {
          data: {
            list: [
              { code: '26272', day: '2026-10-13', one: 8, two: 9, three: 0 },
              { code: '26271', day: '2026-10-12', one: 6, two: 2, three: 2 },
            ],
          },
        },
      }),
    })) as unknown as typeof fetch;

    const draws = await fetchOfficialDraws(2, mockFetch);
    expect(draws).toHaveLength(2);
    expect(draws[0]).toEqual({
      issue: '26272',
      date: '2026-10-13',
      code: '890',
      quotaPerUnit: 1040,
    });
    expect(draws[1]).toEqual({
      issue: '26271',
      date: '2026-10-12',
      code: '622',
      quotaPerUnit: 1040,
    });
  });

  it('syncs unrecorded resolution dates into registry and updates calendar', async () => {
    const db = createDatabase(':memory:');
    const strategy = createStrategyModule(db);
    const stores = createStoreModule(db);
    const registry = createRegistryModule(db, stores, strategy);

    // Publish a strategy for 2026-10-13 with 3 combos
    strategy.publishPortfolio({
      id: randomUUID(),
      date: '2026-10-13',
      combos: [
        { code: '890', weight: 33 },
        { code: '123', weight: 33 },
        { code: '456', weight: 34 },
      ],
      createdAt: new Date(),
    });

    // Calendar for 2026-10-13 is initially pending
    const before = strategy.getCalendar('2026-10-13');
    expect(before[29]?.date).toBe('2026-10-13');
    expect(before[29]?.status).toBeNull();

    const mockFetch = (async () => ({
      ok: true,
      json: async () => ({
        code: 1,
        info: '成功',
        data: {
          data: {
            list: [
              { code: '26272', day: '2026-10-13', one: 8, two: 9, three: 0 },
            ],
          },
        },
      }),
    })) as unknown as typeof fetch;

    const syncResult = await syncOfficialResolutions(registry, strategy, { limit: 1, fetchImpl: mockFetch });
    expect(syncResult.synced).toEqual([{ date: '2026-10-13', code: '890', issue: '26272' }]);

    // Calendar day for 2026-10-13 is now Hit because 890 matches combo
    const after = strategy.getCalendar('2026-10-13');
    expect(after[29]?.date).toBe('2026-10-13');
    expect(after[29]?.status).toBe('Hit');
    expect(after[29]?.resolution?.settlementCode).toBe('890');
  });

  it('skips dates that already have a resolution', async () => {
    const db = createDatabase(':memory:');
    const strategy = createStrategyModule(db);
    const stores = createStoreModule(db);
    const registry = createRegistryModule(db, stores, strategy);

    registry.recordResolution({ date: '2026-10-13', settlementCode: '890', quotaPerUnit: 1040 });

    const mockFetch = (async () => ({
      ok: true,
      json: async () => ({
        code: 1,
        info: '成功',
        data: {
          data: {
            list: [
              { code: '26272', day: '2026-10-13', one: 8, two: 9, three: 0 },
            ],
          },
        },
      }),
    })) as unknown as typeof fetch;

    const syncResult = await syncOfficialResolutions(registry, strategy, { limit: 1, fetchImpl: mockFetch });
    expect(syncResult.synced).toEqual([]);
    expect(syncResult.skipped).toEqual(['2026-10-13']);
  });
});

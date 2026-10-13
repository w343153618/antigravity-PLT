import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/shared/database.ts';
import { createStoreModule } from '../src/modules/store/index.ts';
import { createStrategyModule } from '../src/modules/strategy/index.ts';
import { createRegistryModule } from '../src/modules/registry/index.ts';
import { createReconciliationModule } from '../src/modules/reconciliation/index.ts';
import { seedDemo } from '../src/app/seed.ts';

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture() {
  const db = createDatabase(); databases.push(db);
  const stores = createStoreModule(db);
  const strategy = createStrategyModule(db);
  const registry = createRegistryModule(db, stores, strategy);
  const reconciliation = createReconciliationModule(db, stores);
  return { db, stores, strategy, registry, reconciliation };
}

describe('Phase 3 synthetic seed', () => {
  it('adds labelled historical reconciliation and custody examples while preserving Phase 2 counts', () => {
    const f = fixture();
    seedDemo(f.db, f.stores, f.strategy, f.registry, '2026-10-13');
    expect(f.stores.listStores()).toHaveLength(2);
    expect(f.stores.listManagers()).toHaveLength(2);
    for (const store of f.stores.listStores()) {
      const clients = f.stores.listClients(store.id);
      expect(clients).toHaveLength(3);
      const source = clients.find((client) => client.name === '周先生（模拟）')!;
      const introduced = clients.find((client) => client.name === '许女士（模拟）')!;
      expect(introduced.introducedByClientId).toBe(source.id);
      expect(source).toMatchObject({ createdDate: '2026-09-14', reconciliationBalance: 100.25 });
      const entries = f.reconciliation.listForClient(source.id);
      expect(entries).toHaveLength(2);
      expect(entries.find((entry) => entry.direction === 'ADJUST_IN')).toMatchObject({ amount: 120.5, balanceAfter: 120.5, date: '2026-09-14' });
      expect(entries.find((entry) => entry.direction === 'ADJUST_OUT')).toMatchObject({ amount: 20.25, balanceAfter: 100.25, date: '2026-10-12' });
      expect(entries.every((entry) => entry.note.includes('合成') && entry.note.includes('已线下发生'))).toBe(true);
      const orders = f.registry.listOrders(store.id);
      expect(orders).toHaveLength(30);
      expect(orders.filter(({ orderSlip }) => orderSlip.voucherStatus === 'Claimed')).toHaveLength(20);
      expect(orders.find(({ orderSlip }) => orderSlip.date === '2026-10-13')?.orderSlip.voucherStatus).toBe('StoredInShop');
    }
    expect(f.stores.listAttributionAudits()).toHaveLength(6);
    expect(f.reconciliation.listLedger()).toHaveLength(8);
    expect(f.strategy.getCalendar('2026-10-13').at(-1)?.status).toBeNull();
  });

  it('does not append or rewrite examples when invoked again on an existing seeded database', () => {
    const f = fixture();
    seedDemo(f.db, f.stores, f.strategy, f.registry, '2026-10-13');
    const snapshot = {
      clients: f.stores.listStores().flatMap((store) => f.stores.listClients(store.id)),
      audits: f.stores.listAttributionAudits(),
      ledger: f.reconciliation.listLedger(),
      orders: f.stores.listStores().flatMap((store) => f.registry.listOrders(store.id)),
    };
    seedDemo(f.db, f.stores, f.strategy, f.registry, '2026-10-14');
    expect({
      clients: f.stores.listStores().flatMap((store) => f.stores.listClients(store.id)),
      audits: f.stores.listAttributionAudits(),
      ledger: f.reconciliation.listLedger(),
      orders: f.stores.listStores().flatMap((store) => f.registry.listOrders(store.id)),
    }).toEqual(snapshot);
    expect(f.strategy.getPortfolio('2026-10-14')).toBeUndefined();
  });

  it('keeps populated business data untouched without adding synthetic reconciliation', () => {
    const f = fixture();
    const store = f.stores.addStore({ id: randomUUID(), name: '已有门店' });
    seedDemo(f.db, f.stores, f.strategy, f.registry, '2026-10-13');
    expect(f.stores.listStores()).toEqual([store]);
    expect(f.stores.listManagers()).toEqual([]);
    expect(f.stores.listAttributionAudits()).toEqual([]);
    expect(f.reconciliation.listLedger()).toEqual([]);
    expect(f.registry.listOrders(store.id)).toEqual([]);
    expect(f.strategy.getPortfolio('2026-10-13')).toBeUndefined();
  });

  it('rolls back all seed entities when a sample audit cannot be recorded', () => {
    const f = fixture();
    const unavailableLedger = {
      ...f.db,
      insert(kind: string, id: string, value: unknown) {
        if (kind === 'reconciliation_ledger') throw new Error('Ledger unavailable');
        f.db.insert(kind, id, value);
      },
    };
    expect(() => seedDemo(unavailableLedger, f.stores, f.strategy, f.registry, '2026-10-13')).toThrow('Ledger unavailable');
    expect(f.stores.listStores()).toEqual([]);
    expect(f.stores.listManagers()).toEqual([]);
    expect(f.stores.listAttributionAudits()).toEqual([]);
    expect(f.reconciliation.listLedger()).toEqual([]);
    seedDemo(f.db, f.stores, f.strategy, f.registry, '2026-10-13');
    expect(f.stores.listStores()).toHaveLength(2);
    expect(f.reconciliation.listLedger()).toHaveLength(8);
  });
});

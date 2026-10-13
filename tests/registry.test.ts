import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from '../src/shared/database.ts';
import { createStoreModule } from '../src/modules/store/index.ts';
import { createStrategyModule } from '../src/modules/strategy/index.ts';
import { createRegistryModule } from '../src/modules/registry/index.ts';

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture(filename?: string) {
  const db = createDatabase(filename); databases.push(db);
  const stores = createStoreModule(db);
  const strategy = createStrategyModule(db);
  const registry = createRegistryModule(db, stores, strategy);
  const store = stores.addStore({ id: randomUUID(), name: '南京 1 店' });
  const manager = stores.addManager({ id: randomUUID(), storeId: store.id, name: '店长' });
  const client = stores.addClient({ id: randomUUID(), storeId: store.id, name: '客户' });
  const input = {
    id: randomUUID(), storeId: store.id, clientId: client.id, date: '2026-10-13',
    adoptedStrategy: false, selectedCode: '038', quantity: 1, totalAmount: 2, createdAt: new Date(),
  };
  return { db, stores, strategy, registry, store, manager, client, input };
}

describe('Registry module', () => {
  it('registers a completed OrderSlip with the responsible manager attribution', () => {
    const f = fixture();
    const registered = f.registry.registerOrder(f.manager.id, f.input);
    expect(registered).toEqual({ orderSlip: { ...f.input, voucherStatus: 'StoredInShop' }, managerId: f.manager.id });
    expect(f.registry.listOrders(f.store.id)).toEqual([registered]);
  });

  it('rejects a manager or client from another store and missing references', () => {
    const f = fixture();
    const other = f.stores.addStore({ id: randomUUID(), name: '南京 2 店' });
    const manager = f.stores.addManager({ id: randomUUID(), storeId: other.id, name: '店长 2' });
    const client = f.stores.addClient({ id: randomUUID(), storeId: other.id, name: '客户 2' });
    expect(() => f.registry.registerOrder(manager.id, f.input)).toThrow('StoreManager');
    expect(() => f.registry.registerOrder(f.manager.id, { ...f.input, clientId: client.id })).toThrow('Client');
    expect(() => f.registry.registerOrder(randomUUID(), f.input)).toThrow('StoreManager');
    expect(() => f.registry.registerOrder(f.manager.id, { ...f.input, clientId: randomUUID() })).toThrow('Client');
    expect(() => f.registry.registerOrder(f.manager.id, { ...f.input, storeId: randomUUID() })).toThrow('Store');
    expect(f.registry.listOrders(f.store.id)).toEqual([]);
  });

  it('requires the adopted code to belong to a published portfolio for the same date', () => {
    const f = fixture();
    const adopted = { ...f.input, adoptedStrategy: true };
    expect(() => f.registry.registerOrder(f.manager.id, adopted)).toThrow('StrategyPortfolio');
    f.strategy.publishPortfolio({ id: randomUUID(), date: f.input.date, createdAt: new Date(), combos: [
      { code: '038', weight: 30 }, { code: '083', weight: 30 }, { code: '000', weight: 40 },
    ] });
    expect(() => f.registry.registerOrder(f.manager.id, { ...adopted, selectedCode: '999' })).toThrow('StrategyPortfolio');
    expect(f.registry.registerOrder(f.manager.id, adopted).orderSlip.adoptedStrategy).toBe(true);
  });

  it('records a ResolutionEvent and creates attributable bills from exact three-digit matches', () => {
    const f = fixture();
    f.registry.registerOrder(f.manager.id, f.input);
    const miss = { ...f.input, id: randomUUID(), selectedCode: '083' };
    f.registry.registerOrder(f.manager.id, miss);
    const resolution = { date: f.input.date, settlementCode: '038', quotaPerUnit: 1040 };
    const result = f.registry.recordResolution(resolution);
    expect(result.resolution).toEqual(resolution);
    expect(result.bills).toHaveLength(2);
    expect(result.bills.find((bill) => bill.orderSlipId === f.input.id)).toEqual({
      id: f.input.id, orderSlipId: f.input.id, storeId: f.store.id, clientId: f.client.id,
      managerId: f.manager.id, date: f.input.date,
      grossGain: 1040, netGain: 1038, performanceFee: 0, managerIncentive: 0, platformMargin: 0, clientNetGain: 1038,
    });
    expect(result.bills.find((bill) => bill.orderSlipId === miss.id)?.grossGain).toBe(0);
    expect(f.registry.listBills(f.store.id)).toEqual(result.bills);
    expect(f.strategy.getResolution(f.input.date)).toEqual(resolution);
  });

  it('replays the same ResolutionEvent idempotently and rejects conflicts and late slips', () => {
    const f = fixture();
    f.registry.registerOrder(f.manager.id, f.input);
    const event = { date: f.input.date, settlementCode: '038', quotaPerUnit: 1040 };
    const result = f.registry.recordResolution(event);
    expect(f.registry.recordResolution(event)).toEqual(result);
    expect(() => f.registry.recordResolution({ ...event, settlementCode: '083' })).toThrow('ResolutionEvent');
    expect(() => f.registry.recordResolution({ ...event, quotaPerUnit: 1000 })).toThrow('ResolutionEvent');
    expect(() => f.registry.registerOrder(f.manager.id, { ...f.input, id: randomUUID() })).toThrow('resolved');
    expect(f.registry.listBills(f.store.id)).toHaveLength(1);
  });

  it('summarizes exact cents and isolates each store while settling the whole date', () => {
    const f = fixture();
    f.strategy.publishPortfolio({ id: randomUUID(), date: f.input.date, createdAt: new Date(), combos: [
      { code: '038', weight: 30 }, { code: '083', weight: 30 }, { code: '000', weight: 40 },
    ] });
    f.registry.registerOrder(f.manager.id, { ...f.input, totalAmount: 0.01, adoptedStrategy: true });
    f.registry.registerOrder(f.manager.id, { ...f.input, id: randomUUID(), totalAmount: 0.01, adoptedStrategy: true });
    f.registry.registerOrder(f.manager.id, { ...f.input, id: randomUUID(), date: '2026-10-14', totalAmount: 0.1 });
    const other = f.stores.addStore({ id: randomUUID(), name: '门店 2' });
    const manager = f.stores.addManager({ id: randomUUID(), storeId: other.id, name: '店长 2' });
    const client = f.stores.addClient({ id: randomUUID(), storeId: other.id, name: '客户 2' });
    f.registry.registerOrder(manager.id, { ...f.input, id: randomUUID(), storeId: other.id, clientId: client.id, totalAmount: 0.01 });
    expect(f.registry.recordResolution({ date: f.input.date, settlementCode: '038', quotaPerUnit: 0.36 }).bills).toHaveLength(3);
    expect(f.registry.summarize(f.store.id)).toEqual({
      storeId: f.store.id, orderCount: 3, settledCount: 2, totalAmount: 0.12,
      grossGain: 0.72, netGain: 0.7, performanceFee: 0.14, managerIncentive: 0.08, platformMargin: 0.06, clientNetGain: 0.56,
    });
    expect(f.registry.summarize(other.id).clientNetGain).toBe(0.35);
    expect(f.registry.listOrders(other.id)).toHaveLength(1);
    expect(f.registry.listBills(other.id)).toHaveLength(1);
  });

  it('rolls back all bills and the ResolutionEvent when any order overflows', () => {
    const f = fixture();
    f.registry.registerOrder(f.manager.id, f.input);
    f.registry.registerOrder(f.manager.id, { ...f.input, id: randomUUID(), quantity: Number.MAX_SAFE_INTEGER });
    expect(() => f.registry.recordResolution({ date: f.input.date, settlementCode: '038', quotaPerUnit: 1040 })).toThrow(RangeError);
    expect(f.strategy.getResolution(f.input.date)).toBeUndefined();
    expect(f.registry.listBills(f.store.id)).toEqual([]);
    expect(f.registry.listOrders(f.store.id)).toHaveLength(2);
    const result = f.registry.recordResolution({ date: f.input.date, settlementCode: '083', quotaPerUnit: 1040 });
    expect(result.bills).toHaveLength(2);
    expect(result.bills.every((bill) => bill.grossGain === 0)).toBe(true);
  });

  it('rejects summary overflow without changing stored orders', () => {
    const f = fixture();
    f.registry.registerOrder(f.manager.id, { ...f.input, totalAmount: 90071992547409.9 });
    f.registry.registerOrder(f.manager.id, { ...f.input, id: randomUUID(), totalAmount: 2 });
    expect(() => f.registry.summarize(f.store.id)).toThrow(RangeError);
    expect(f.registry.listOrders(f.store.id)).toHaveLength(2);
  });

  it('rejects summary precision loss even within safe integer cents', () => {
    const f = fixture();
    f.registry.registerOrder(f.manager.id, { ...f.input, totalAmount: 70368744177664 });
    f.registry.registerOrder(f.manager.id, { ...f.input, id: randomUUID(), totalAmount: 0.01 });
    expect(() => f.registry.summarize(f.store.id)).toThrow(RangeError);
  });

  it('persists entities, dates, registrations and idempotent bills across database reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'registry-module-'));
    try {
      const filename = join(directory, 'app.db');
      const f = fixture(filename);
      f.registry.registerOrder(f.manager.id, f.input);
      const event = { date: f.input.date, settlementCode: '038', quotaPerUnit: 1040 };
      const result = f.registry.recordResolution(event);
      f.db.close(); databases.splice(databases.indexOf(f.db), 1);
      const db = createDatabase(filename); databases.push(db);
      const stores = createStoreModule(db);
      const registry = createRegistryModule(db, stores, createStrategyModule(db));
      expect(stores.getStore(f.store.id)).toEqual(f.store);
      expect(stores.getManager(f.manager.id)).toEqual(f.manager);
      expect(stores.getClient(f.client.id)).toEqual(f.client);
      expect(registry.listOrders(f.store.id)[0]?.orderSlip.createdAt).toBeInstanceOf(Date);
      expect(registry.recordResolution(event)).toEqual(result);
      expect(registry.summarize(f.store.id).settledCount).toBe(1);
      db.close(); databases.splice(databases.indexOf(db), 1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('keeps empty summaries explicit and rejects unknown store reads', () => {
    const f = fixture();
    expect(f.registry.summarize(f.store.id)).toEqual({
      storeId: f.store.id, orderCount: 0, settledCount: 0, totalAmount: 0,
      grossGain: 0, netGain: 0, performanceFee: 0, managerIncentive: 0, platformMargin: 0, clientNetGain: 0,
    });
    expect(() => f.registry.listOrders(randomUUID())).toThrow();
    expect(() => f.registry.listBills(randomUUID())).toThrow();
    expect(() => f.registry.summarize(randomUUID())).toThrow();
    expect(f.registry.recordResolution({ date: f.input.date, settlementCode: '000', quotaPerUnit: 1040 }).bills).toEqual([]);
  });

  it('rejects duplicate orders and malformed result contracts', () => {
    const f = fixture();
    f.registry.registerOrder(f.manager.id, f.input);
    expect(() => f.registry.registerOrder(f.manager.id, f.input)).toThrow();
    expect(() => f.registry.recordResolution({ date: f.input.date, settlementCode: '38', quotaPerUnit: 1040 })).toThrow();
    expect(f.registry.listOrders(f.store.id)).toHaveLength(1);
  });
});

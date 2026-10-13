import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/shared/database.ts';
import { createStoreModule } from '../src/modules/store/index.ts';
import { createStrategyModule } from '../src/modules/strategy/index.ts';
import { createRegistryModule } from '../src/modules/registry/index.ts';

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
function fixture() {
  const db = createDatabase(); databases.push(db);
  const stores = createStoreModule(db);
  const store = stores.addStore({ id: randomUUID(), name: '档案门店' });
  const manager = stores.addManager({ id: randomUUID(), storeId: store.id, name: '操作店长' });
  const client = stores.addClient({ id: randomUUID(), storeId: store.id, name: '客户' });
  const registry = createRegistryModule(db, stores, createStrategyModule(db));
  const order = registry.registerOrder(manager.id, {
    id: randomUUID(), storeId: store.id, clientId: client.id, date: '2026-10-13',
    selectedCode: '038', adoptedStrategy: false, quantity: 1, totalAmount: 2, createdAt: new Date(),
  });
  return { db, stores, store, manager, client, registry, order };
}

it('keeps an existing paper voucher in the shop until its manager records collection', () => {
  const f = fixture();
  expect(f.order.orderSlip.voucherStatus).toBe('StoredInShop');
  const collected = f.registry.updateVoucherStatus(f.manager.id, f.order.orderSlip.id, 'Claimed');
  expect(collected.orderSlip.voucherStatus).toBe('Claimed');
  expect(f.registry.listClientOrders(f.client.id)).toEqual([collected]);
  expect(f.registry.listVoucherAudits(f.store.id)).toMatchObject([{
    orderSlipId: f.order.orderSlip.id, managerId: f.manager.id, clientId: f.client.id,
    fromStatus: 'StoredInShop', toStatus: 'Claimed',
  }]);
});

it('replays collection without duplicate audits and rejects reversal, foreign actors and invalid states', () => {
  const f = fixture();
  const other = f.stores.addStore({ id: randomUUID(), name: '其他门店' });
  const outsider = f.stores.addManager({ id: randomUUID(), storeId: other.id, name: '其他店长' });
  expect(() => f.registry.updateVoucherStatus(outsider.id, f.order.orderSlip.id, 'Claimed')).toThrow();
  expect(() => f.registry.updateVoucherStatus(randomUUID(), f.order.orderSlip.id, 'Claimed')).toThrow();
  expect(() => f.registry.updateVoucherStatus(f.manager.id, randomUUID(), 'Claimed')).toThrow();
  expect(() => f.registry.updateVoucherStatus(f.manager.id, f.order.orderSlip.id, 'PendingPrint')).toThrow();
  expect(f.registry.updateVoucherStatus(f.manager.id, f.order.orderSlip.id, 'StoredInShop')).toEqual(f.order);
  const first = f.registry.updateVoucherStatus(f.manager.id, f.order.orderSlip.id, 'Claimed');
  expect(f.registry.updateVoucherStatus(f.manager.id, f.order.orderSlip.id, 'Claimed')).toEqual(first);
  expect(() => f.registry.updateVoucherStatus(f.manager.id, f.order.orderSlip.id, 'StoredInShop')).toThrow();
  expect(f.registry.listVoucherAudits(f.store.id)).toHaveLength(1);
  expect(f.registry.listVoucherAudits(other.id)).toEqual([]);
  expect(() => f.registry.listVoucherAudits(randomUUID())).toThrow();
  expect(() => f.registry.listClientOrders(randomUUID())).toThrow();
});

it('exposes old stored slips with the default custody status without altering settlement results', () => {
  const f = fixture();
  const { voucherStatus: _status, ...old } = f.order.orderSlip;
  f.db.set('registration', old.id, { orderSlip: old, managerId: f.manager.id });
  const before = f.registry.recordResolution({ date: old.date, settlementCode: '038', quotaPerUnit: 1040 });
  expect(f.registry.listClientOrders(f.client.id)[0]?.orderSlip.voucherStatus).toBe('StoredInShop');
  f.registry.updateVoucherStatus(f.manager.id, old.id, 'Claimed');
  expect(f.registry.recordResolution(before.resolution)).toEqual(before);
});

it('keeps a clients responsible manager attribution when registering completed historical business', () => {
  const f = fixture();
  const colleague = f.stores.addManager({ id: randomUUID(), storeId: f.store.id, name: '同店其他店长' });
  expect(() => f.registry.registerOrder(colleague.id, { ...f.order.orderSlip, id: randomUUID() })).toThrow('Client');
  const legacyId = randomUUID();
  f.db.insert('client', legacyId, { id: legacyId, storeId: f.store.id, name: '未确认归属旧档案' });
  expect(() => f.registry.registerOrder(f.manager.id, { ...f.order.orderSlip, id: randomUUID(), clientId: legacyId })).toThrow('Client');
});

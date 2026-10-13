import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/shared/database.ts';
import { createStoreModule } from '../src/modules/store/index.ts';

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

describe('Store module', () => {
  it('creates store-scoped managers and clients with validated names', () => {
    const db = createDatabase(); databases.push(db);
    const stores = createStoreModule(db);
    const store = stores.addStore({ id: randomUUID(), name: '南京 1 店' });
    const manager = stores.addManager({ id: randomUUID(), storeId: store.id, name: '店长' });
    const client = stores.addClient({ id: randomUUID(), storeId: store.id, name: '客户' });
    expect(store.address).toBe('');
    expect(stores.listStores()).toEqual([store]);
    expect(stores.listManagers(store.id)).toEqual([manager]);
    expect(stores.listClients(store.id)).toEqual([client]);
  });

  it('keeps references within existing stores and never overwrites duplicate identities', () => {
    const db = createDatabase(); databases.push(db);
    const stores = createStoreModule(db);
    const store = stores.addStore({ id: randomUUID(), name: '门店' });
    const other = stores.addStore({ id: randomUUID(), name: '其他门店' });
    const manager = stores.addManager({ id: randomUUID(), storeId: store.id, name: '店长' });
    const client = stores.addClient({ id: randomUUID(), storeId: store.id, name: '客户' });
    expect(() => stores.addManager({ id: randomUUID(), storeId: randomUUID(), name: '店长' })).toThrow('Store');
    expect(() => stores.addClient({ id: randomUUID(), storeId: randomUUID(), name: '客户' })).toThrow('Store');
    expect(() => stores.addStore({ ...store, name: '改名' })).toThrow();
    expect(() => stores.addManager({ ...manager, storeId: other.id })).toThrow();
    expect(() => stores.addClient({ ...client, storeId: other.id })).toThrow();
    expect(stores.getStore(store.id)).toEqual(store);
    expect(stores.getManager(manager.id)).toEqual(manager);
    expect(stores.getClient(client.id)).toEqual(client);
    expect(stores.getStore(randomUUID())).toBeUndefined();
    expect(stores.getManager(randomUUID())).toBeUndefined();
    expect(stores.getClient(randomUUID())).toBeUndefined();
    expect(stores.listManagers()).toEqual([manager]);
    expect(stores.listManagers(other.id)).toEqual([]);
    expect(stores.listClients(other.id)).toEqual([]);
    expect(() => stores.listManagers(randomUUID())).toThrow();
    expect(() => stores.listClients(randomUUID())).toThrow();
  });

  it('rejects invalid contracts while normalizing harmless whitespace', () => {
    const db = createDatabase(); databases.push(db);
    const stores = createStoreModule(db);
    expect(() => stores.addStore({ id: randomUUID(), name: '  ' })).toThrow();
    expect(() => stores.addStore({ id: randomUUID(), name: '门店', owner: 'x' })).toThrow();
    expect(() => stores.addStore({ id: 'invalid', name: '门店' })).toThrow();
    const store = stores.addStore({ id: randomUUID(), name: ' 门店 ', address: ' 南京 ' });
    expect(store.name).toBe('门店');
    expect(store.address).toBe('南京');
  });
});

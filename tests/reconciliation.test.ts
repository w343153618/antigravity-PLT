import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from '../src/shared/database.ts';
import { createStoreModule } from '../src/modules/store/index.ts';
import { createReconciliationModule } from '../src/modules/reconciliation/index.ts';

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => { vi.useRealTimers(); databases.splice(0).forEach((db) => db.close()); });

function fixture(filename?: string) {
  const db = createDatabase(filename); databases.push(db);
  const stores = createStoreModule(db);
  const store = stores.addStore({ id: randomUUID(), name: '南京档案门店' });
  const manager = stores.addManager({ id: randomUUID(), storeId: store.id, name: '档案店长' });
  const client = stores.addClient({ id: randomUUID(), storeId: store.id, managerId: manager.id, name: '往来客户' });
  const reconciliation = createReconciliationModule(db, stores);
  const input = { managerId: manager.id, clientId: client.id, date: '2026-10-13', direction: 'ADJUST_IN' as const, amount: 0.1, note: '已线下收款，事后登记' };
  return { db, stores, store, manager, client, reconciliation, input };
}

describe('Post-facto reconciliation', () => {
  it('records completed offline receipts and exposes the exact balance and audit entry', () => {
    const f = fixture();
    const entry = f.reconciliation.adjust(f.input);
    expect(entry).toMatchObject({ ...f.input, storeId: f.store.id, balanceAfter: 0.1 });
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.createdAt).toBeInstanceOf(Date);
    expect(f.stores.getClient(f.client.id)?.reconciliationBalance).toBe(0.1);
    expect(f.reconciliation.listForClient(f.client.id)).toEqual([entry]);
  });

  it('adds and subtracts decimal cents without drift and can reconcile exactly to zero', () => {
    const f = fixture();
    f.reconciliation.adjust(f.input);
    expect(f.reconciliation.adjust({ ...f.input, amount: 0.2 }).balanceAfter).toBe(0.3);
    const entry = f.reconciliation.adjust({ ...f.input, direction: 'ADJUST_OUT', amount: 0.3, note: '线下支用核减' });
    expect(entry.balanceAfter).toBe(0);
    expect(f.stores.getClient(f.client.id)?.reconciliationBalance).toBe(0);
    expect(f.reconciliation.listForClient(f.client.id)).toHaveLength(3);
  });

  it('rejects a reduction below zero without changing either balance or ledger', () => {
    const f = fixture();
    const receipt = f.reconciliation.adjust(f.input);
    expect(() => f.reconciliation.adjust({ ...f.input, direction: 'ADJUST_OUT', amount: 0.11 }))
      .toThrow('核减金额超过当前对账结余');
    expect(f.stores.getClient(f.client.id)?.reconciliationBalance).toBe(0.1);
    expect(f.reconciliation.listForClient(f.client.id)).toEqual([receipt]);
  });

  it('permits only the client’s attributed manager, including within the same store', () => {
    const f = fixture();
    const colleague = f.stores.addManager({ id: randomUUID(), storeId: f.store.id, name: '同店其他店长' });
    const otherStore = f.stores.addStore({ id: randomUUID(), name: '另一门店' });
    const outsider = f.stores.addManager({ id: randomUUID(), storeId: otherStore.id, name: '跨店店长' });
    for (const managerId of [colleague.id, outsider.id, randomUUID()]) {
      expect(() => f.reconciliation.adjust({ ...f.input, managerId })).toThrow('StoreManager');
    }
    expect(() => f.reconciliation.adjust({ ...f.input, clientId: randomUUID() })).toThrow('Client');
    expect(f.stores.getClient(f.client.id)?.reconciliationBalance).toBe(0);
    expect(f.reconciliation.listForClient(f.client.id)).toEqual([]);
  });

  it.each([
    [90071992547409.9, 0.02],
    [70368744177664, 0.01],
  ])('rejects unsafe or unrepresentable balances atomically (%s + %s)', (initial, addition) => {
    const f = fixture();
    const entry = f.reconciliation.adjust({ ...f.input, amount: initial });
    expect(() => f.reconciliation.adjust({ ...f.input, amount: addition })).toThrow(RangeError);
    expect(f.stores.getClient(f.client.id)?.reconciliationBalance).toBe(initial);
    expect(f.reconciliation.listForClient(f.client.id)).toEqual([entry]);
  });

  it('queries complete history by client, store and intersecting HQ audit filters', () => {
    const f = fixture();
    const first = f.reconciliation.adjust(f.input);
    const second = f.reconciliation.adjust({ ...f.input, date: '2026-10-14', amount: 0.2 });
    const otherStore = f.stores.addStore({ id: randomUUID(), name: '另一门店' });
    const manager = f.stores.addManager({ id: randomUUID(), storeId: otherStore.id, name: '另一店长' });
    const client = f.stores.addClient({ id: randomUUID(), storeId: otherStore.id, managerId: manager.id, name: '另一客户' });
    const third = f.reconciliation.adjust({ ...f.input, managerId: manager.id, clientId: client.id });
    expect(f.reconciliation.listForStore(f.store.id)).toHaveLength(2);
    expect(f.reconciliation.listForClient(client.id)).toEqual([third]);
    expect(f.reconciliation.listLedger()).toHaveLength(3);
    expect(f.reconciliation.listLedger({ managerId: f.manager.id, date: '2026-10-13' })).toEqual([first]);
    expect(f.reconciliation.listLedger({ storeId: f.store.id, clientId: f.client.id, date: '2026-10-14' })).toEqual([second]);
    expect(f.reconciliation.listLedger({ storeId: otherStore.id, clientId: f.client.id })).toEqual([]);
  });

  it('distinguishes empty client history from an unknown client or store', () => {
    const f = fixture();
    expect(f.reconciliation.listForClient(f.client.id)).toEqual([]);
    expect(f.reconciliation.listForStore(f.store.id)).toEqual([]);
    expect(() => f.reconciliation.listForClient(randomUUID())).toThrow('Client');
    expect(() => f.reconciliation.listForStore(randomUUID())).toThrow('Store');
    expect(() => f.reconciliation.listLedger({ date: '2026-02-30' })).toThrow();
    expect(() => f.reconciliation.listLedger({ clientId: 'invalid-id' })).toThrow();
  });

  it.each([
    { amount: 0 }, { amount: -0.01 }, { amount: 0.001 }, { amount: Number.POSITIVE_INFINITY },
    { amount: 90071992547410 }, { note: '' }, { note: '   ' }, { note: '字'.repeat(201) },
    { date: '2026-02-30' }, { date: '2026-10-13T00:00:00Z' }, { direction: 'ORDER_DEBIT' },
    { managerId: 'invalid' }, { clientId: 'invalid' }, { storeId: randomUUID() },
  ])('rejects malformed adjustment %j without creating history', (invalid) => {
    const f = fixture();
    expect(() => f.reconciliation.adjust({ ...f.input, ...invalid })).toThrow();
    expect(f.stores.getClient(f.client.id)?.reconciliationBalance).toBe(0);
    expect(f.reconciliation.listForClient(f.client.id)).toEqual([]);
  });

  it('rejects unattributed legacy clients instead of assigning a manager during an adjustment', () => {
    const f = fixture();
    const legacyId = randomUUID();
    // Import a Phase 2 snapshot through the database adapter; observe it through modules.
    f.db.insert('client', legacyId, { id: legacyId, storeId: f.store.id, name: '未归属的历史档案' });
    expect(() => f.reconciliation.adjust({ ...f.input, clientId: legacyId })).toThrow('StoreManager');
    expect(f.stores.getClient(legacyId)?.reconciliationBalance).toBe(0);
    expect(f.reconciliation.listForClient(legacyId)).toEqual([]);
  });

  it('keeps returned entries and balances detached from immutable stored audit snapshots', () => {
    const f = fixture();
    const entry = f.reconciliation.adjust({ ...f.input, note: '  线下收款备注  ' });
    const expected = { ...entry, createdAt: new Date(entry.createdAt) };
    entry.note = 'attempted rewrite';
    entry.createdAt.setFullYear(2000);
    const client = f.stores.getClient(f.client.id)!;
    client.reconciliationBalance = 999;
    const listed = f.reconciliation.listForClient(f.client.id);
    listed[0]!.balanceAfter = 999;
    expect(f.reconciliation.listForClient(f.client.id)).toEqual([expected]);
    expect(expected.note).toBe('线下收款备注');
    expect(f.stores.getClient(f.client.id)?.reconciliationBalance).toBe(0.1);
  });

  it('rolls back the balance when the database cannot append its audit entry', () => {
    const f = fixture();
    const failure = new Error('database insert unavailable');
    const unavailableDatabase = { ...f.db, insert() { throw failure; } };
    const reconciliation = createReconciliationModule(unavailableDatabase, f.stores);
    expect(() => reconciliation.adjust(f.input)).toThrow(failure);
    expect(f.stores.getClient(f.client.id)?.reconciliationBalance).toBe(0);
    expect(f.reconciliation.listForClient(f.client.id)).toEqual([]);
    expect(f.reconciliation.adjust(f.input).balanceAfter).toBe(0.1);
  });

  it('persists exact balances and complete audit history across a real database reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'reconciliation-module-'));
    try {
      const filename = join(directory, 'app.db');
      const f = fixture(filename);
      const receipt = f.reconciliation.adjust({ ...f.input, amount: 12.34 });
      const reduction = f.reconciliation.adjust({ ...f.input, direction: 'ADJUST_OUT', amount: 0.34 });
      f.db.close(); databases.splice(databases.indexOf(f.db), 1);
      const reopened = createDatabase(filename); databases.push(reopened);
      const stores = createStoreModule(reopened);
      const reconciliation = createReconciliationModule(reopened, stores);
      expect(stores.getClient(f.client.id)?.reconciliationBalance).toBe(12);
      expect(reconciliation.listForClient(f.client.id)).toEqual(expect.arrayContaining([receipt, reduction]));
      expect(reconciliation.listForStore(f.store.id)).toHaveLength(2);
      expect(reconciliation.listForClient(f.client.id)[0]?.createdAt).toBeInstanceOf(Date);
      reopened.close(); databases.splice(databases.indexOf(reopened), 1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('preserves append order for same-millisecond adjustments and resumes the sequence after reopening', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T08:00:00Z'));
    const directory = mkdtempSync(join(tmpdir(), 'reconciliation-sequence-'));
    try {
      const filename = join(directory, 'app.db');
      const f = fixture(filename);
      for (let index = 0; index < 10; index += 1) f.reconciliation.adjust({ ...f.input, amount: 1 });
      const expected = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      expect(f.reconciliation.listForClient(f.client.id).map((entry) => entry.sequence)).toEqual(expected);
      expect(f.reconciliation.listForClient(f.client.id).map((entry) => entry.balanceAfter)).toEqual(expected);
      f.db.close(); databases.splice(databases.indexOf(f.db), 1);
      const reopened = createDatabase(filename); databases.push(reopened);
      const stores = createStoreModule(reopened);
      const reconciliation = createReconciliationModule(reopened, stores);
      expect(reconciliation.adjust({ ...f.input, amount: 1 })).toMatchObject({ sequence: 11, balanceAfter: 11 });
      expect(reconciliation.listForClient(f.client.id).map((entry) => entry.balanceAfter)).toEqual([...expected, 11]);
    } finally {
      databases.splice(0).forEach((db) => db.close());
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps unsequenced legacy history stable before newly appended entries', () => {
    const f = fixture();
    const ids = [
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ];
    for (const [index, id] of ids.entries()) {
      f.db.insert('reconciliation_ledger', id, {
        ...f.input, id, storeId: f.store.id, amount: 1, balanceAfter: index + 1,
        createdAt: new Date(index === 0 ? '2026-10-12T08:00:00Z' : '2026-10-13T08:00:00Z'),
      });
    }
    f.db.set('client', f.client.id, { ...f.client, reconciliationBalance: 3 });
    expect(f.reconciliation.listForClient(f.client.id).map((entry) => entry.id)).toEqual(ids);
    expect(f.reconciliation.adjust({ ...f.input, amount: 1 })).toMatchObject({ sequence: 1, balanceAfter: 4 });
    expect(f.reconciliation.listForClient(f.client.id).map((entry) => entry.balanceAfter)).toEqual([1, 2, 3, 4]);
  });

  it('refuses append-sequence overflow without changing the balance or ledger', () => {
    const f = fixture();
    const id = randomUUID();
    f.db.insert('reconciliation_ledger', id, {
      ...f.input, id, storeId: f.store.id, amount: 1, balanceAfter: 1,
      createdAt: new Date(), sequence: Number.MAX_SAFE_INTEGER,
    });
    f.db.set('client', f.client.id, { ...f.client, reconciliationBalance: 1 });
    expect(() => f.reconciliation.adjust({ ...f.input, amount: 1 })).toThrow();
    expect(f.stores.getClient(f.client.id)?.reconciliationBalance).toBe(1);
    expect(f.reconciliation.listForClient(f.client.id)).toHaveLength(1);
  });
});

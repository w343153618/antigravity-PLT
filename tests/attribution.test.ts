import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from '../src/shared/database.ts';
import { createStoreModule } from '../src/modules/store/index.ts';

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture(filename?: string) {
  const db = createDatabase(filename); databases.push(db);
  const stores = createStoreModule(db);
  const store = stores.addStore({ id: randomUUID(), name: '档案门店' });
  const manager = stores.addManager({ id: randomUUID(), storeId: store.id, name: '店长' });
  return { db, stores, store, manager };
}

describe('Client attribution', () => {
  it('creates a manager-attributed client and a dated creation audit together', () => {
    const f = fixture();
    const client = f.stores.addClient({ id: randomUUID(), managerId: f.manager.id, name: ' 新客户 ', date: '2026-10-14' });
    expect(client).toMatchObject({ storeId: f.store.id, managerId: f.manager.id, name: '新客户', reconciliationBalance: 0, createdDate: '2026-10-14' });
    expect(f.stores.getClient(client.id)).toEqual(client);
    expect(f.stores.listAttributionAudits()).toEqual([{
      id: expect.any(String), clientId: client.id, storeId: f.store.id, managerId: f.manager.id,
      date: '2026-10-14', note: '店长直接建档', createdAt: expect.any(Date), eventType: 'Created',
    }]);
  });

  it('inherits the source store and manager through multiple introductions', () => {
    const f = fixture();
    const source = f.stores.addClient({ id: randomUUID(), managerId: f.manager.id, name: '老客户', date: '2026-10-12' });
    const next = f.stores.addClient({ id: randomUUID(), introducedByClientId: source.id, name: '引荐客户', date: '2026-10-13' });
    const last = f.stores.addClient({ id: randomUUID(), introducedByClientId: next.id, name: '后续引荐', date: '2026-10-14', note: '已核实线下档案' });
    expect(last).toMatchObject({ storeId: f.store.id, managerId: f.manager.id, introducedByClientId: next.id });
    expect(f.stores.listAttributionAudits().find((audit) => audit.clientId === last.id)).toMatchObject({
      introducedByClientId: next.id, date: '2026-10-14', note: '已核实线下档案', managerId: f.manager.id,
    });
  });

  it('preserves store-only callers by inferring the sole manager but rejects ambiguous attribution', () => {
    const f = fixture();
    const client = f.stores.addClient({ id: randomUUID(), storeId: f.store.id, name: '兼容客户' });
    expect(client.managerId).toBe(f.manager.id);
    expect(client.createdDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    f.stores.addManager({ id: randomUUID(), storeId: f.store.id, name: '第二位店长' });
    expect(() => f.stores.addClient({ id: randomUUID(), storeId: f.store.id, name: '归属不明' })).toThrow('StoreManager');
    const noManager = f.stores.addStore({ id: randomUUID(), name: '暂无店长' });
    expect(() => f.stores.addClient({ id: randomUUID(), storeId: noManager.id, name: '归属不明' })).toThrow('StoreManager');
    expect(f.stores.listAttributionAudits()).toHaveLength(1);
  });

  it('rejects conflicting store or manager overrides without creating a partial archive', () => {
    const f = fixture();
    const otherStore = f.stores.addStore({ id: randomUUID(), name: '其他门店' });
    const otherManager = f.stores.addManager({ id: randomUUID(), storeId: otherStore.id, name: '其他店长' });
    const sameStoreManager = f.stores.addManager({ id: randomUUID(), storeId: f.store.id, name: '同店其他店长' });
    const source = f.stores.addClient({ id: randomUUID(), managerId: f.manager.id, name: '原档案' });
    const base = { id: randomUUID(), name: '冲突档案', introducedByClientId: source.id };
    expect(() => f.stores.addClient({ ...base, storeId: otherStore.id })).toThrow('attribution');
    expect(() => f.stores.addClient({ ...base, managerId: otherManager.id })).toThrow('attribution');
    expect(() => f.stores.addClient({ ...base, managerId: sameStoreManager.id })).toThrow('attribution');
    expect(() => f.stores.addClient({ id: randomUUID(), managerId: f.manager.id, storeId: otherStore.id, name: '冲突档案' })).toThrow('attribution');
    expect(f.stores.getClient(base.id)).toBeUndefined();
    expect(f.stores.listAttributionAudits()).toHaveLength(1);
  });

  it('never silently ignores an unknown or unresolved historical introducer', () => {
    const f = fixture();
    const base = { id: randomUUID(), managerId: f.manager.id, name: '新档案' };
    expect(() => f.stores.addClient({ ...base, introducedByClientId: randomUUID() })).toThrow('Client');
    const legacy = { id: randomUUID(), storeId: f.store.id, name: '历史未指定店长档案' };
    f.db.insert('client', legacy.id, legacy);
    expect(f.stores.getClient(legacy.id)).toEqual({ ...legacy, reconciliationBalance: 0 });
    expect(() => f.stores.addClient({ ...base, introducedByClientId: legacy.id })).toThrow('StoreManager');
    expect(f.stores.getClient(base.id)).toBeUndefined();
    expect(f.stores.listAttributionAudits()).toEqual([]);
  });

  it('queries chronological audits and summarizes direct and introduced archives by manager and date', () => {
    const f = fixture();
    const source = f.stores.addClient({ id: randomUUID(), managerId: f.manager.id, name: '源档案', date: '2026-10-13' });
    f.stores.addClient({ id: randomUUID(), introducedByClientId: source.id, name: '引荐档案', date: '2026-10-13' });
    const next = f.stores.addClient({ id: randomUUID(), managerId: f.manager.id, name: '次日档案', date: '2026-10-14' });
    const otherStore = f.stores.addStore({ id: randomUUID(), name: '其他门店' });
    const otherManager = f.stores.addManager({ id: randomUUID(), storeId: otherStore.id, name: '其他店长' });
    f.stores.addClient({ id: randomUUID(), managerId: otherManager.id, name: '其他客户', createdDate: '2026-10-12' });
    expect(f.stores.listAttributionAudits({ storeId: f.store.id, managerId: f.manager.id, date: '2026-10-14' }).map((audit) => audit.clientId)).toEqual([next.id]);
    expect(f.stores.listAttributionAudits().map((audit) => audit.date)).toEqual(['2026-10-12', '2026-10-13', '2026-10-13', '2026-10-14']);
    expect(f.stores.attributionSummary({ managerId: f.manager.id })).toEqual([
      { storeId: f.store.id, managerId: f.manager.id, date: '2026-10-13', directCount: 1, introducedCount: 1, totalCount: 2, newClientCount: 2, migrationCount: 0 },
      { storeId: f.store.id, managerId: f.manager.id, date: '2026-10-14', directCount: 1, introducedCount: 0, totalCount: 1, newClientCount: 1, migrationCount: 0 },
    ]);
    expect(f.stores.attributionSummary({ date: '2026-10-11' })).toEqual([]);
    expect(f.stores.attributionSummary()).toHaveLength(3);
  });

  it('rejects inconsistent imported attribution and conflicting creation dates', () => {
    const f = fixture();
    const otherStore = f.stores.addStore({ id: randomUUID(), name: '另一门店' });
    const inconsistent = { id: randomUUID(), storeId: otherStore.id, managerId: f.manager.id, name: '旧数据归属不一致' };
    f.db.insert('client', inconsistent.id, inconsistent);
    expect(() => f.stores.addClient({ id: randomUUID(), name: '新档案', introducedByClientId: inconsistent.id })).toThrow('attribution');
    expect(() => f.stores.addClient({ id: randomUUID(), managerId: f.manager.id, name: '日期冲突', date: '2026-10-13', createdDate: '2026-10-14' })).toThrow('date');
    expect(f.stores.listAttributionAudits()).toEqual([]);
  });

  it('rolls back the client if its audit cannot be durably recorded', () => {
    const f = fixture();
    const unavailableAuditDatabase = {
      ...f.db,
      insert(kind: string, id: string, value: unknown) {
        if (kind === 'client_attribution_audit') throw new Error('Audit storage unavailable');
        f.db.insert(kind, id, value);
      },
    };
    const stores = createStoreModule(unavailableAuditDatabase);
    const id = randomUUID();
    expect(() => stores.addClient({ id, managerId: f.manager.id, name: '原子建档' })).toThrow('Audit storage unavailable');
    expect(stores.getClient(id)).toBeUndefined();
    expect(stores.listAttributionAudits()).toEqual([]);
  });

  it('preserves original attribution and audit on duplicate identities', () => {
    const f = fixture();
    const source = f.stores.addClient({ id: randomUUID(), managerId: f.manager.id, name: '原档案', date: '2026-10-13' });
    expect(() => f.stores.addClient({ ...source, name: '覆盖档案' })).toThrow();
    expect(f.stores.getClient(source.id)).toEqual(source);
    expect(f.stores.listAttributionAudits()).toHaveLength(1);
    const explicit = f.stores.addClient({ id: randomUUID(), name: '已核实引荐', managerId: f.manager.id, storeId: f.store.id, introducedByClientId: source.id, date: '2026-10-13', createdDate: '2026-10-13' });
    expect(explicit.introducedByClientId).toBe(source.id);
  });

  it('rejects balance injection, malformed records and query filters before persisting', () => {
    const f = fixture();
    const base = { id: randomUUID(), managerId: f.manager.id, name: '新档案' };
    for (const change of [
      { reconciliationBalance: 1 }, { reconciliationBalance: -1 }, { note: '  ' },
      { name: '甲'.repeat(81) }, { date: '2026-02-30' }, { createdDate: 'yesterday' },
      { introducedByClientId: 'invalid' }, { unexpected: true },
    ]) expect(() => f.stores.addClient({ ...base, ...change })).toThrow();
    expect(() => f.stores.addClient({ ...base, managerId: randomUUID() })).toThrow('StoreManager');
    expect(() => f.stores.addClient({ id: randomUUID(), name: '无归属' })).toThrow('StoreManager');
    expect(() => f.stores.listAttributionAudits({ date: 'bad-date' })).toThrow();
    expect(() => f.stores.attributionSummary({ managerId: 'bad-id' })).toThrow();
    expect(f.stores.getClient(base.id)).toBeUndefined();
    expect(f.stores.listAttributionAudits()).toEqual([]);
  });

  it('migrates legacy archives once, preserving known dates and leaving ambiguous attribution unresolved', () => {
    const f = fixture();
    const old = { id: randomUUID(), storeId: f.store.id, name: '旧档案' };
    const assigned = { id: randomUUID(), storeId: f.store.id, managerId: f.manager.id, name: '已知日期旧档案', createdDate: '2026-10-01' };
    f.db.insert('client', old.id, old);
    f.db.insert('client', assigned.id, assigned);
    const ambiguousStore = f.stores.addStore({ id: randomUUID(), name: '无法推断店长门店' });
    f.stores.addManager({ id: randomUUID(), storeId: ambiguousStore.id, name: '甲' });
    f.stores.addManager({ id: randomUUID(), storeId: ambiguousStore.id, name: '乙' });
    const ambiguous = { id: randomUUID(), storeId: ambiguousStore.id, name: '待核实旧档案' };
    f.db.insert('client', ambiguous.id, ambiguous);
    const current = f.stores.addClient({ id: randomUUID(), managerId: f.manager.id, name: '已有审计档案', date: '2026-10-13' });

    expect(f.stores.migrateLegacyClients('2026-10-14')).toEqual({ migrated: 2, unresolvedClientIds: [ambiguous.id] });
    expect(f.stores.getClient(old.id)).toMatchObject({ ...old, managerId: f.manager.id, reconciliationBalance: 0 });
    expect(f.stores.getClient(old.id)?.createdDate).toBeUndefined();
    expect(f.stores.getClient(assigned.id)?.createdDate).toBe('2026-10-01');
    expect(f.stores.getClient(ambiguous.id)?.managerId).toBeUndefined();
    const audit = f.stores.listAttributionAudits().find((item) => item.clientId === old.id);
    expect(audit).toMatchObject({ date: '2026-10-14', note: '旧版档案迁移登记；本日期为迁移登记日，不代表原建档日' });
    expect(f.stores.getClient(current.id)).toEqual(current);
    expect(createStoreModule(f.db).migrateLegacyClients('2026-10-15')).toEqual({ migrated: 0, unresolvedClientIds: [ambiguous.id] });
    expect(f.stores.listAttributionAudits()).toHaveLength(3);
  });

  it('preserves introduction history through migration and database reopen without duplicate audits', () => {
    const directory = mkdtempSync(join(tmpdir(), 'attribution-migration-'));
    try {
      const filename = join(directory, 'app.db');
      const f = fixture(filename);
      const source = f.stores.addClient({ id: randomUUID(), managerId: f.manager.id, name: '来源档案', date: '2026-10-14' });
      const old = { id: randomUUID(), storeId: f.store.id, managerId: f.manager.id, introducedByClientId: source.id, name: '历史引荐档案' };
      f.db.insert('client', old.id, old);
      const otherManager = f.stores.addManager({ id: randomUUID(), storeId: f.store.id, name: '其他店长' });
      f.stores.addClient({ id: randomUUID(), managerId: otherManager.id, name: '同日其他客户', date: '2026-10-14' });
      expect(f.stores.migrateLegacyClients('2026-10-14')).toEqual({ migrated: 1, unresolvedClientIds: [] });
      const summary = f.stores.attributionSummary();
      expect(summary).toHaveLength(2);
      expect(summary).toEqual(expect.arrayContaining([
        { storeId: f.store.id, managerId: f.manager.id, date: '2026-10-14', directCount: 1, introducedCount: 1, totalCount: 2, newClientCount: 1, migrationCount: 1 },
        { storeId: f.store.id, managerId: otherManager.id, date: '2026-10-14', directCount: 1, introducedCount: 0, totalCount: 1, newClientCount: 1, migrationCount: 0 },
      ]));
      f.db.close(); databases.splice(databases.indexOf(f.db), 1);
      const reopened = createDatabase(filename); databases.push(reopened);
      const stores = createStoreModule(reopened);
      expect(stores.migrateLegacyClients('2026-10-15')).toEqual({ migrated: 0, unresolvedClientIds: [] });
      expect(stores.getClient(old.id)?.introducedByClientId).toBe(source.id);
      expect(stores.attributionSummary()).toEqual(summary);
    } finally {
      databases.splice(0).forEach((db) => db.close());
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rolls back legacy migration attribution when audit persistence fails', () => {
    const f = fixture();
    const legacy = { id: randomUUID(), storeId: f.store.id, name: '旧档案' };
    f.db.insert('client', legacy.id, legacy);
    const stores = createStoreModule({
      ...f.db,
      insert() { throw new Error('Audit storage unavailable'); },
    });
    expect(() => stores.migrateLegacyClients('2026-10-14')).toThrow('Audit storage unavailable');
    expect(stores.getClient(legacy.id)).toEqual({ ...legacy, reconciliationBalance: 0 });
    expect(stores.listAttributionAudits()).toEqual([]);
    expect(() => stores.migrateLegacyClients('invalid')).toThrow();
  });

  it('counts real new archives separately from migrations of both known and unknown historical dates', () => {
    const f = fixture();
    const current = f.stores.addClient({ id: randomUUID(), managerId: f.manager.id, name: '当天新建档案', date: '2026-10-14' });
    const unknown = { id: randomUUID(), storeId: f.store.id, name: '未知原建档日期' };
    const known = { id: randomUUID(), storeId: f.store.id, managerId: f.manager.id, name: '已知原建档日期', createdDate: '2026-09-01' };
    f.db.insert('client', unknown.id, unknown);
    f.db.insert('client', known.id, known);
    f.stores.migrateLegacyClients('2026-10-14');
    expect(f.stores.listAttributionAudits().find((audit) => audit.clientId === current.id)?.eventType).toBe('Created');
    for (const client of [unknown, known]) {
      expect(f.stores.listAttributionAudits().find((audit) => audit.clientId === client.id)).toMatchObject({ eventType: 'Migrated', date: '2026-10-14' });
    }
    expect(f.stores.getClient(unknown.id)?.createdDate).toBeUndefined();
    expect(f.stores.getClient(known.id)?.createdDate).toBe('2026-09-01');
    expect(f.stores.attributionSummary({ date: '2026-10-14' })).toEqual([
      { storeId: f.store.id, managerId: f.manager.id, date: '2026-10-14', directCount: 3, introducedCount: 0, totalCount: 3, newClientCount: 1, migrationCount: 2 },
    ]);
  });
});

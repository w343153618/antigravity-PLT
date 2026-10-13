import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppDatabase } from '../../shared/database.ts';
import { DomainError } from '../../shared/errors.ts';
import { ClientSchema, ClientAttributionAuditSchema, StoreManagerSchema, StoreSchema } from '../../shared/schemas/store.ts';
import type { Client, ClientAttributionAudit, Store, StoreManager } from '../../shared/schemas/store.ts';

export type { Client, Store, StoreManager } from '../../shared/schemas/store.ts';

const AttributionFilterSchema = z.strictObject({
  storeId: z.uuid().optional(), managerId: z.uuid().optional(), date: z.iso.date().optional(),
});
export type AttributionFilter = z.infer<typeof AttributionFilterSchema>;
export interface AttributionSummary {
  storeId: string;
  managerId: string;
  date: string;
  directCount: number;
  introducedCount: number;
  totalCount: number;
  newClientCount: number;
  migrationCount: number;
}

const ClientCreationSchema = ClientSchema.extend({
  storeId: z.uuid().optional(),
  date: z.iso.date().optional(),
  note: z.string().trim().min(1).max(200).optional(),
  reconciliationBalance: z.literal(0).default(0),
});

export function createStoreModule(db: AppDatabase) {
  function getStore(id: string): Store | undefined {
    const value = db.get('store', id);
    return value === undefined ? undefined : StoreSchema.parse(value);
  }
  function getManager(id: string): StoreManager | undefined {
    const value = db.get('manager', id);
    return value === undefined ? undefined : StoreManagerSchema.parse(value);
  }
  function getClient(id: string): Client | undefined {
    const value = db.get('client', id);
    return value === undefined ? undefined : ClientSchema.parse(value);
  }
  function requireStore(id: string) {
    if (!getStore(id)) throw new DomainError('Store does not exist', 404);
  }
  function listAttributionAudits(input: AttributionFilter = {}): ClientAttributionAudit[] {
    const filter = AttributionFilterSchema.parse(input);
    return db.list('client_attribution_audit').map((item) => ClientAttributionAuditSchema.parse(item))
      .filter((audit) => (filter.storeId === undefined || audit.storeId === filter.storeId)
        && (filter.managerId === undefined || audit.managerId === filter.managerId)
        && (filter.date === undefined || audit.date === filter.date))
      .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  }
  return {
    getStore, getManager, getClient,
    addStore(input: unknown): Store {
      const store = StoreSchema.parse(input);
      db.insert('store', store.id, store);
      return store;
    },
    addManager(input: unknown): StoreManager {
      const manager = StoreManagerSchema.parse(input);
      requireStore(manager.storeId);
      db.insert('manager', manager.id, manager);
      return manager;
    },
    addClient(input: unknown): Client {
      const creation = ClientCreationSchema.parse(input);
      return db.transaction(() => {
        if (creation.storeId) requireStore(creation.storeId);
        const introducer = creation.introducedByClientId ? getClient(creation.introducedByClientId) : undefined;
        if (creation.introducedByClientId && !introducer) throw new DomainError('Introduced Client does not exist', 404);
        if (introducer && !introducer.managerId) throw new DomainError('Introduced Client has no StoreManager attribution');
        const managerId = introducer?.managerId ?? creation.managerId;
        const candidates = managerId ? [] : db.list('manager').map((value) => StoreManagerSchema.parse(value))
          .filter((candidate) => candidate.storeId === creation.storeId);
        const manager = managerId ? getManager(managerId) : candidates.length === 1 ? candidates[0] : undefined;
        if (!manager) throw new DomainError('StoreManager attribution is required');
        if ((creation.storeId && creation.storeId !== manager.storeId)
          || (creation.managerId && creation.managerId !== manager.id)
          || (introducer && introducer.storeId !== manager.storeId)) {
          throw new DomainError('Client attribution conflicts with source StoreManager');
        }
        requireStore(manager.storeId);
        if (creation.date && creation.createdDate && creation.date !== creation.createdDate) {
          throw new DomainError('Client creation date conflicts with createdDate');
        }
        const date = creation.date ?? creation.createdDate ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
        const client = ClientSchema.parse({
          id: creation.id, name: creation.name, storeId: manager.storeId,
          managerId: manager.id, reconciliationBalance: 0, createdDate: date,
          ...(introducer ? { introducedByClientId: introducer.id } : {}),
        });
        const audit = ClientAttributionAuditSchema.parse({
          id: randomUUID(), clientId: client.id, storeId: client.storeId, managerId: manager.id,
          eventType: 'Created',
          ...(introducer ? { introducedByClientId: introducer.id } : {}),
          date, note: creation.note ?? (introducer ? '老客户引荐建档' : '店长直接建档'), createdAt: new Date(),
        });
        db.insert('client', client.id, client);
        db.insert('client_attribution_audit', audit.id, audit);
        return client;
      });
    },
    listAttributionAudits,
    migrateLegacyClients(inputDate: string): { migrated: number; unresolvedClientIds: string[] } {
      const date = z.iso.date().parse(inputDate);
      return db.transaction(() => {
        const auditedIds = new Set(listAttributionAudits().map((audit) => audit.clientId));
        const managers = db.list('manager').map((item) => StoreManagerSchema.parse(item));
        const unresolvedClientIds: string[] = [];
        let migrated = 0;
        for (const value of db.list('client')) {
          const client = ClientSchema.parse(value);
          if (client.managerId && auditedIds.has(client.id)) continue;
          const candidates = managers.filter((manager) => manager.storeId === client.storeId
            && (client.managerId === undefined || manager.id === client.managerId));
          const manager = candidates.length === 1 ? candidates[0] : undefined;
          if (!manager || !getStore(client.storeId)) {
            unresolvedClientIds.push(client.id);
            continue;
          }
          const updated = ClientSchema.parse({ ...client, managerId: manager.id });
          const audit = ClientAttributionAuditSchema.parse({
            id: randomUUID(), clientId: client.id, storeId: client.storeId, managerId: manager.id,
            eventType: 'Migrated',
            ...(client.introducedByClientId ? { introducedByClientId: client.introducedByClientId } : {}),
            date, note: '旧版档案迁移登记；本日期为迁移登记日，不代表原建档日', createdAt: new Date(),
          });
          db.set('client', client.id, updated);
          db.insert('client_attribution_audit', audit.id, audit);
          migrated += 1;
        }
        return { migrated, unresolvedClientIds };
      });
    },
    attributionSummary(filter: AttributionFilter = {}): AttributionSummary[] {
      const groups = new Map<string, AttributionSummary>();
      for (const audit of listAttributionAudits(filter)) {
        const key = `${audit.managerId}:${audit.date}`;
        const row = groups.get(key) ?? { storeId: audit.storeId, managerId: audit.managerId, date: audit.date, directCount: 0, introducedCount: 0, totalCount: 0, newClientCount: 0, migrationCount: 0 };
        if (audit.introducedByClientId) row.introducedCount += 1;
        else row.directCount += 1;
        row.totalCount += 1;
        if (audit.eventType === 'Created') row.newClientCount += 1;
        else row.migrationCount += 1;
        groups.set(key, row);
      }
      return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date) || a.managerId.localeCompare(b.managerId));
    },
    listStores(): Store[] {
      return db.list('store').map((item) => StoreSchema.parse(item));
    },
    listManagers(storeId?: string): StoreManager[] {
      if (storeId !== undefined) requireStore(storeId);
      return db.list('manager').map((item) => StoreManagerSchema.parse(item))
        .filter((manager) => storeId === undefined || manager.storeId === storeId);
    },
    listClients(storeId: string): Client[] {
      requireStore(storeId);
      return db.list('client').map((item) => ClientSchema.parse(item))
        .filter((client) => client.storeId === storeId);
    },
  };
}

export type StoreModule = ReturnType<typeof createStoreModule>;

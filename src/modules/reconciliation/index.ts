import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../../shared/database.ts';
import type { StoreModule } from '../store/index.ts';
import { DomainError } from '../../shared/errors.ts';
import { ClientSchema } from '../../shared/schemas/store.ts';
import { toMinorUnits } from '../../shared/schemas/money.ts';
import {
  ReconciliationAdjustmentSchema,
  ReconciliationFiltersSchema,
  ReconciliationLedgerEntrySchema,
} from '../../shared/schemas/reconciliation.ts';
import type { ReconciliationLedgerEntry } from '../../shared/schemas/reconciliation.ts';

export type {
  ReconciliationAdjustment, ReconciliationLedgerEntry, ReconciliationFilters,
} from '../../shared/schemas/reconciliation.ts';

/** Records completed offline movements; it never consumes balances for orders. */
export function createReconciliationModule(db: AppDatabase, stores: StoreModule) {
  function listLedger(filters: unknown = {}): ReconciliationLedgerEntry[] {
    const parsed = ReconciliationFiltersSchema.parse(filters);
    return db.list('reconciliation_ledger').map((value) => ReconciliationLedgerEntrySchema.parse(value))
      .filter((entry) => (parsed.date === undefined || entry.date === parsed.date)
        && (parsed.managerId === undefined || entry.managerId === parsed.managerId)
        && (parsed.storeId === undefined || entry.storeId === parsed.storeId)
        && (parsed.clientId === undefined || entry.clientId === parsed.clientId))
      // Older imports without a sequence precede sequenced entries in stable timestamp/ID order.
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)
        || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  }

  function listForClient(clientId: string): ReconciliationLedgerEntry[] {
    if (!stores.getClient(clientId)) throw new DomainError('Client does not exist', 404);
    return listLedger({ clientId });
  }

  return {
    adjust(input: unknown): ReconciliationLedgerEntry {
      const adjustment = ReconciliationAdjustmentSchema.parse(input);
      return db.transaction(() => {
        const client = stores.getClient(adjustment.clientId);
        if (!client) throw new DomainError('Client does not exist', 404);
        const manager = stores.getManager(adjustment.managerId);
        if (!manager) throw new DomainError('StoreManager does not exist', 404);
        if (client.managerId !== manager.id || client.storeId !== manager.storeId) {
          throw new DomainError('StoreManager does not own this Client');
        }
        const amount = toMinorUnits(adjustment.amount);
        const balance = toMinorUnits(client.reconciliationBalance)
          + (adjustment.direction === 'ADJUST_IN' ? amount : -amount);
        if (balance < 0n) throw new DomainError('核减金额超过当前对账结余，请核对实际收支');
        if (balance > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('ReconciliationBalance exceeds safe cents');
        const balanceAfter = Number(balance) / 100;
        if (toMinorUnits(balanceAfter) !== balance) throw new RangeError('ReconciliationBalance would lose cent precision');
        const sequence = db.list('reconciliation_ledger').map((value) => ReconciliationLedgerEntrySchema.parse(value))
          .reduce((maximum, entry) => Math.max(maximum, entry.sequence ?? 0), 0) + 1;
        const entry = ReconciliationLedgerEntrySchema.parse({
          ...adjustment, id: randomUUID(), storeId: client.storeId, balanceAfter, createdAt: new Date(), sequence,
        });
        db.set('client', client.id, ClientSchema.parse({ ...client, reconciliationBalance: balanceAfter }));
        db.insert('reconciliation_ledger', entry.id, entry);
        return entry;
      });
    },
    listForClient,
    listForStore(storeId: string): ReconciliationLedgerEntry[] {
      if (!stores.getStore(storeId)) throw new DomainError('Store does not exist', 404);
      return listLedger({ storeId });
    },
    listLedger,
  };
}

export type ReconciliationModule = ReturnType<typeof createReconciliationModule>;

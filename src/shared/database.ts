import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DomainError } from './errors.ts';

export interface AppDatabase {
  get(kind: string, id: string): unknown | undefined;
  list(kind: string): unknown[];
  insert(kind: string, id: string, value: unknown): void;
  set(kind: string, id: string, value: unknown): void;
  transaction<T>(work: () => T): T;
  close(): void;
}

function decode(body: unknown): unknown {
  if (typeof body !== 'string') throw new Error('Invalid stored record');
  return JSON.parse(body, (key: string, value: unknown): unknown =>
    key === 'createdAt' && typeof value === 'string' ? new Date(value) : value);
}

export function createDatabase(filename = ':memory:'): AppDatabase {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const sqlite = new DatabaseSync(filename);
  sqlite.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS records (
      kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY (kind, id)
    ) STRICT;`);
  const get = sqlite.prepare('SELECT body FROM records WHERE kind = ? AND id = ?');
  const list = sqlite.prepare('SELECT body FROM records WHERE kind = ? ORDER BY id');
  const insert = sqlite.prepare('INSERT OR IGNORE INTO records (kind, id, body) VALUES (?, ?, ?)');
  const set = sqlite.prepare(`INSERT INTO records (kind, id, body) VALUES (?, ?, ?)
    ON CONFLICT(kind, id) DO UPDATE SET body = excluded.body`);
  // Static table names only; audit records have no update or delete path.
  const journals = new Map(['reconciliation_ledger', 'client_attribution_audit', 'voucher_audit'].map(kind => {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS ${kind} (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
      CREATE TRIGGER IF NOT EXISTS ${kind}_no_update BEFORE UPDATE ON ${kind}
        BEGIN SELECT RAISE(ABORT, 'Audit records are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS ${kind}_no_delete BEFORE DELETE ON ${kind}
        BEGIN SELECT RAISE(ABORT, 'Audit records are append-only'); END;`);
    return [kind, {
      get: sqlite.prepare(`SELECT body FROM ${kind} WHERE id = ?`),
      list: sqlite.prepare(`SELECT body FROM ${kind} ORDER BY id`),
      insert: sqlite.prepare(`INSERT OR IGNORE INTO ${kind} (id, body) VALUES (?, ?)`),
    }] as const;
  }));
  let depth = 0;

  return {
    get(kind, id) {
      const journal = journals.get(kind);
      const row = journal ? journal.get.get(id) : get.get(kind, id);
      return row ? decode(row.body) : undefined;
    },
    list(kind) { return (journals.get(kind)?.list.all() ?? list.all(kind)).map((row) => decode(row.body)); },
    insert(kind, id, value) {
      const journal = journals.get(kind);
      const result = journal ? journal.insert.run(id, JSON.stringify(value)) : insert.run(kind, id, JSON.stringify(value));
      if (result.changes === 0) {
        throw new DomainError('记录已存在，请刷新后重试');
      }
    },
    set(kind, id, value) {
      if (journals.has(kind)) throw new DomainError('审计流水仅允许追加，不能修改');
      set.run(kind, id, JSON.stringify(value));
    },
    transaction(work) {
      const savepoint = `module_${depth}`;
      const nested = depth > 0;
      sqlite.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
      depth += 1;
      try {
        const result = work();
        sqlite.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
        return result;
      } catch (error) {
        sqlite.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
        throw error;
      } finally { depth -= 1; }
    },
    close() { sqlite.close(); },
  };
}

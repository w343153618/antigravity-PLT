import { describe, expect, it } from 'vitest';
import { createDatabase } from '../src/shared/database.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('persistent records', () => {
  it('stores isolated records and returns independent snapshots with dates', () => {
    const db = createDatabase(':memory:');
    try {
      const record = { id: 'a', name: '网点', createdAt: new Date('2026-10-13T00:00:00Z') };
      db.insert('store', 'a', record);
      expect(db.get('store', 'a')).toEqual(record);
      expect(db.get('client', 'a')).toBeUndefined();
      expect(db.list('store')).toEqual([record]);
      expect(() => db.insert('store', 'a', record)).toThrow();
      expect(db.get('store', 'a')).not.toBe(record);
    } finally { db.close(); }
  });

  it('atomically rolls back a failed batch and supports nested module transactions', () => {
    const db = createDatabase();
    try {
      expect(() => db.transaction(() => {
        db.insert('batch', '1', { value: 1 });
        db.transaction(() => db.insert('batch', '2', { value: 2 }));
        throw new Error('Abort batch');
      })).toThrow('Abort batch');
      expect(db.list('batch')).toEqual([]);
      db.transaction(() => {
        db.insert('batch', '1', { value: 1 });
        expect(() => db.transaction(() => {
          db.insert('batch', '2', { value: 2 });
          throw new Error('Abort nested');
        })).toThrow('Abort nested');
        db.set('batch', '1', { value: 3 });
      });
      expect(db.list('batch')).toEqual([{ value: 3 }]);
    } finally { db.close(); }
  });

  it('preserves records across reopening the SQLite file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'core-database-'));
    const filename = join(directory, 'nested/app.db');
    try {
      const first = createDatabase(filename);
      first.set('sample', '1', { value: 'saved' });
      first.close();
      const second = createDatabase(filename);
      try { expect(second.get('sample', '1')).toEqual({ value: 'saved' }); }
      finally { second.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

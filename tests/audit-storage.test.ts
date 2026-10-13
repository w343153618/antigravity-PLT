import { expect, it } from 'vitest';
import { createDatabase } from '../src/shared/database.ts';

it.each(['reconciliation_ledger', 'client_attribution_audit', 'voucher_audit'])('keeps %s append-only even through the shared storage interface', kind => {
  const db = createDatabase();
  try {
    db.insert(kind, 'entry', { note: '原始记录' });
    expect(() => db.set(kind, 'entry', { note: '改写' })).toThrow('追加');
    expect(() => db.set(kind, 'new', { note: '绕过追加接口' })).toThrow('追加');
    expect(() => db.insert(kind, 'entry', { note: '覆盖' })).toThrow();
    expect(db.get(kind, 'entry')).toEqual({ note: '原始记录' });
    expect(db.list(kind)).toEqual([{ note: '原始记录' }]);
    expect(db.get(kind, 'missing')).toBeUndefined();
  } finally { db.close(); }
});

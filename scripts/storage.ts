import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function checkDatabase(filename: string) {
  if (!lstatSync(filename).isFile()) throw new Error('Database must be a regular file.');
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const result = db.prepare('PRAGMA quick_check').all();
    if (result.length !== 1 || result[0]?.quick_check !== 'ok') throw new Error('SQLite integrity check failed.');
  } finally { db.close(); }
}

/** VACUUM INTO takes a consistent SQLite snapshot, including committed WAL rows. */
export function snapshotDatabase(source: string, destination: string): string {
  source = resolve(source);
  destination = resolve(destination);
  if (source === destination || existsSync(destination)) throw new Error('Snapshot destination already exists.');
  checkDatabase(source);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const pending = `${destination}.partial-${randomUUID()}`;
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('VACUUM INTO ?').run(pending);
    checkDatabase(pending);
    chmodSync(pending, 0o600);
    // An exclusive link prevents accidental replacement of a previous backup.
    linkSync(pending, destination);
    return destination;
  } finally {
    db.close();
    rmSync(pending, { force: true });
  }
}

/** Called only by restore.sh after the sole application writer has stopped. */
export function restoreDatabase(source: string, destination: string, backupDirectory: string) {
  source = resolve(source);
  destination = resolve(destination);
  if (source === destination) throw new Error('Cannot restore a database onto itself.');
  const staged = `${destination}.restore-${randomUUID()}`;
  let previous: string | undefined;
  try {
    snapshotDatabase(source, staged);
    if (existsSync(destination)) {
      previous = resolve(backupDirectory, `before-restore-${Date.now()}-${randomUUID()}.db`);
      snapshotDatabase(destination, previous);
      const db = new DatabaseSync(destination);
      try {
        db.exec('PRAGMA busy_timeout = 5000');
        const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        if (result?.busy !== 0) throw new Error('Database still has an active writer; restore refused.');
      } finally { db.close(); }
    }
    rmSync(`${destination}-wal`, { force: true });
    rmSync(`${destination}-shm`, { force: true });
    renameSync(staged, destination);
    return { database: destination, previous };
  } finally { rmSync(staged, { force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, source, destination, backups] = process.argv.slice(2);
    if (!source || !destination) throw new Error('Usage: storage.ts backup <source> <destination> | restore <source> <destination> <backup-directory>');
    if (command === 'backup') console.log(JSON.stringify({ snapshot: snapshotDatabase(source, destination) }));
    else if (command === 'restore' && backups) console.log(JSON.stringify(restoreDatabase(source, destination, backups)));
    else throw new Error('Unknown storage command.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Storage operation failed.');
    process.exitCode = 1;
  }
}

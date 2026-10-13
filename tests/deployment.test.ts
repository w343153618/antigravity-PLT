import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { restoreDatabase, snapshotDatabase } from '../scripts/storage.ts';

const directories: string[] = [];
const root = fileURLToPath(new URL('..', import.meta.url));
function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'erp-migration-'));
  directories.push(directory);
  return directory;
}
function rows(filename: string) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try { return db.prepare('SELECT value FROM sample ORDER BY value').all().map(row => row.value); }
  finally { db.close(); }
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('portable SQLite snapshots', () => {
  it('includes committed WAL rows but excludes an in-flight transaction and later writes', () => {
    const directory = temporaryDirectory();
    const filename = join(directory, 'data/app.db');
    mkdirSync(dirname(filename));
    const db = new DatabaseSync(filename);
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE sample(value TEXT);');
      db.prepare('INSERT INTO sample VALUES (?)').run('committed account and ledger');
      db.exec('BEGIN; INSERT INTO sample VALUES (\'uncommitted\')');
      const snapshot = join(directory, 'backups/first.db');
      snapshotDatabase(filename, snapshot);
      expect(rows(snapshot)).toEqual(['committed account and ledger']);
      db.exec('COMMIT');
      expect(rows(snapshot)).toEqual(['committed account and ledger']);
      expect(rows(filename)).toHaveLength(2);
      expect(statSync(snapshot).mode & 0o777).toBe(0o600);
      expect(() => snapshotDatabase(filename, snapshot)).toThrow('already exists');
      expect(rows(snapshot)).toEqual(['committed account and ledger']);
    } finally { db.close(); }
  });

  it('restores a checked snapshot and preserves the replaced data in its own checked backup', () => {
    const directory = temporaryDirectory();
    const filename = join(directory, 'app.db');
    const backup = join(directory, 'backups/known-good.db');
    const db = new DatabaseSync(filename);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('original');");
    snapshotDatabase(filename, backup);
    db.exec("INSERT INTO sample VALUES ('after backup')");
    db.close();
    const restored = restoreDatabase(backup, filename, join(directory, 'backups'));
    expect(rows(filename)).toEqual(['original']);
    expect(restored.previous).toBeDefined();
    expect(rows(restored.previous!)).toEqual(['after backup', 'original']);
    expect(rows(backup)).toEqual(['original']);
    expect(existsSync(`${filename}-wal`)).toBe(false);
    const reopened = new DatabaseSync(filename);
    reopened.exec("INSERT INTO sample VALUES ('new record')");
    reopened.close();
    expect(rows(filename)).toEqual(['new record', 'original']);
  });

  it('rejects corrupted backups without replacing existing data, and supports an empty new host', () => {
    const directory = temporaryDirectory();
    const filename = join(directory, 'app.db');
    const bad = join(directory, 'corrupt.db');
    const good = join(directory, 'backups/good.db');
    const db = new DatabaseSync(filename);
    db.exec("CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('preserved');");
    db.close();
    writeFileSync(bad, 'invalid SQLite file');
    expect(() => restoreDatabase(bad, filename, join(directory, 'backups'))).toThrow();
    expect(rows(filename)).toEqual(['preserved']);
    snapshotDatabase(filename, good);
    const target = join(directory, 'new-host/data/app.db');
    expect(restoreDatabase(good, target, join(directory, 'backups')).previous).toBeUndefined();
    expect(rows(target)).toEqual(['preserved']);
  });
});

describe('restore orchestration', () => {
  function fixture() {
    const directory = temporaryDirectory();
    for (const child of ['scripts', 'backups', 'bin']) mkdirSync(join(directory, child));
    for (const script of ['common.sh', 'restore.sh']) copyFileSync(join(root, 'scripts', script), join(directory, 'scripts', script));
    writeFileSync(join(directory, '.env'), 'DEMO_SEED=false\n');
    writeFileSync(join(directory, 'backups/snapshot.db'), 'fake snapshot; storage behavior tested separately');
    const log = join(directory, 'commands.log');
    const fakeDocker = join(directory, 'bin/docker');
    writeFileSync(fakeDocker, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$DOCKER_LOG"\ncase " $* " in\n  *' ps '*) printf '%s' "$RUNNING_CONTAINER" ;;\n  *' run '*) exit "$RESTORE_EXIT" ;;\nesac\n`, { mode: 0o755 });
    return {
      directory, log,
      run(extra: Record<string, string> = {}, name = 'snapshot.db') {
        return spawnSync('sh', [join(directory, 'scripts/restore.sh'), name], {
          encoding: 'utf8', env: { ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH}`, DOCKER_LOG: log, RUNNING_CONTAINER: '', RESTORE_EXIT: '0', ...extra },
        });
      },
    };
  }

  it('stops the writer before restore and starts it only after a successful restore', () => {
    const setup = fixture();
    expect(setup.run().status).toBe(0);
    const commands = readFileSync(setup.log, 'utf8').trim().split('\n');
    expect(commands).toHaveLength(4);
    expect(commands[0]).toContain('stop --timeout 30 erp-app');
    expect(commands[1]).toContain('ps --status running');
    expect(commands[2]).toContain('run --rm --no-deps erp-app node scripts/storage.ts restore');
    expect(commands[3]).toContain('up --detach --wait');
  });

  it('leaves the service stopped after a failed restore and refuses an active writer', () => {
    const failed = fixture();
    const result = failed.run({ RESTORE_EXIT: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('remains stopped');
    expect(readFileSync(failed.log, 'utf8')).not.toContain(' up ');
    const running = fixture();
    expect(running.run({ RUNNING_CONTAINER: 'active' }).status).toBe(1);
    expect(readFileSync(running.log, 'utf8')).not.toContain(' run ');
  });

  it('rejects missing and traversing backup paths before stopping the service', () => {
    for (const name of ['../snapshot.db', 'missing.db', '']) {
      const setup = fixture();
      expect(setup.run({}, name).status).toBe(1);
      expect(existsSync(setup.log)).toBe(false);
    }
  });
});

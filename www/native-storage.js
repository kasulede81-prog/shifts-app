import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';

export const DATABASE_NAME = 'dkasu_shift';
export const DATABASE_VERSION = 1;
export const SCHEMA_VERSION = 1;

function assertKey(key) {
  if (typeof key !== 'string' || !key) throw new TypeError('Storage key must be a non-empty string.');
}

/**
 * Initialize the schema on an already-created SQLite connection wrapper.
 *
 * API routing on Android matters:
 * - execute() maps to SQLiteDatabase.execSQL(), which rejects PRAGMA/SELECT
 *   statements as queries.
 * - query() maps to rawQuery and is required for PRAGMA/SELECT statements.
 * - run() is used for parameterized INSERT/DELETE writes.
 */
export async function initializeSqliteDatabase(db) {
  let step = 'check database state';
  try {
    const openState = await db.isDBOpen();
    if (!openState.result) {
      step = 'open database';
      await db.open();
    }
    step = 'create app_kv table';
    await db.execute(
      'CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);'
    );
    step = 'create app_meta table';
    await db.execute(
      'CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);'
    );
    step = 'set journal_mode';
    await db.query('PRAGMA journal_mode = WAL;');
    step = 'set synchronous';
    await db.query('PRAGMA synchronous = FULL;');
    step = 'set busy_timeout';
    await db.query('PRAGMA busy_timeout = 5000;');
    step = 'initialize schema version';
    await db.run(
      "INSERT OR IGNORE INTO app_meta (key, value) VALUES ('schema_version', ?)",
      [String(SCHEMA_VERSION)]
    );
    step = 'read schema version';
    const schemaRows = await db.query(
      "SELECT value FROM app_meta WHERE key = 'schema_version'"
    );
    const storedSchemaVersion = Number.parseInt(schemaRows.values?.[0]?.value, 10);
    if (!Number.isInteger(storedSchemaVersion)) {
      throw new Error('SQLite schema version is missing or invalid.');
    }
    if (storedSchemaVersion > SCHEMA_VERSION) {
      throw new Error(`SQLite schema version ${storedSchemaVersion} is newer than this app supports.`);
    }
    if (storedSchemaVersion < SCHEMA_VERSION) {
      throw new Error(`SQLite schema version ${storedSchemaVersion} requires a migration this build does not contain.`);
    }
  } catch (error) {
    throw new Error(`SQLite setup failed at "${step}": ${error?.message || error}`, { cause: error });
  }
}

export class SqliteKeyValueStorage {
  constructor(db) {
    this.db = db;
    this.queue = Promise.resolve();
    this.label = 'SQLite (app-private storage)';
  }

  static async open() {
    const sqlite = new SQLiteConnection(CapacitorSQLite);
    let db = null;
    try {
      try {
        await sqlite.checkConnectionsConsistency();
      } catch {
        // A cold start has no prior connections to reconcile.
      }
      let hasConnection = false;
      try {
        hasConnection = Boolean((await sqlite.isConnection(DATABASE_NAME, false)).result);
      } catch {
        hasConnection = false;
      }
      db = hasConnection
        ? await sqlite.retrieveConnection(DATABASE_NAME, false)
        : await sqlite.createConnection(DATABASE_NAME, false, 'no-encryption', DATABASE_VERSION, false);
      await initializeSqliteDatabase(db);
      return new SqliteKeyValueStorage(db);
    } catch (error) {
      if (db) {
        try {
          await db.close();
        } catch {
          // Preserve the original failure.
        }
      }
      throw new Error(`Could not open the on-device SQLite database: ${error?.message || error}`, {
        cause: error
      });
    }
  }

  _enqueue(task) {
    const run = () => task();
    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async getItem(key) {
    assertKey(key);
    await this.queue;
    const result = await this.db.query('SELECT value FROM app_kv WHERE key = ?', [key]);
    const row = result.values?.[0];
    return row ? row.value : null;
  }

  async setItem(key, value) {
    assertKey(key);
    if (typeof value !== 'string') throw new TypeError('Storage value must be a string.');
    return this._enqueue(async () => {
      await this.db.run(
        'INSERT OR REPLACE INTO app_kv (key, value) VALUES (?, ?)',
        [key, value]
      );
      const result = await this.db.query('SELECT value FROM app_kv WHERE key = ?', [key]);
      const stored = result.values?.[0]?.value;
      if (stored !== value) {
        throw new Error('SQLite write verification failed: the stored value does not match.');
      }
      return true;
    });
  }

  async removeItem(key) {
    assertKey(key);
    return this._enqueue(async () => {
      await this.db.run('DELETE FROM app_kv WHERE key = ?', [key]);
      const result = await this.db.query('SELECT value FROM app_kv WHERE key = ?', [key]);
      if (result.values?.length) {
        throw new Error('SQLite delete verification failed: the value is still present.');
      }
      return true;
    });
  }
}

export class BrowserKeyValueStorage {
  constructor(storage) {
    if (!storage) throw new Error('Browser storage is unavailable.');
    this.storage = storage;
    this.label = 'Browser localStorage (development only)';
  }

  async getItem(key) {
    assertKey(key);
    return this.storage.getItem(key);
  }

  async setItem(key, value) {
    assertKey(key);
    if (typeof value !== 'string') throw new TypeError('Storage value must be a string.');
    this.storage.setItem(key, value);
    if (this.storage.getItem(key) !== value) {
      throw new Error('Browser storage write verification failed.');
    }
    return true;
  }

  async removeItem(key) {
    assertKey(key);
    this.storage.removeItem(key);
    if (this.storage.getItem(key) !== null) {
      throw new Error('Browser storage delete verification failed.');
    }
    return true;
  }
}

export async function createStorage() {
  if (Capacitor.isNativePlatform()) {
    return SqliteKeyValueStorage.open();
  }
  return new BrowserKeyValueStorage(globalThis.localStorage);
}

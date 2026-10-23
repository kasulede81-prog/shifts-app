import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BrowserKeyValueStorage,
  SqliteKeyValueStorage,
  initializeSqliteDatabase
} from '../www/native-storage.js';

class FakeSqliteDb {
  constructor() {
    this.rows = new Map();
    this.runDelay = 0;
    this.failNextRun = false;
    this.mismatchNextRead = false;
    this.writeOrder = [];
  }

  async run(statement, values) {
    if (this.runDelay) await new Promise((resolve) => setTimeout(resolve, this.runDelay));
    if (this.failNextRun) {
      this.failNextRun = false;
      throw new Error('Simulated SQLite run failure');
    }
    if (statement.startsWith('INSERT OR REPLACE INTO app_kv')) {
      this.rows.set(values[0], values[1]);
      this.writeOrder.push([values[0], values[1]]);
      return { changes: { changes: 1 } };
    }
    if (statement.startsWith('DELETE FROM app_kv')) {
      this.rows.delete(values[0]);
      return { changes: { changes: 1 } };
    }
    throw new Error(`Unexpected statement: ${statement}`);
  }

  async query(statement, values) {
    if (this.mismatchNextRead) {
      this.mismatchNextRead = false;
      return { values: [{ value: 'mismatched value' }] };
    }
    if (statement.startsWith('SELECT value FROM app_kv')) {
      return this.rows.has(values[0])
        ? { values: [{ value: this.rows.get(values[0]) }] }
        : { values: [] };
    }
    throw new Error(`Unexpected query: ${statement}`);
  }
}

class FakeSchemaDb {
  constructor() {
    this.meta = new Map();
    this.executeCalls = [];
    this.queryCalls = [];
    this.openCalls = 0;
  }

  async isDBOpen() {
    return { result: true };
  }

  async open() {
    this.openCalls += 1;
  }

  async execute(statement, transaction = true) {
    this.executeCalls.push({ statement, transaction });
    // Android SQLiteDatabase.execSQL rejects row/PRAGMA statements. Emulate the
    // plugin's native execute path using the exact device error message.
    if (/^\s*(?:SELECT|PRAGMA)\b/i.test(statement)) {
      throw new Error('Queries can be performed using SQLiteDatabase query or rawQuery methods only');
    }
    return { changes: { changes: 0 } };
  }

  async query(statement) {
    this.queryCalls.push(statement);
    if (/PRAGMA\s+journal_mode/i.test(statement)) return { values: [{ journal_mode: 'wal' }] };
    if (/PRAGMA\s+synchronous/i.test(statement)) return { values: [] };
    if (/PRAGMA\s+busy_timeout/i.test(statement)) return { values: [{ timeout: 5000 }] };
    if (/SELECT value FROM app_meta/i.test(statement)) {
      return this.meta.has('schema_version')
        ? { values: [{ value: this.meta.get('schema_version') }] }
        : { values: [] };
    }
    return { values: [] };
  }

  async run(statement, values, _transaction = true) {
    if (/INSERT OR IGNORE INTO app_meta/i.test(statement)) {
      this.meta.set('schema_version', values[0]);
      return { changes: { changes: 1 } };
    }
    throw new Error(`Unexpected run: ${statement}`);
  }
}

class FakeWebStorage {
  constructor() {
    this.map = new Map();
    this.failNextSet = false;
    this.corruptReads = false;
  }

  getItem(key) {
    if (this.corruptReads) return 'different value';
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error('Simulated quota failure');
    }
    this.map.set(key, value);
  }

  removeItem(key) {
    this.map.delete(key);
  }
}

test('SQLite schema initialization uses query for PRAGMAs and execSQL only for DDL', async () => {
  const db = new FakeSchemaDb();
  await initializeSqliteDatabase(db);
  assert.equal(db.meta.get('schema_version'), '1');
  const executedPragmas = db.executeCalls.filter(({ statement }) => /PRAGMA/i.test(statement));
  assert.deepEqual(executedPragmas, []);
  assert.ok(db.queryCalls.some((statement) => /PRAGMA\s+journal_mode/i.test(statement)));
  assert.ok(db.queryCalls.some((statement) => /PRAGMA\s+synchronous/i.test(statement)));
  assert.ok(db.queryCalls.some((statement) => /PRAGMA\s+busy_timeout/i.test(statement)));
  assert.ok(db.executeCalls.every(({ statement }) => /^CREATE TABLE/i.test(statement)));
});

test('SQLite adapter stores, verifies, reads and removes text values', async () => {
  const db = new FakeSqliteDb();
  const storage = new SqliteKeyValueStorage(db);
  await storage.setItem('dkasu_state', '{"version":2}');
  assert.equal(await storage.getItem('dkasu_state'), '{"version":2}');
  assert.equal(db.rows.get('dkasu_state'), '{"version":2}');
  await storage.removeItem('dkasu_state');
  assert.equal(await storage.getItem('dkasu_state'), null);
});

test('SQLite adapter serializes writes and a read waits for a pending write', async () => {
  const db = new FakeSqliteDb();
  db.runDelay = 20;
  const storage = new SqliteKeyValueStorage(db);
  const firstWrite = storage.setItem('key', 'first');
  const secondWrite = storage.setItem('key', 'second');
  const read = await storage.getItem('key');
  await Promise.all([firstWrite, secondWrite]);
  assert.equal(read, 'second');
  assert.deepEqual(db.writeOrder.map(([, value]) => value), ['first', 'second']);
  assert.equal(await storage.getItem('key'), 'second');
});

test('SQLite write and delete verification failures are surfaced', async () => {
  const db = new FakeSqliteDb();
  const storage = new SqliteKeyValueStorage(db);
  db.mismatchNextRead = true;
  await assert.rejects(() => storage.setItem('key', 'value'), /verification failed/);

  db.rows.set('persisted', 'value');
  const originalQuery = db.query.bind(db);
  db.query = async () => ({ values: [{ value: 'value' }] });
  await assert.rejects(() => storage.removeItem('persisted'), /delete verification failed/);
  db.query = originalQuery;
});

test('SQLite run errors reject the caller and do not poison subsequent writes', async () => {
  const db = new FakeSqliteDb();
  const storage = new SqliteKeyValueStorage(db);
  db.failNextRun = true;
  await assert.rejects(() => storage.setItem('key', 'first'), /Simulated SQLite run failure/);
  await storage.setItem('key', 'second');
  assert.equal(await storage.getItem('key'), 'second');
});

test('browser development adapter verifies writes and propagates quota failures', async () => {
  const web = new FakeWebStorage();
  const storage = new BrowserKeyValueStorage(web);
  await storage.setItem('key', 'value');
  assert.equal(await storage.getItem('key'), 'value');
  await storage.removeItem('key');
  assert.equal(await storage.getItem('key'), null);

  web.failNextSet = true;
  await assert.rejects(() => storage.setItem('key', 'value'), /quota failure/);
  web.corruptReads = true;
  await assert.rejects(() => storage.setItem('key', 'value'), /verification failed/);
});

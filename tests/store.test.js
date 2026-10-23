import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultAndrew, profileFromForm } from '../www/domain.js';
import {
  LEGACY_ACTIVE_KEY,
  LEGACY_STORE_KEY,
  ProfileStore,
  STORE_FORMAT,
  STORE_KEY,
  STORE_VERSION,
  StoreError
} from '../www/store.js';

const FIXED_NOW = new Date('2026-10-22T08:00:00.000Z');

class MemoryStorage {
  constructor(initial = {}) {
    this.map = new Map(Object.entries(initial));
    this.failKeys = new Set();
    this.writeCount = 0;
  }

  async getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  async setItem(key, value) {
    if (this.failKeys.has(key)) {
      this.failKeys.delete(key);
      throw new Error('Simulated storage failure');
    }
    this.writeCount += 1;
    this.map.set(key, value);
    return true;
  }

  async removeItem(key) {
    this.map.delete(key);
    return true;
  }

  raw(key) {
    return this.map.get(key) ?? null;
  }
}

function fields(overrides = {}) {
  return profileFromForm({
    name: 'Second Worker',
    email: 'second@example.com',
    profileId: 'ID222',
    swipeId: 'SW222',
    job: 'Picker',
    company: 'Second Co',
    location: 'Site B',
    address: '2 Second Street',
    contractStart: '2026-10-20',
    contractEnd: '2026-12-20',
    displayZone: 'Africa/Kampala',
    scheduleZone: 'Asia/Dubai',
    schedulesText: '2026-10-23,06:00,16:00',
    ...overrides
  });
}

function makeStore(storage = new MemoryStorage(), ids = []) {
  let counter = 0;
  return new ProfileStore(storage, {
    now: () => new Date(FIXED_NOW),
    idFactory: () => ids[counter++] || `p_test_${counter}`
  });
}

test('first launch seeds Andrew and persists the seeded state', async () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  await store.load();
  const profiles = store.listProfiles();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].id, 'andrew-wamani-id432384');
  assert.equal(Object.keys(profiles[0].schedules).length, 6);
  assert.equal(store.getActiveProfileId(), 'andrew-wamani-id432384');
  assert.ok(storage.raw(STORE_KEY));
  assert.equal(JSON.parse(storage.raw(STORE_KEY)).format, STORE_FORMAT);
  assert.equal(JSON.parse(storage.raw(STORE_KEY)).version, STORE_VERSION);
});

test('profiles and active selection survive a store reload', async () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  await store.load();
  const second = await store.createProfile(fields());
  await store.selectProfile(second.id);

  const reloaded = makeStore(storage);
  await reloaded.load();
  assert.equal(reloaded.listProfiles().length, 2);
  assert.equal(reloaded.getActiveProfileId(), second.id);
  assert.equal(reloaded.getProfile(second.id).name, 'Second Worker');
  assert.equal(Object.keys(reloaded.getProfile(second.id).schedules).length, 1);
});

test('editing a profile keeps its existing confirmations', async () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  await store.load();
  const andrewId = store.getActiveProfileId();
  await store.confirmShift(andrewId, '2026-10-22');
  const before = store.getProfile(andrewId);
  assert.ok(before.confirmations['2026-10-22']);

  const updated = await store.updateProfile(andrewId, fields({
    name: 'Andrew Wamani Edited',
    schedulesText: '2026-10-22,07:00,17:00'
  }));
  assert.equal(updated.name, 'Andrew Wamani Edited');
  assert.equal(updated.createdAt, before.createdAt);
  assert.deepEqual(updated.confirmations, before.confirmations);
  assert.deepEqual(updated.schedules['2026-10-22'], { start: '07:00', end: '17:00' });
  assert.equal(updated.confirmations['2026-10-22'].shiftDate, '2026-10-22');
});

test('schedules and confirmations remain isolated between profiles', async () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  await store.load();
  const andrewId = store.getActiveProfileId();
  await store.confirmShift(andrewId, '2026-10-22');

  const second = await store.createProfile(fields());
  await store.confirmShift(second.id, '2026-10-23');
  const andrew = store.getProfile(andrewId);
  const other = store.getProfile(second.id);

  assert.deepEqual(Object.keys(andrew.confirmations), ['2026-10-22']);
  assert.deepEqual(Object.keys(other.confirmations), ['2026-10-23']);
  assert.equal(andrew.confirmations['2026-10-22'].address, andrew.address);
  assert.equal(other.confirmations['2026-10-23'].address, other.address);
  assert.equal(andrew.schedules['2026-10-23'], undefined);
});

test('deleting one profile never removes another profile or its confirmations', async () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  await store.load();
  const andrewId = store.getActiveProfileId();
  const second = await store.createProfile(fields());
  await store.confirmShift(second.id, '2026-10-23');
  await store.selectProfile(andrewId);

  await store.deleteProfile(second.id);
  assert.equal(store.getProfile(second.id), null);
  assert.equal(store.getProfile(andrewId).name, 'Andrew Wamani');
  assert.equal(Object.keys(store.getProfile(andrewId).confirmations).length, 0);

  const reloaded = makeStore(storage);
  await reloaded.load();
  assert.equal(reloaded.listProfiles().length, 1);
  assert.equal(reloaded.getProfile(second.id), null);
});

test('deleting every profile does not reseed Andrew on restart', async () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  await store.load();
  const andrew = store.getProfile(store.getActiveProfileId());
  await store.deleteProfile(andrew.id);

  const reloaded = makeStore(storage);
  await reloaded.load();
  assert.equal(reloaded.listProfiles().length, 0);
  assert.equal(reloaded.getActiveProfileId(), null);
});

test('confirmation rejects dates with no saved schedule', async () => {
  const store = makeStore();
  await store.load();
  const id = store.getActiveProfileId();
  await assert.rejects(() => store.confirmShift(id, '2026-10-23'), /No saved shift/);
  assert.equal(store.getProfile(id).confirmations['2026-10-23'], undefined);
});

test('confirmation is idempotent for the same profile and date', async () => {
  const store = makeStore();
  await store.load();
  const id = store.getActiveProfileId();
  const first = await store.confirmShift(id, '2026-10-22');
  const second = await store.confirmShift(id, '2026-10-22', {
    confirmedAt: new Date('2027-01-01T00:00:00.000Z')
  });
  assert.equal(second.confirmation.confirmedAt, first.confirmation.confirmedAt);
});

test('display time-zone changes are persisted per profile', async () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  await store.load();
  const id = store.getActiveProfileId();
  await store.setDisplayZone(id, 'Europe/Rome');

  const reloaded = makeStore(storage);
  await reloaded.load();
  assert.equal(reloaded.getProfile(id).displayZone, 'Europe/Rome');
  assert.equal(reloaded.getProfile(id).scheduleZone, 'Asia/Dubai');
  await assert.rejects(() => store.setDisplayZone(id, 'Bad/Zone'), /Unsupported/);
});

test('worker profile import is additive and keeps existing profiles and confirmations', async () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  await store.load();
  const andrewId = store.getActiveProfileId();
  const andrewBefore = await store.confirmShift(andrewId, '2026-10-22');
  const importedInput = {
    ...fields({
      name: 'Imported Worker',
      profileId: 'ID999',
      swipeId: 'SW999',
      schedulesText: '2026-10-24,22:00,06:00'
    }),
    id: 'worker_import_one',
    createdAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
    confirmations: {
      '2026-10-24': {
        shiftDate: '2026-10-24',
        confirmedAt: FIXED_NOW.toISOString(),
        timezone: 'Africa/Kampala'
      }
    }
  };

  const imported = await store.importProfile(importedInput);
  assert.equal(imported.id, 'worker_import_one');
  assert.equal(imported.swipeId, 'SW999');
  assert.deepEqual(imported.confirmations, {});
  assert.deepEqual(imported.schedules, { '2026-10-24': { start: '22:00', end: '06:00' } });
  assert.equal(store.listProfiles().length, 2);
  assert.equal(store.getActiveProfileId(), andrewId);
  assert.deepEqual(
    store.getProfile(andrewId).confirmations['2026-10-22'],
    andrewBefore.confirmation
  );

  const reloaded = makeStore(storage);
  await reloaded.load();
  assert.equal(reloaded.listProfiles().length, 2);
  assert.equal(reloaded.getProfile('worker_import_one').name, 'Imported Worker');
  assert.deepEqual(reloaded.getProfile('worker_import_one').confirmations, {});
  assert.deepEqual(
    reloaded.getProfile(andrewId).confirmations['2026-10-22'],
    andrewBefore.confirmation
  );
});

test('a failed worker import write leaves existing profiles unchanged', async () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  await store.load();
  const countBefore = store.listProfiles().length;
  const rawBefore = storage.raw(STORE_KEY);
  const incoming = {
    ...fields({
      name: 'Write Failure Worker',
      profileId: 'ID-FAIL',
      swipeId: 'SW-FAIL',
      schedulesText: '2026-10-27,06:00,16:00'
    }),
    id: 'worker_import_failure',
    confirmations: {}
  };
  storage.failKeys.add(STORE_KEY);
  await assert.rejects(() => store.importProfile(incoming), /could not be written/);
  assert.equal(store.listProfiles().length, countBefore);
  assert.equal(store.getProfile('worker_import_failure'), null);
  assert.equal(storage.raw(STORE_KEY), rawBefore);
});

test('duplicate worker profile IDs or Ogram Profile IDs are rejected without any write', async () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  await store.load();
  const importedInput = {
    ...fields({
      name: 'Imported Worker',
      profileId: 'ID999',
      swipeId: 'SW999',
      schedulesText: '2026-10-24,06:00,16:00'
    }),
    id: 'worker_import_one',
    confirmations: {}
  };
  await store.importProfile(importedInput);
  const rawBefore = storage.raw(STORE_KEY);
  const countBefore = store.listProfiles().length;

  await assert.rejects(
    () => store.importProfile(importedInput),
    /already on this phone/
  );
  assert.equal(storage.raw(STORE_KEY), rawBefore);
  assert.equal(store.listProfiles().length, countBefore);

  const sameAccountDifferentId = {
    ...fields({
      name: 'Duplicate Account',
      profileId: 'ID999',
      swipeId: 'SW998',
      schedulesText: '2026-10-26,06:00,16:00'
    }),
    id: 'worker_import_two',
    confirmations: {}
  };
  await assert.rejects(
    () => store.importProfile(sameAccountDifferentId),
    /Profile ID ID999 is already on this phone/
  );
  assert.equal(storage.raw(STORE_KEY), rawBefore);
  assert.equal(store.listProfiles().length, countBefore);
});

test('the store refuses data that could not be exported as a restorable backup', async () => {
  const schedules = [];
  for (let index = 0; index < 2501; index += 1) {
    const date = new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10);
    schedules.push(`${date},06:00,16:00`);
  }
  const schedulesText = schedules.join('\n');
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  await store.load();
  await store.createProfile(fields({ name: 'Large profile one', schedulesText }));
  const countBefore = store.listProfiles().length;
  const storedBefore = storage.raw(STORE_KEY);
  await assert.rejects(
    () => store.createProfile(fields({ name: 'Large profile two', schedulesText })),
    /could not be exported as a backup/
  );
  assert.equal(store.listProfiles().length, countBefore);
  assert.equal(storage.raw(STORE_KEY), storedBefore);
});

test('a failed write leaves in-memory and stored data unchanged', async () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  await store.load();
  const beforeRaw = storage.raw(STORE_KEY);
  const countBefore = store.listProfiles().length;
  storage.failKeys.add(STORE_KEY);

  await assert.rejects(() => store.createProfile(fields()), /could not be written/);
  assert.equal(store.listProfiles().length, countBefore);
  assert.equal(storage.raw(STORE_KEY), beforeRaw);

  const created = await store.createProfile(fields());
  assert.equal(created.name, 'Second Worker');
  assert.equal(store.listProfiles().length, countBefore + 1);
});

test('failed update and delete operations do not partially mutate memory', async () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  await store.load();
  const id = store.getActiveProfileId();
  const before = store.getProfile(id);
  storage.failKeys.add(STORE_KEY);
  await assert.rejects(() => store.updateProfile(id, fields({ name: 'Broken' })), StoreError);
  assert.equal(store.getProfile(id).name, before.name);

  storage.failKeys.add(STORE_KEY);
  await assert.rejects(() => store.deleteProfile(id), StoreError);
  assert.equal(store.getProfile(id).name, before.name);
});

test('corrupt stored data opens read-only and can be replaced by a validated restore', async () => {
  const storage = new MemoryStorage({ [STORE_KEY]: '{not json' });
  const store = makeStore(storage);
  await store.load();
  assert.equal(store.listProfiles().length, 0);
  assert.equal(store.readOnly, true);
  assert.match(store.loadWarning, /not valid JSON/i);
  assert.equal(storage.raw(STORE_KEY), '{not json');
  await assert.rejects(() => store.createProfile(fields()), /changes are disabled/);

  const validProfile = defaultAndrew(FIXED_NOW);
  await store.restoreProfiles([validProfile]);
  assert.equal(store.readOnly, false);
  assert.equal(store.listProfiles().length, 1);
  assert.equal(store.getProfile(validProfile.id).name, 'Andrew Wamani');
});

test('a failed restore write leaves existing data unchanged', async () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  await store.load();
  const beforeRaw = storage.raw(STORE_KEY);
  const beforeCount = store.listProfiles().length;
  storage.failKeys.add(STORE_KEY);
  await assert.rejects(() => store.restoreProfiles([profileFromForm(fields())].map((fieldsValue, index) => ({
    ...fieldsValue,
    id: `restore_${index}`,
    createdAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
    confirmations: {}
  }))), /could not be written/);
  assert.equal(storage.raw(STORE_KEY), beforeRaw);
  assert.equal(store.listProfiles().length, beforeCount);
});

test('legacy profile data migrates into the new state format', async () => {
  const legacy = {
    version: 1,
    updatedAt: FIXED_NOW.toISOString(),
    profiles: [defaultAndrew(FIXED_NOW)]
  };
  const storage = new MemoryStorage({
    [LEGACY_STORE_KEY]: JSON.stringify(legacy),
    [LEGACY_ACTIVE_KEY]: 'andrew-wamani-id432384'
  });
  const store = makeStore(storage);
  await store.load();
  assert.equal(store.listProfiles().length, 1);
  assert.equal(store.getActiveProfileId(), 'andrew-wamani-id432384');
  const migrated = JSON.parse(storage.raw(STORE_KEY));
  assert.equal(migrated.format, STORE_FORMAT);
  assert.equal(migrated.version, STORE_VERSION);
  assert.equal(storage.raw(LEGACY_STORE_KEY), JSON.stringify(legacy));
});

test('legacy migration storage failure is surfaced rather than treated as corrupt data', async () => {
  const legacy = {
    version: 1,
    profiles: [defaultAndrew(FIXED_NOW)]
  };
  const storage = new MemoryStorage({ [LEGACY_STORE_KEY]: JSON.stringify(legacy) });
  storage.failKeys.add(STORE_KEY);
  const store = makeStore(storage);
  await assert.rejects(() => store.load(), /could not be written/);
  assert.equal(storage.raw(STORE_KEY), null);
  assert.ok(storage.raw(LEGACY_STORE_KEY));
});

test('an empty stored profile list is preserved instead of seeding again', async () => {
  const emptyState = {
    format: STORE_FORMAT,
    version: STORE_VERSION,
    seedVersion: 1,
    updatedAt: FIXED_NOW.toISOString(),
    activeProfileId: null,
    profiles: []
  };
  const storage = new MemoryStorage({ [STORE_KEY]: JSON.stringify(emptyState) });
  const store = makeStore(storage);
  await store.load();
  assert.equal(store.listProfiles().length, 0);
  assert.equal(store.readOnly, false);
  assert.equal(store.getActiveProfileId(), null);
});

test('duplicate profile IDs in stored data are rejected read-only', async () => {
  const andrew = defaultAndrew(FIXED_NOW);
  const state = {
    format: STORE_FORMAT,
    version: STORE_VERSION,
    seedVersion: 1,
    updatedAt: FIXED_NOW.toISOString(),
    activeProfileId: andrew.id,
    profiles: [andrew, andrew]
  };
  const storage = new MemoryStorage({ [STORE_KEY]: JSON.stringify(state) });
  const store = makeStore(storage);
  await store.load();
  assert.equal(store.readOnly, true);
  assert.match(store.loadWarning, /duplicate profile ID/i);
  assert.equal(store.listProfiles().length, 0);
});

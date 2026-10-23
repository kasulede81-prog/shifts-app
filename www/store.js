import {
  MAX_PROFILE_COUNT,
  createBackup,
  defaultAndrew,
  normalizeProfile
} from './domain.js';
import { addDaysToDateKey, dateKeyInZone, getShiftBounds, isSupportedTimeZone, isValidDateKey } from './time.js';

export const STORE_FORMAT = 'DKASUShiftDashboardState';
export const STORE_VERSION = 2;
export const SEED_VERSION = 1;
export const STORE_KEY = 'dkasuShiftDashboard.state.v2';
export const LEGACY_STORE_KEY = 'dkasuMultiProfileDashboard.v1';
export const LEGACY_ACTIVE_KEY = 'dkasuMultiProfileDashboard.activeProfile.v1';

export class StoreError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'StoreError';
  }
}

export class ReadOnlyStoreError extends StoreError {
  constructor() {
    super('Saved profile data is unreadable, so changes are disabled. Restore a backup first.');
    this.name = 'ReadOnlyStoreError';
  }
}

function cloneProfile(profile, now) {
  return normalizeProfile(JSON.parse(JSON.stringify(profile)), { now });
}

function makeProfileId(idFactory, existing) {
  for (let attempts = 0; attempts < 20; attempts += 1) {
    const id = idFactory();
    if (typeof id === 'string' && !existing.has(id)) return id;
  }
  throw new StoreError('Could not allocate a unique profile ID.');
}

function makeClientEventId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseStoredProfiles(rawProfiles, now) {
  if (!Array.isArray(rawProfiles)) throw new StoreError('Stored profiles are not a list.');
  if (rawProfiles.length > MAX_PROFILE_COUNT) throw new StoreError('Stored profile count is too large.');
  const profiles = new Map();
  for (const raw of rawProfiles) {
    const profile = normalizeProfile(raw, { now });
    if (profiles.has(profile.id)) throw new StoreError(`Stored data contains duplicate profile ID ${profile.id}.`);
    profiles.set(profile.id, profile);
  }
  return profiles;
}

function parseState(raw, now) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StoreError('Saved profile data is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StoreError('Saved profile data has an unexpected shape.');
  }
  if (parsed.format !== STORE_FORMAT || parsed.version !== STORE_VERSION) {
    throw new StoreError('Saved profile data uses an unsupported format or version.');
  }
  const profiles = parseStoredProfiles(parsed.profiles, now);
  const activeProfileId = typeof parsed.activeProfileId === 'string' && profiles.has(parsed.activeProfileId)
    ? parsed.activeProfileId
    : null;
  const seedVersion = Number.isInteger(parsed.seedVersion) ? parsed.seedVersion : SEED_VERSION;
  return { profiles, activeProfileId, seedVersion };
}

function parseLegacyState(raw, now) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StoreError('Legacy profile data is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== 1) {
    throw new StoreError('Legacy profile data uses an unsupported format.');
  }
  return {
    profiles: parseStoredProfiles(parsed.profiles, now),
    activeProfileId: null,
    seedVersion: SEED_VERSION
  };
}

export class ProfileStore {
  constructor(storage, { now = () => new Date(), idFactory = undefined } = {}) {
    if (!storage
      || typeof storage.getItem !== 'function'
      || typeof storage.setItem !== 'function') {
      throw new StoreError('A persistent storage adapter is required.');
    }
    this.storage = storage;
    this.now = now;
    this.idFactory = idFactory || (() => `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`);
    this.profiles = new Map();
    this.activeProfileId = null;
    this.seedVersion = SEED_VERSION;
    this.loadWarning = '';
    this.readOnly = false;
    this.workerMode = false;
    this.workerAllowedProfileIds = null;
    this.loaded = false;
    this._queue = Promise.resolve();
  }

  async load() {
    if (this.loaded) return this;
    const now = this.now();
    const currentRaw = await this.storage.getItem(STORE_KEY);
    if (currentRaw !== null && currentRaw !== undefined) {
      try {
        const state = parseState(currentRaw, now);
        this.profiles = state.profiles;
        this.activeProfileId = state.activeProfileId;
        this.seedVersion = state.seedVersion;
      } catch (error) {
        this.readOnly = true;
        this.loadWarning = `${error.message} No stored data was overwritten. Restore a valid backup.`;
      }
      this.loaded = true;
      return this;
    }

    const legacyRaw = await this.storage.getItem(LEGACY_STORE_KEY);
    if (legacyRaw !== null && legacyRaw !== undefined) {
      let state;
      try {
        state = parseLegacyState(legacyRaw, now);
      } catch (error) {
        if (error instanceof StoreError) {
          this.readOnly = true;
          this.loadWarning = `${error.message} No stored data was overwritten. Restore a valid backup.`;
        } else {
          throw error;
        }
        this.loaded = true;
        return this;
      }
      const legacyActive = await this.storage.getItem(LEGACY_ACTIVE_KEY);
      if (typeof legacyActive === 'string' && state.profiles.has(legacyActive)) {
        state.activeProfileId = legacyActive;
      }
      await this._writeState(state.profiles, state.activeProfileId, state.seedVersion, now);
      this.loaded = true;
      return this;
    }

    const seeded = defaultAndrew(now);
    const profiles = new Map([[seeded.id, seeded]]);
    await this._writeState(profiles, seeded.id, SEED_VERSION, now);
    this.loaded = true;
    return this;
  }

  _assertMutable() {
    if (this.readOnly) throw new ReadOnlyStoreError();
  }

  _assertAdminMutable() {
    this._assertMutable();
    if (this.workerMode) throw new StoreError('Worker profiles and schedules are managed by the DKASU admin.');
  }

  _enqueue(task) {
    const run = () => task();
    const result = this._queue.then(run, run);
    this._queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async _writeState(profiles, activeProfileId, seedVersion, now = this.now()) {
    const sorted = [...profiles.values()].sort(
      (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
    );
    try {
      // Refuse to persist a state that could not later be exported and
      // restored. This keeps storage and backup limits consistent.
      createBackup(sorted, now);
    } catch (error) {
      throw new StoreError(`The change was not saved because the profiles could not be exported as a backup. ${error.message}`, {
        cause: error
      });
    }
    const payload = {
      format: STORE_FORMAT,
      version: STORE_VERSION,
      seedVersion,
      updatedAt: now.toISOString(),
      activeProfileId: activeProfileId || null,
      profiles: sorted
    };
    try {
      await this.storage.setItem(STORE_KEY, JSON.stringify(payload));
    } catch (error) {
      throw new StoreError('The change could not be written to device storage. No saved data was replaced.', {
        cause: error
      });
    }
    this.profiles = new Map(profiles);
    this.activeProfileId = activeProfileId || null;
    this.seedVersion = seedVersion;
  }

  listProfiles() {
    const now = this.now();
    const profiles = [...this.profiles.values()];
    const visible = this.workerMode && this.workerAllowedProfileIds instanceof Set
      ? profiles.filter((profile) => this.workerAllowedProfileIds.has(profile.id))
      : profiles;
    return visible
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((profile) => cloneProfile(profile, now));
  }

  getProfile(id) {
    const profile = this.profiles.get(id);
    return profile ? cloneProfile(profile, this.now()) : null;
  }

  getActiveProfile() {
    return this.activeProfileId ? this.getProfile(this.activeProfileId) : null;
  }

  getActiveProfileId() {
    return this.activeProfileId;
  }

  async createProfile(fields) {
    return this._enqueue(async () => {
      this._assertAdminMutable();
      const now = this.now();
      const id = makeProfileId(this.idFactory, this.profiles);
      const profile = normalizeProfile({
        ...fields,
        id,
        confirmations: {},
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      }, { now });
      const next = new Map(this.profiles);
      next.set(id, profile);
      await this._writeState(next, id, this.seedVersion, now);
      return cloneProfile(profile, now);
    });
  }

  async updateProfile(id, fields) {
    return this._enqueue(async () => {
      this._assertAdminMutable();
      const existing = this.profiles.get(id);
      if (!existing) throw new StoreError('The profile no longer exists.');
      const now = this.now();
      const profile = normalizeProfile({
        ...JSON.parse(JSON.stringify(existing)),
        ...fields,
        id: existing.id,
        confirmations: existing.confirmations,
        createdAt: existing.createdAt,
        updatedAt: now.toISOString()
      }, { now });
      const next = new Map(this.profiles);
      next.set(id, profile);
      await this._writeState(next, this.activeProfileId, this.seedVersion, now);
      return cloneProfile(profile, now);
    });
  }

  async deleteProfile(id) {
    return this._enqueue(async () => {
      this._assertAdminMutable();
      if (!this.profiles.has(id)) throw new StoreError('The profile no longer exists.');
      const next = new Map(this.profiles);
      next.delete(id);
      const nextActive = this.activeProfileId === id ? null : this.activeProfileId;
      await this._writeState(next, nextActive, this.seedVersion, this.now());
      return true;
    });
  }

  async selectProfile(id) {
    return this._enqueue(async () => {
      this._assertMutable();
      if (this.workerMode && id !== null && this.workerAllowedProfileIds instanceof Set && !this.workerAllowedProfileIds.has(id)) {
        throw new StoreError('This swipe account is not assigned to your operator account.');
      }
      if (id !== null && !this.profiles.has(id)) throw new StoreError('The selected profile no longer exists.');
      await this._writeState(this.profiles, id, this.seedVersion, this.now());
      return id;
    });
  }

  async setDisplayZone(id, zone) {
    return this._enqueue(async () => {
      this._assertMutable();
      if (!isSupportedTimeZone(zone)) throw new StoreError('Unsupported display time zone.');
      const existing = this.profiles.get(id);
      if (!existing) throw new StoreError('The profile no longer exists.');
      const now = this.now();
      const profile = normalizeProfile({
        ...JSON.parse(JSON.stringify(existing)),
        displayZone: zone,
        updatedAt: now.toISOString()
      }, { now });
      const next = new Map(this.profiles);
      next.set(id, profile);
      await this._writeState(next, this.activeProfileId, this.seedVersion, now);
      return cloneProfile(profile, now);
    });
  }

  async confirmShift(id, date, { confirmedAt = this.now(), queueForSync = false, syncActorId = '' } = {}) {
    return this._enqueue(async () => {
      this._assertMutable();
      if (!isValidDateKey(date)) throw new StoreError('Invalid shift date.');
      const existing = this.profiles.get(id);
      if (!existing) throw new StoreError('The profile no longer exists.');
      const schedule = existing.schedules[date];
      if (!schedule) throw new StoreError('No saved shift exists for this date.');
      try {
        getShiftBounds(date, schedule, existing.scheduleZone);
      } catch {
        throw new StoreError('The saved shift for this date is invalid.');
      }
      if (existing.confirmations[date]) {
        return {
          profile: cloneProfile(existing, this.now()),
          confirmation: { ...existing.confirmations[date] }
        };
      }
      const now = this.now();
      const record = {
        shiftDate: date,
        confirmedAt: confirmedAt.toISOString(),
        timezone: existing.displayZone,
        ...(queueForSync ? { clientEventId: makeClientEventId(), syncStatus: 'pending', ...(syncActorId ? { syncActorId } : {}) } : {}),
        ...(existing.address ? { address: existing.address } : {})
      };
      const profile = normalizeProfile({
        ...JSON.parse(JSON.stringify(existing)),
        confirmations: {
          ...existing.confirmations,
          [date]: record
        },
        updatedAt: now.toISOString()
      }, { now });
      const next = new Map(this.profiles);
      next.set(id, profile);
      await this._writeState(next, this.activeProfileId, this.seedVersion, now);
      return {
        profile: cloneProfile(profile, now),
        confirmation: { ...profile.confirmations[date] }
      };
    });
  }

  getPendingConfirmations(id) {
    const profile = this.profiles.get(id);
    if (!profile) return [];
    return Object.values(profile.confirmations)
      .filter((record) => record.syncStatus === 'pending' && record.clientEventId)
      .map((record) => ({ ...record }));
  }

  async markConfirmationSynced(id, clientEventId, syncedAt = this.now()) {
    return this._enqueue(async () => {
      this._assertMutable();
      const existing = this.profiles.get(id);
      if (!existing) throw new StoreError('The worker profile no longer exists.');
      const date = Object.keys(existing.confirmations).find(
        (key) => existing.confirmations[key].clientEventId === clientEventId
      );
      if (!date) return false;
      const current = existing.confirmations[date];
      if (current.syncStatus === 'synced') return true;
      const now = this.now();
      const profile = normalizeProfile({
        ...JSON.parse(JSON.stringify(existing)),
        confirmations: {
          ...existing.confirmations,
          [date]: { ...current, syncStatus: 'synced', syncedAt: syncedAt.toISOString() }
        },
        updatedAt: now.toISOString()
      }, { now });
      const next = new Map(this.profiles);
      next.set(id, profile);
      await this._writeState(next, this.activeProfileId, this.seedVersion, now);
      return true;
    });
  }

  async restoreProfiles(profiles) {
    return this._enqueue(async () => {
      // Restore is the recovery path out of a read-only state, so it must not
      // call _assertMutable(). Worker mode still cannot replace admin-managed
      // profiles with a device backup.
      if (this.workerMode) throw new StoreError('Worker profiles and schedules are managed by the DKASU admin.');
      if (!Array.isArray(profiles) || profiles.length === 0) {
        throw new StoreError('A backup must contain at least one profile.');
      }
      if (profiles.length > MAX_PROFILE_COUNT) throw new StoreError('Backup contains too many profiles.');
      const now = this.now();
      const next = new Map();
      for (const raw of profiles) {
        const profile = normalizeProfile(raw, { now });
        if (next.has(profile.id)) throw new StoreError(`Duplicate profile ID: ${profile.id}.`);
        next.set(profile.id, profile);
      }
      await this._writeState(next, null, this.seedVersion, now);
      this.readOnly = false;
      this.loadWarning = '';
      return this.listProfiles();
    });
  }

  async importProfile(raw) {
    return this._enqueue(async () => {
      this._assertAdminMutable();
      const now = this.now();
      const profile = normalizeProfile(raw, { now });
      const duplicatePackage = this.profiles.get(profile.id);
      if (duplicatePackage) {
        throw new StoreError(
          `This worker profile is already on this phone as "${duplicatePackage.name}". Nothing was imported.`
        );
      }
      if (profile.profileId) {
        const duplicateAccount = [...this.profiles.values()].find(
          (existing) => existing.profileId && existing.profileId === profile.profileId
        );
        if (duplicateAccount) {
          throw new StoreError(
            `Profile ID ${profile.profileId} is already on this phone as "${duplicateAccount.name}". Nothing was imported.`
          );
        }
      }
      if (this.profiles.size + 1 > MAX_PROFILE_COUNT) {
        throw new StoreError('Import would exceed the profile limit. Nothing was imported.');
      }
      // Worker handoff packages never carry confirmation history. Be defensive
      // even if this method is called directly with package data.
      profile.confirmations = {};
      const next = new Map(this.profiles);
      next.set(profile.id, profile);
      await this._writeState(next, this.activeProfileId, this.seedVersion, now);
      return cloneProfile(profile, now);
    });
  }

  async syncRemoteWorker(worker, scheduleRows, dailyRule = null) {
    return this._enqueue(async () => {
      this._assertMutable();
      if (!worker?.id || !Array.isArray(scheduleRows)) throw new StoreError('The worker account data is incomplete.');
      const remoteId = `shift_${worker.id}`;
      const sourceId = typeof worker.source_local_id === 'string' ? worker.source_local_id : '';
      const existingRemote = this.profiles.get(remoteId);
      const existingSource = sourceId ? this.profiles.get(sourceId) : null;
      const id = existingRemote?.id || existingSource?.id || remoteId;
      const existing = existingRemote || existingSource;
      const preservedConfirmations = {
        ...(existingSource?.confirmations || {}),
        ...(existingRemote?.confirmations || {})
      };
      const now = this.now();
      const scheduleZone = worker.schedule_timezone || dailyRule?.schedule_timezone || 'Asia/Dubai';
      const schedules = {};
      if (dailyRule) {
        const today = dateKeyInZone(now, scheduleZone);
        const horizonEnd = addDaysToDateKey(today, 365);
        const starts = [dailyRule.effective_from, today, worker.contract_start]
          .filter((value) => isValidDateKey(value))
          .sort();
        const ends = [dailyRule.effective_until, horizonEnd, worker.contract_end]
          .filter((value) => isValidDateKey(value))
          .sort();
        const startDate = starts[starts.length - 1];
        const endDate = ends[0];
        if (startDate <= endDate) {
          for (let date = startDate; date <= endDate; date = addDaysToDateKey(date, 1)) {
            schedules[date] = {
              start: String(dailyRule.start_time || '').slice(0, 5),
              end: String(dailyRule.end_time || '').slice(0, 5),
              scheduleZone: dailyRule.schedule_timezone || scheduleZone
            };
          }
        }
      }
      for (const row of scheduleRows) {
        if (row.schedule_kind === 'off') {
          delete schedules[row.shift_date];
        } else {
          schedules[row.shift_date] = {
            start: String(row.start_time || '').slice(0, 5),
            end: String(row.end_time || '').slice(0, 5),
            scheduleZone: row.schedule_timezone || scheduleZone
          };
        }
      }
      const profile = normalizeProfile({
        id,
        name: worker.name,
        email: worker.email,
        profileId: worker.ogram_profile_id || '',
        swipeId: worker.swipe_id || '',
        job: worker.job_title || '',
        company: worker.company_name || 'DKASU',
        location: worker.location || '',
        address: worker.address || '',
        contractStart: worker.contract_start || '',
        contractEnd: worker.contract_end || '',
        displayZone: existing?.displayZone || worker.display_timezone || 'Asia/Dubai',
        scheduleZone,
        schedules,
        confirmations: preservedConfirmations,
        createdAt: existing?.createdAt || now.toISOString(),
        updatedAt: now.toISOString()
      }, { now });
      const next = new Map(this.profiles);
      next.set(id, profile);
      const nextActive = this.activeProfileId && next.has(this.activeProfileId) ? this.activeProfileId : id;
      await this._writeState(next, nextActive, this.seedVersion, now);
      return cloneProfile(profile, now);
    });
  }
}

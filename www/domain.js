import {
  TZ,
  TIME_ZONE_OPTIONS,
  isSupportedTimeZone,
  isValidDateKey,
  isValidTime
} from './time.js';

export const BACKUP_FORMAT = 'DKASUShiftDashboardBackup';
export const BACKUP_VERSION = 2;
export const WORKER_PACKAGE_FORMAT = 'DKASUShiftWorkerProfile';
export const WORKER_PACKAGE_VERSION = 1;
export const MAX_PROFILE_COUNT = 200;
export const MAX_SCHEDULE_COUNT = 5000;
export const MAX_BACKUP_CHARS = 5_000_000;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const TEXT_LIMITS = Object.freeze({
  id: 100,
  name: 100,
  email: 150,
  profileId: 80,
  swipeId: 80,
  job: 100,
  company: 150,
  location: 180,
  address: 250
});

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object.`);
  }
  return value;
}

function readText(value, label, { required = false, max = 500 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${label} is required.`);
    return '';
  }
  if (typeof value !== 'string') throw new ValidationError(`${label} must be text.`);
  const text = value.trim();
  if (required && !text) throw new ValidationError(`${label} is required.`);
  if (text.length > max) throw new ValidationError(`${label} must be ${max} characters or fewer.`);
  return text;
}

function readOptionalIsoTimestamp(value, label, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') throw new ValidationError(`${label} must be an ISO timestamp.`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new ValidationError(`${label} is not a valid timestamp.`);
  return parsed.toISOString();
}

function readContractDate(value, label) {
  const date = readText(value, label, { max: 10 });
  if (date && !isValidDateKey(date)) throw new ValidationError(`${label} must use YYYY-MM-DD.`);
  return date;
}

function readZone(value, label, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !isSupportedTimeZone(value)) {
    throw new ValidationError(`${label} is not a supported time zone.`);
  }
  return value;
}

function normalizeSchedules(raw) {
  if (raw === undefined || raw === null) return {};
  requireObject(raw, 'Schedules');
  const entries = Object.entries(raw);
  if (entries.length > MAX_SCHEDULE_COUNT) {
    throw new ValidationError(`A profile cannot contain more than ${MAX_SCHEDULE_COUNT} shifts.`);
  }
  const normalized = [];
  for (const [date, schedule] of entries) {
    if (!isValidDateKey(date)) {
      throw new ValidationError(`Schedule date "${date}" must use YYYY-MM-DD.`);
    }
    requireObject(schedule, `Shift ${date}`);
    if (typeof schedule.start !== 'string' || !isValidTime(schedule.start)) {
      throw new ValidationError(`Shift ${date} has an invalid start time.`);
    }
    if (typeof schedule.end !== 'string' || !isValidTime(schedule.end)) {
      throw new ValidationError(`Shift ${date} has an invalid end time.`);
    }
    if (schedule.start === schedule.end) {
      throw new ValidationError(`Shift ${date} must have different start and end times.`);
    }
    const normalizedShift = { start: schedule.start, end: schedule.end };
    if (schedule.scheduleZone !== undefined) {
      normalizedShift.scheduleZone = readZone(schedule.scheduleZone, `Shift ${date} time zone`, TZ.dubai);
    }
    normalized.push([date, normalizedShift]);
  }
  normalized.sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(normalized);
}

function normalizeConfirmations(raw, fallbackZone) {
  if (raw === undefined || raw === null) return {};
  requireObject(raw, 'Confirmations');
  const normalized = [];
  for (const [date, record] of Object.entries(raw)) {
    if (!isValidDateKey(date)) {
      throw new ValidationError(`Confirmation date "${date}" must use YYYY-MM-DD.`);
    }
    requireObject(record, `Confirmation for ${date}`);
    if (record.shiftDate !== date) {
      throw new ValidationError(`Confirmation for ${date} must identify the same shift date.`);
    }
    if (typeof record.confirmedAt !== 'string') {
      throw new ValidationError(`Confirmation for ${date} has no timestamp.`);
    }
    const confirmedAt = new Date(record.confirmedAt);
    if (Number.isNaN(confirmedAt.getTime())) {
      throw new ValidationError(`Confirmation for ${date} has an invalid timestamp.`);
    }
    const timezone = readZone(record.timezone, 'Confirmation time zone', fallbackZone);
    const address = readText(record.address, 'Confirmation address', {
      max: TEXT_LIMITS.address
    });
    const clientEventId = readText(record.clientEventId, 'Confirmation event ID', { max: 36 });
    if (clientEventId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientEventId)) {
      throw new ValidationError(`Confirmation for ${date} has an invalid sync event ID.`);
    }
    const syncStatus = record.syncStatus || '';
    if (syncStatus && (!clientEventId || !['pending', 'synced'].includes(syncStatus))) {
      throw new ValidationError(`Confirmation for ${date} has invalid sync state.`);
    }
    const syncedAt = record.syncedAt
      ? readOptionalIsoTimestamp(record.syncedAt, 'Confirmation sync time', '')
      : '';
    const syncActorId = readText(record.syncActorId, 'Confirmation operator ID', { max: 36 });
    if (syncActorId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(syncActorId)) {
      throw new ValidationError(`Confirmation for ${date} has an invalid operator ID.`);
    }
    normalized.push([date, {
      shiftDate: date,
      confirmedAt: confirmedAt.toISOString(),
      timezone,
      ...(address ? { address } : {}),
      ...(clientEventId ? { clientEventId } : {}),
      ...(syncStatus ? { syncStatus } : {}),
      ...(syncedAt ? { syncedAt } : {}),
      ...(syncActorId ? { syncActorId } : {})
    }]);
  }
  normalized.sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(normalized);
}

export function normalizeProfile(raw, { now = new Date() } = {}) {
  requireObject(raw, 'Profile');
  // Stored/legacy data is preserved as-is where it is safe to do so. New
  // profile edits still validate email syntax in profileFromForm().
  const id = readText(raw.id, 'Profile ID', { required: true, max: TEXT_LIMITS.id });
  const name = readText(raw.name, 'Full name', { required: true, max: TEXT_LIMITS.name });
  const email = readText(raw.email, 'Account email', { max: TEXT_LIMITS.email });
  const profileId = readText(raw.profileId, 'Ogram profile ID', { max: TEXT_LIMITS.profileId });
  const swipeId = readText(raw.swipeId, 'Swipe ID', { max: TEXT_LIMITS.swipeId });
  const job = readText(raw.job, 'Job title', { max: TEXT_LIMITS.job });
  const company = readText(raw.company, 'Company', { max: TEXT_LIMITS.company });
  const location = readText(raw.location, 'Work location', { max: TEXT_LIMITS.location });
  const address = readText(raw.address, 'Work address', { max: TEXT_LIMITS.address });
  const contractStart = readContractDate(raw.contractStart, 'Contract start date');
  const contractEnd = readContractDate(raw.contractEnd, 'Contract end date');
  if (contractStart && contractEnd && contractEnd < contractStart) {
    throw new ValidationError('Contract end date must be on or after the start date.');
  }
  const displayZone = readZone(raw.displayZone, 'Display time zone', TZ.dubai);
  const scheduleZone = readZone(raw.scheduleZone, 'Schedule time zone', TZ.dubai);
  const schedules = normalizeSchedules(raw.schedules);
  const confirmations = normalizeConfirmations(raw.confirmations, displayZone);
  const nowIso = now.toISOString();
  const createdAt = readOptionalIsoTimestamp(raw.createdAt, 'Created timestamp', nowIso);
  const updatedAt = readOptionalIsoTimestamp(raw.updatedAt, 'Updated timestamp', createdAt);

  return {
    id,
    name,
    email,
    profileId,
    swipeId,
    job,
    company,
    location,
    address,
    contractStart,
    contractEnd,
    displayZone,
    scheduleZone,
    schedules,
    confirmations,
    createdAt,
    updatedAt
  };
}

export function defaultAndrew(now = new Date()) {
  const schedule = { start: '06:00', end: '16:00' };
  return normalizeProfile({
    id: 'andrew-wamani-id432384',
    name: 'Andrew Wamani',
    email: 'wamaniandrew26@gmail.com',
    profileId: 'ID432384',
    swipeId: 'ID55911',
    job: 'Warehouse Operator',
    company: 'Transcorp International Logistics',
    location: 'UAEW Warehouse – DIP 2',
    address: 'Dubai Festival City Mall - Crescent Rd - Dubai',
    contractStart: '2026-10-15',
    contractEnd: '2026-12-15',
    displayZone: TZ.dubai,
    scheduleZone: TZ.dubai,
    schedules: {
      '2026-10-15': schedule,
      '2026-10-16': schedule,
      '2026-10-17': schedule,
      '2026-10-18': schedule,
      '2026-10-19': schedule,
      '2026-10-22': schedule
    },
    confirmations: {},
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  }, { now });
}

export function parseScheduleLines(text) {
  if (typeof text !== 'string') throw new ValidationError('Schedule text must be text.');
  const lines = text.split(/\r?\n/);
  const schedules = {};
  if (lines.length > MAX_SCHEDULE_COUNT + 100) {
    throw new ValidationError('Too many schedule lines.');
  }
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    const match = line.match(/^(\d{4}-\d{2}-\d{2})\s*,\s*(\d{2}:\d{2})\s*,\s*(\d{2}:\d{2})$/);
    if (!match) {
      throw new ValidationError(`Schedule line ${index + 1} must use YYYY-MM-DD,HH:MM,HH:MM.`);
    }
    const [, date, start, end] = match;
    if (!isValidDateKey(date)) {
      throw new ValidationError(`Schedule line ${index + 1} has an invalid calendar date.`);
    }
    if (!isValidTime(start) || !isValidTime(end)) {
      throw new ValidationError(`Schedule line ${index + 1} has an invalid time.`);
    }
    if (start === end) {
      throw new ValidationError(`Schedule line ${index + 1} must have different start and end times.`);
    }
    if (Object.prototype.hasOwnProperty.call(schedules, date)) {
      throw new ValidationError(`Duplicate schedule date on line ${index + 1}: ${date}.`);
    }
    schedules[date] = { start, end };
  });
  return Object.fromEntries(
    Object.entries(schedules).sort(([left], [right]) => left.localeCompare(right))
  );
}

export function schedulesToText(schedules) {
  return Object.entries(schedules || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, shift]) => `${date},${shift.start},${shift.end}`)
    .join('\n');
}

export function profileFromForm(form) {
  requireObject(form, 'Profile form');
  const name = readText(form.name, 'Full name', { required: true, max: TEXT_LIMITS.name });
  const address = readText(form.address, 'Work address', { required: true, max: TEXT_LIMITS.address });
  const email = readText(form.email, 'Account email', { max: TEXT_LIMITS.email });
  if (email && !EMAIL_PATTERN.test(email)) {
    throw new ValidationError('Enter a valid email address or leave the field blank.');
  }
  const contractStart = readContractDate(form.contractStart, 'Contract start date');
  const contractEnd = readContractDate(form.contractEnd, 'Contract end date');
  if (contractStart && contractEnd && contractEnd < contractStart) {
    throw new ValidationError('Contract end date must be on or after the start date.');
  }
  if (!isSupportedTimeZone(form.displayZone)) {
    throw new ValidationError('Choose a supported display time zone.');
  }
  if (!isSupportedTimeZone(form.scheduleZone)) {
    throw new ValidationError('Choose a supported schedule time zone.');
  }
  return {
    name,
    email,
    profileId: readText(form.profileId, 'Ogram profile ID', { max: TEXT_LIMITS.profileId }),
    swipeId: readText(form.swipeId, 'Swipe ID', { max: TEXT_LIMITS.swipeId }),
    job: readText(form.job, 'Job title', { max: TEXT_LIMITS.job }),
    company: readText(form.company, 'Company', { max: TEXT_LIMITS.company }),
    location: readText(form.location, 'Work location', { max: TEXT_LIMITS.location }),
    address,
    contractStart,
    contractEnd,
    displayZone: form.displayZone,
    scheduleZone: form.scheduleZone,
    schedules: parseScheduleLines(form.schedulesText || '', form.scheduleZone)
  };
}

function cloneAsProfile(profile, now) {
  return normalizeProfile(JSON.parse(JSON.stringify(profile)), { now });
}

export function createBackup(profiles, now = new Date()) {
  if (!Array.isArray(profiles)) throw new ValidationError('Profiles must be a list.');
  if (profiles.length > MAX_PROFILE_COUNT) {
    throw new ValidationError(`Cannot back up more than ${MAX_PROFILE_COUNT} profiles.`);
  }
  const normalized = profiles.map((profile) => cloneAsProfile(profile, now));
  const ids = new Set();
  let scheduleCount = 0;
  for (const profile of normalized) {
    if (ids.has(profile.id)) throw new ValidationError(`Duplicate profile ID: ${profile.id}.`);
    ids.add(profile.id);
    scheduleCount += Object.keys(profile.schedules).length;
    if (scheduleCount > MAX_SCHEDULE_COUNT) {
      throw new ValidationError(`Cannot back up more than ${MAX_SCHEDULE_COUNT} scheduled shifts in total.`);
    }
  }
  normalized.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  const backup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    profileCount: normalized.length,
    profiles: normalized
  };
  if (JSON.stringify(backup, null, 2).length > MAX_BACKUP_CHARS) {
    throw new ValidationError('The profiles are too large to fit in a supported backup file.');
  }
  return backup;
}

export function createWorkerProfilePackage(profile, now = new Date()) {
  if (!profile) throw new ValidationError('Choose a worker profile to export.');
  const normalized = cloneAsProfile(profile, now);
  // A worker handoff package contains setup data only. Confirmation history and
  // App-lock material is intentionally absent.
  delete normalized.confirmations;
  const workerPackage = {
    format: WORKER_PACKAGE_FORMAT,
    version: WORKER_PACKAGE_VERSION,
    exportedAt: now.toISOString(),
    profile: normalized
  };
  if (JSON.stringify(workerPackage, null, 2).length > MAX_BACKUP_CHARS) {
    throw new ValidationError('The worker profile is too large to fit in a supported package.');
  }
  return workerPackage;
}

export function parseWorkerProfilePackageText(text, now = new Date()) {
  if (typeof text !== 'string' || !text.trim()) throw new ValidationError('Profile package is empty.');
  if (text.length > MAX_BACKUP_CHARS) throw new ValidationError('Profile package is too large.');
  let data;
  try { data = JSON.parse(text); } catch { throw new ValidationError('Profile package is not valid JSON.'); }
  requireObject(data, 'Profile package');
  if (data.format !== WORKER_PACKAGE_FORMAT || data.version !== WORKER_PACKAGE_VERSION) {
    throw new ValidationError('This is not a supported DKASU worker profile package.');
  }
  if (typeof data.exportedAt !== 'string' || Number.isNaN(new Date(data.exportedAt).getTime())) {
    throw new ValidationError('Profile package export timestamp is invalid.');
  }
  const unexpectedTopLevel = Object.keys(data).filter(
    (key) => !['format', 'version', 'exportedAt', 'profile'].includes(key)
  );
  if (unexpectedTopLevel.length) {
    throw new ValidationError(`Worker profile package contains unsupported field "${unexpectedTopLevel[0]}".`);
  }
  requireObject(data.profile, 'Worker profile');
  if (Object.prototype.hasOwnProperty.call(data.profile, 'confirmations')) {
    throw new ValidationError('Worker profile packages must not contain confirmation history.');
  }
  const allowedProfileFields = new Set([
    'id', 'name', 'email', 'profileId', 'swipeId', 'job', 'company', 'location',
    'address', 'contractStart', 'contractEnd', 'displayZone', 'scheduleZone',
    'schedules', 'createdAt', 'updatedAt'
  ]);
  const unexpectedProfile = Object.keys(data.profile).filter((key) => !allowedProfileFields.has(key));
  if (unexpectedProfile.length) {
    throw new ValidationError(`Worker profile contains unsupported field "${unexpectedProfile[0]}".`);
  }
  const profile = normalizeProfile(data.profile, { now });
  // Never import confirmation history, even if a future package shape tries to
  // carry it alongside an otherwise valid profile.
  profile.confirmations = {};
  return {
    format: WORKER_PACKAGE_FORMAT,
    version: WORKER_PACKAGE_VERSION,
    exportedAt: new Date(data.exportedAt).toISOString(),
    profile
  };
}

export function parseBackupText(text, now = new Date()) {
  if (typeof text !== 'string') throw new ValidationError('Backup file must be text.');
  if (!text.trim()) throw new ValidationError('Backup file is empty.');
  if (text.length > MAX_BACKUP_CHARS) throw new ValidationError('Backup file is too large.');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ValidationError('Backup is not valid JSON.');
  }
  requireObject(data, 'Backup');
  if (data.format !== BACKUP_FORMAT) {
    throw new ValidationError('This is not a DKASU shift dashboard backup.');
  }
  if (data.version !== 1 && data.version !== BACKUP_VERSION) {
    throw new ValidationError('This backup version is not supported.');
  }
  if (!Array.isArray(data.profiles)) throw new ValidationError('Backup profiles must be a list.');
  if (data.profiles.length < 1) throw new ValidationError('Backup contains no profiles.');
  if (data.profiles.length > MAX_PROFILE_COUNT) {
    throw new ValidationError(`Backup contains more than ${MAX_PROFILE_COUNT} profiles.`);
  }
  if (typeof data.exportedAt !== 'string' || Number.isNaN(new Date(data.exportedAt).getTime())) {
    throw new ValidationError('Backup export timestamp is invalid.');
  }
  const profiles = [];
  const ids = new Set();
  let scheduleCount = 0;
  for (const raw of data.profiles) {
    const profile = normalizeProfile(raw, { now });
    if (ids.has(profile.id)) throw new ValidationError(`Backup contains duplicate profile ID: ${profile.id}.`);
    ids.add(profile.id);
    scheduleCount += Object.keys(profile.schedules).length;
    if (scheduleCount > MAX_SCHEDULE_COUNT) {
      throw new ValidationError('Backup contains too many scheduled shifts.');
    }
    profiles.push(profile);
  }
  return {
    format: BACKUP_FORMAT,
    version: data.version,
    exportedAt: new Date(data.exportedAt).toISOString(),
    profiles
  };
}

export const PROFILE_FIELD_LIMITS = TEXT_LIMITS;
export const SUPPORTED_TIME_ZONES = TIME_ZONE_OPTIONS;

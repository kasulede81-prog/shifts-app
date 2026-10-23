import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BACKUP_FORMAT,
  ValidationError,
  WORKER_PACKAGE_FORMAT,
  WORKER_PACKAGE_VERSION,
  createBackup,
  createWorkerProfilePackage,
  defaultAndrew,
  normalizeProfile,
  parseBackupText,
  parseScheduleLines,
  parseWorkerProfilePackageText,
  profileFromForm,
  schedulesToText
} from '../www/domain.js';

const NOW = new Date('2026-10-22T08:00:00.000Z');

function baseForm(overrides = {}) {
  return {
    name: 'Test Worker',
    email: 'worker@example.com',
    profileId: 'ID123',
    swipeId: 'SW123',
    job: 'Operator',
    company: 'Example Co',
    location: 'Site A',
    address: '1 Example Street',
    contractStart: '2026-10-01',
    contractEnd: '2026-12-01',
    displayZone: 'Asia/Dubai',
    scheduleZone: 'Asia/Dubai',
    schedulesText: '2026-10-22,06:00,16:00',
    ...overrides
  };
}

function profile(overrides = {}) {
  const fields = profileFromForm(baseForm(overrides));
  return normalizeProfile({
    ...fields,
    id: overrides.id || 'profile_one',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    confirmations: overrides.confirmations || {}
  }, { now: NOW });
}

test('seeded Andrew profile preserves the original schedule and no confirmations', () => {
  const andrew = defaultAndrew(NOW);
  assert.equal(andrew.id, 'andrew-wamani-id432384');
  assert.equal(andrew.profileId, 'ID432384');
  assert.equal(andrew.swipeId, 'ID55911');
  assert.deepEqual(Object.keys(andrew.schedules), [
    '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-22'
  ]);
  assert.equal(andrew.schedules['2026-10-22'].start, '06:00');
  assert.equal(andrew.schedules['2026-10-22'].end, '16:00');
  assert.deepEqual(andrew.confirmations, {});
});

test('schedule parser accepts overnight shifts and rejects duplicates or impossible data', () => {
  const parsed = parseScheduleLines([
    '2026-10-24,22:00,06:00',
    '2026-10-23,06:00,16:00'
  ].join('\n'));
  assert.deepEqual(Object.keys(parsed), ['2026-10-23', '2026-10-24']);
  assert.deepEqual(parsed['2026-10-24'], { start: '22:00', end: '06:00' });
  assert.equal(schedulesToText(parsed), '2026-10-23,06:00,16:00\n2026-10-24,22:00,06:00');

  assert.throws(() => parseScheduleLines('2026-02-30,06:00,16:00'), /invalid calendar date/);
  assert.throws(() => parseScheduleLines('2026-10-22,24:00,16:00'), /invalid time/);
  assert.throws(() => parseScheduleLines('2026-10-22,06:00,06:00'), /different start and end/);
  assert.throws(
    () => parseScheduleLines('2026-10-22,06:00,16:00\n2026-10-22,07:00,15:00'),
    /Duplicate schedule date/
  );
  assert.throws(() => parseScheduleLines('bad line'), /line 1/);
});

test('profile form validation requires fields and catches bad dates, zones and duplicates', () => {
  assert.throws(() => profileFromForm(baseForm({ name: '  ' })), /Full name is required/);
  assert.throws(() => profileFromForm(baseForm({ address: '' })), /Work address is required/);
  assert.throws(() => profileFromForm(baseForm({ email: 'not-an-email' })), /valid email/);
  assert.throws(
    () => profileFromForm(baseForm({ contractStart: '2026-12-02', contractEnd: '2026-12-01' })),
    /end date/
  );
  assert.throws(() => profileFromForm(baseForm({ displayZone: 'Mars/Olympus' })), /display time zone/);
  assert.throws(() => profileFromForm(baseForm({ scheduleZone: 'Mars/Olympus' })), /schedule time zone/);
  assert.throws(
    () => profileFromForm(baseForm({
      schedulesText: '2026-10-22,06:00,16:00\n2026-10-22,06:00,16:00'
    })),
    /Duplicate schedule date/
  );
  assert.throws(
    () => profileFromForm(baseForm({ schedulesText: '2026-10-22,02:00,02:00' })),
    /different start and end/
  );
  assert.doesNotThrow(() => profileFromForm(baseForm({ schedulesText: '2026-10-22,22:00,02:00' })));
});

test('normalization validates field types, time zones, schedules and confirmations', () => {
  const valid = profile();
  assert.equal(valid.name, 'Test Worker');
  assert.throws(
    () => normalizeProfile({ ...valid, name: 42 }, { now: NOW }),
    (error) => error instanceof ValidationError && /must be text/.test(error.message)
  );
  assert.throws(
    () => normalizeProfile({ ...valid, displayZone: 'Bad/Zone' }, { now: NOW }),
    /supported time zone/
  );
  assert.throws(
    () => normalizeProfile({ ...valid, schedules: { '2026-02-30': { start: '06:00', end: '16:00' } } }, { now: NOW }),
    /Schedule date/
  );
  assert.throws(
    () => normalizeProfile({
      ...valid,
      confirmations: {
        '2026-10-23': { confirmedAt: NOW.toISOString(), timezone: 'Asia/Dubai' }
      }
    }, { now: NOW }),
    /same shift date/
  );
  assert.throws(
    () => normalizeProfile({
      ...valid,
      confirmations: {
        '2026-10-22': { shiftDate: '2026-10-22', confirmedAt: 'not-a-date', timezone: 'Asia/Dubai' }
      }
    }, { now: NOW }),
    /invalid timestamp/
  );
});

test('stored legacy profiles with non-standard optional values are not rejected or discarded', () => {
  const legacy = profile();
  const preserved = normalizeProfile({
    ...legacy,
    id: 'legacy profile 1',
    email: 'legacy-address-without-at-sign'
  }, { now: NOW });
  assert.equal(preserved.id, 'legacy profile 1');
  assert.equal(preserved.email, 'legacy-address-without-at-sign');
  assert.throws(
    () => profileFromForm(baseForm({ email: 'legacy-address-without-at-sign' })),
    /valid email/
  );
});

test('backup includes every profile, schedule and confirmation and round-trips', () => {
  const confirmation = {
    shiftDate: '2026-10-22',
    confirmedAt: '2026-10-22T13:01:02.000Z',
    timezone: 'Asia/Dubai',
    address: '1 Example Street'
  };
  const first = profile({ id: 'profile_one', confirmations: { '2026-10-22': confirmation } });
  const second = profile({
    id: 'profile_two',
    name: 'Second Worker',
    displayZone: 'Europe/Rome',
    scheduleZone: 'Africa/Kampala',
    schedulesText: '2026-10-25,22:00,06:00'
  });
  const backup = createBackup([first, second], NOW);
  assert.equal(backup.format, 'DKASUShiftDashboardBackup');
  assert.equal(backup.version, 2);
  assert.equal(backup.profiles.length, 2);
  const firstBackup = backup.profiles.find((item) => item.id === 'profile_one');
  assert.deepEqual(firstBackup.confirmations['2026-10-22'], confirmation);
  assert.equal(firstBackup.schedules['2026-10-22'].start, '06:00');

  const parsed = parseBackupText(JSON.stringify(backup), NOW);
  assert.equal(parsed.profiles.length, 2);
  assert.deepEqual(parsed.profiles.find((item) => item.id === 'profile_two').schedules, {
    '2026-10-25': { start: '22:00', end: '06:00' }
  });
  assert.equal(parsed.profiles.find((item) => item.id === 'profile_one').confirmations['2026-10-22'].confirmedAt, confirmation.confirmedAt);
});

test('backup creation enforces the same collection limits as restore', () => {
  const schedules = {};
  for (let index = 0; index < 2501; index += 1) {
    const date = new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10);
    schedules[date] = { start: '06:00', end: '16:00' };
  }
  const first = normalizeProfile({ ...profile({ id: 'large_one' }), schedules }, { now: NOW });
  const second = normalizeProfile({ ...profile({ id: 'large_two' }), schedules }, { now: NOW });
  assert.throws(() => createBackup([first, second], NOW), /more than 5000 scheduled shifts/);
});

test('backup parsing rejects invalid formats, duplicates and malformed records without side effects', () => {
  const valid = createBackup([profile({ id: 'profile_one' })], NOW);
  assert.throws(() => parseBackupText(JSON.stringify({ ...valid, format: 'Other' }), NOW), /not a DKASU/);
  assert.throws(() => parseBackupText(JSON.stringify({ ...valid, version: 99 }), NOW), /not supported/);
  assert.throws(() => parseBackupText(JSON.stringify({ ...valid, exportedAt: 'bad' }), NOW), /timestamp/);
  assert.throws(() => parseBackupText(JSON.stringify({ ...valid, profiles: [] }), NOW), /no profiles/i);

  const duplicate = structuredClone(valid);
  duplicate.profiles.push(structuredClone(duplicate.profiles[0]));
  assert.throws(() => parseBackupText(JSON.stringify(duplicate), NOW), /duplicate profile ID/);

  const badDate = structuredClone(valid);
  badDate.profiles[0].schedules = { '2026-02-30': { start: '06:00', end: '16:00' } };
  assert.throws(() => parseBackupText(JSON.stringify(badDate), NOW), /Schedule date/);

  const badType = structuredClone(valid);
  badType.profiles[0].name = 17;
  assert.throws(() => parseBackupText(JSON.stringify(badType), NOW), /must be text/);

  const badConfirmation = structuredClone(valid);
  badConfirmation.profiles[0].confirmations = {
    '2026-10-22': { shiftDate: '2026-10-22', confirmedAt: 'x', timezone: 'Asia/Dubai' }
  };
  assert.throws(() => parseBackupText(JSON.stringify(badConfirmation), NOW), /invalid timestamp/);
  assert.throws(() => parseBackupText('{', NOW), /valid JSON/);
  assert.throws(() => parseBackupText('', NOW), /empty/);
});

test('backup does not contain PIN material', () => {
  const backup = createBackup([profile()], NOW);
  const text = JSON.stringify(backup);
  assert.equal(text.includes('pin'), false);
  assert.equal(text.includes('salt'), false);
  assert.equal(text.includes('hash'), false);
});

test('worker profile package omits confirmations and PIN material', () => {
  const source = profile({
    id: 'worker_package_one',
    confirmations: {
      '2026-10-22': {
        shiftDate: '2026-10-22',
        confirmedAt: '2026-10-22T13:01:02.000Z',
        timezone: 'Asia/Dubai',
        address: '1 Example Street'
      }
    }
  });
  const workerPackage = createWorkerProfilePackage(source, NOW);
  assert.equal(workerPackage.format, WORKER_PACKAGE_FORMAT);
  assert.equal(workerPackage.version, WORKER_PACKAGE_VERSION);
  assert.equal(workerPackage.profile.id, source.id);
  assert.equal(workerPackage.profile.name, 'Test Worker');
  assert.equal(workerPackage.profile.swipeId, 'SW123');
  assert.equal(Object.hasOwn(workerPackage.profile, 'confirmations'), false);
  assert.deepEqual(workerPackage.profile.schedules, { '2026-10-22': { start: '06:00', end: '16:00' } });
  const text = JSON.stringify(workerPackage);
  assert.equal(text.includes('confirmations'), false);
  assert.equal(text.includes('confirmedAt'), false);
  assert.equal(text.includes('"pin"'), false);
  assert.equal(text.includes('salt'), false);

  const parsed = parseWorkerProfilePackageText(text, NOW);
  assert.equal(parsed.profile.id, source.id);
  assert.equal(parsed.profile.swipeId, 'SW123');
  assert.deepEqual(parsed.profile.confirmations, {});
});

test('worker profile package validation rejects malformed data and confirmation history', () => {
  const valid = createWorkerProfilePackage(profile({ id: 'worker_package_two' }), NOW);
  const withConfirmations = structuredClone(valid);
  withConfirmations.profile.confirmations = {
    '2026-10-22': {
      shiftDate: '2026-10-22',
      confirmedAt: '2026-10-22T13:01:02.000Z',
      timezone: 'Asia/Dubai'
    }
  };
  assert.throws(
    () => parseWorkerProfilePackageText(JSON.stringify(withConfirmations), NOW),
    /must not contain confirmation history/
  );
  const withEmptyConfirmations = structuredClone(valid);
  withEmptyConfirmations.profile.confirmations = {};
  assert.throws(
    () => parseWorkerProfilePackageText(JSON.stringify(withEmptyConfirmations), NOW),
    /must not contain confirmation history/
  );
  const withPin = structuredClone(valid);
  withPin.profile.pin = '1234';
  assert.throws(
    () => parseWorkerProfilePackageText(JSON.stringify(withPin), NOW),
    /unsupported field "pin"/
  );
  const withExtraTopLevel = structuredClone(valid);
  withExtraTopLevel.pinHash = 'secret';
  assert.throws(
    () => parseWorkerProfilePackageText(JSON.stringify(withExtraTopLevel), NOW),
    /unsupported field "pinHash"/
  );
  assert.throws(
    () => parseWorkerProfilePackageText(JSON.stringify({ ...valid, format: BACKUP_FORMAT }), NOW),
    /not a supported DKASU worker profile package/
  );
  assert.throws(
    () => parseWorkerProfilePackageText(JSON.stringify({ ...valid, version: 99 }), NOW),
    /not a supported/
  );
  assert.throws(
    () => parseWorkerProfilePackageText(JSON.stringify({ ...valid, exportedAt: 'bad' }), NOW),
    /timestamp/
  );
  const badProfile = structuredClone(valid);
  badProfile.profile.name = 42;
  assert.throws(() => parseWorkerProfilePackageText(JSON.stringify(badProfile), NOW), /must be text/);
  assert.throws(() => parseWorkerProfilePackageText('{', NOW), /not valid JSON/);
  assert.throws(() => parseWorkerProfilePackageText('', NOW), /empty/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addDaysToDateKey,
  dateKeyInZone,
  formatClock,
  getContractBounds,
  getShiftBounds,
  isValidDateKey,
  isValidTime,
  zonedDateKeyTime,
  zonedDateTime
} from '../www/time.js';

test('date and time validation rejects impossible values', () => {
  assert.equal(isValidDateKey('2026-10-22'), true);
  assert.equal(isValidDateKey('2026-02-30'), false);
  assert.equal(isValidDateKey('2026-13-01'), false);
  assert.equal(isValidDateKey('22-10-2026'), false);
  assert.equal(isValidDateKey('2026-1-02'), false);
  assert.equal(isValidTime('00:00'), true);
  assert.equal(isValidTime('23:59'), true);
  assert.equal(isValidTime('24:00'), false);
  assert.equal(isValidTime('12:60'), false);
  assert.equal(addDaysToDateKey('2026-12-31', 1), '2027-01-01');
});

test('Dubai schedule times convert correctly to Uganda and Italy before DST ends', () => {
  const start = zonedDateKeyTime('2026-10-22', '06:00', 'Asia/Dubai');
  const end = zonedDateKeyTime('2026-10-22', '16:00', 'Asia/Dubai');
  assert.equal(start.toISOString(), '2026-10-22T02:00:00.000Z');
  assert.equal(end.toISOString(), '2026-10-22T12:00:00.000Z');
  assert.equal(formatClock(start, 'Europe/Rome', false), '04:00');
  assert.equal(formatClock(end, 'Europe/Rome', false), '14:00');
  assert.equal(formatClock(start, 'Africa/Kampala', false), '05:00');
  assert.equal(formatClock(end, 'Africa/Kampala', false), '15:00');
});

test('Italy daylight-saving change alters the displayed shift start', () => {
  const before = zonedDateKeyTime('2026-10-22', '06:00', 'Asia/Dubai');
  const after = zonedDateKeyTime('2026-10-26', '06:00', 'Asia/Dubai');
  assert.equal(formatClock(before, 'Europe/Rome', false), '04:00');
  assert.equal(formatClock(after, 'Europe/Rome', false), '03:00');
  assert.equal(dateKeyInZone(before, 'Europe/Rome'), '2026-10-22');
});

test('summer and winter wall-clock conversion includes DST offsets', () => {
  const summer = zonedDateTime(2026, 7, 1, 6, 0, 0, 'Europe/Rome');
  const winter = zonedDateTime(2026, 12, 1, 6, 0, 0, 'Europe/Rome');
  assert.equal(summer.toISOString(), '2026-07-01T04:00:00.000Z');
  assert.equal(winter.toISOString(), '2026-12-01T05:00:00.000Z');
});

test('overnight shifts end on the next local date', () => {
  const bounds = getShiftBounds('2026-10-22', { start: '22:00', end: '02:00' }, 'Asia/Dubai');
  assert.equal(bounds.overnight, true);
  assert.equal(bounds.endDateKey, '2026-10-23');
  assert.equal(bounds.start.toISOString(), '2026-10-22T18:00:00.000Z');
  assert.equal(bounds.end.toISOString(), '2026-10-22T22:00:00.000Z');
  assert.equal(bounds.end - bounds.start, 4 * 60 * 60 * 1000);
});

test('equal shift start and end is invalid', () => {
  assert.throws(
    () => getShiftBounds('2026-10-22', { start: '06:00', end: '06:00' }, 'Asia/Dubai'),
    /must differ/
  );
});

test('contract end date is inclusive and ends at next Dubai midnight', () => {
  const bounds = getContractBounds('2026-10-15', '2026-12-15', 'Asia/Dubai');
  assert.equal(bounds.start.toISOString(), '2026-10-14T20:00:00.000Z');
  assert.equal(bounds.endExclusive.toISOString(), '2026-12-15T20:00:00.000Z');
});

test('invalid zones are rejected instead of silently using a default', () => {
  assert.throws(() => zonedDateTime(2026, 1, 1, 0, 0, 0, 'Mars/Olympus'), /Unsupported/);
  assert.throws(() => formatClock(new Date(), 'Mars/Olympus'), /Unsupported/);
});

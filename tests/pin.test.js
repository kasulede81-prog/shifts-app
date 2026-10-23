import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PIN_ITERATIONS,
  PIN_LOCK_DELAYS_MS,
  PIN_MAX_FAILURES,
  PinRecordError,
  PinValidationError,
  createPinRecord,
  emptyPinGuard,
  getLockRemainingMs,
  isValidPin,
  parsePinGuard,
  parsePinRecord,
  registerPinFailure,
  registerPinSuccess,
  serializePinRecord,
  sha256Hex,
  validatePinSetup,
  verifyLegacySha256Pin,
  verifyPin
} from '../www/pin.js';

const TEST_ITERATIONS = 1000;

test('PIN format and setup confirmation are validated', () => {
  assert.equal(isValidPin('1234'), true);
  assert.equal(isValidPin('000000000000'), true);
  assert.equal(isValidPin('123'), false);
  assert.equal(isValidPin('1234567890123'), false);
  assert.equal(isValidPin('12a4'), false);
  assert.doesNotThrow(() => validatePinSetup('1234', '1234'));
  assert.throws(() => validatePinSetup('1234', '4321'), PinValidationError);
  assert.throws(() => validatePinSetup('12', '12'), /4–12/);
});

test('PIN record uses salted PBKDF2, never stores plaintext, and verifies correctly', async () => {
  const pin = '246810121416';
  const first = await createPinRecord(pin, { iterations: TEST_ITERATIONS });
  const second = await createPinRecord(pin, { iterations: TEST_ITERATIONS });
  assert.equal(first.algorithm, 'PBKDF2-SHA-256');
  assert.equal(first.iterations, TEST_ITERATIONS);
  assert.match(first.salt, /^[0-9a-f]{32}$/);
  assert.match(first.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, second.hash);
  assert.equal(Object.hasOwn(first, 'pin'), false);
  assert.equal(serializePinRecord(first).includes(pin), false);
  assert.equal(await verifyPin(pin, first), true);
  assert.equal(await verifyPin('246810121417', first), false);
  assert.equal(await verifyPin(pin, second), true);
  assert.equal(PIN_ITERATIONS, 310_000);
});

test('malformed PIN records are rejected instead of treated as valid', () => {
  assert.throws(() => parsePinRecord('not json'), PinRecordError);
  assert.throws(() => parsePinRecord(JSON.stringify({ version: 1 })), PinRecordError);
  assert.throws(() => parsePinRecord(JSON.stringify({
    version: 1,
    algorithm: 'SHA-256',
    iterations: 1,
    salt: '00',
    hash: '00'
  })), PinRecordError);
  assert.throws(() => parsePinRecord(JSON.stringify({
    version: 1,
    algorithm: 'PBKDF2-SHA-256',
    iterations: 1000,
    salt: 'zzzz',
    hash: '00'
  })), PinRecordError);
});

test('failed attempts produce a temporary escalating lockout', () => {
  let guard = emptyPinGuard();
  const now = Date.UTC(2026, 9, 22, 8, 0, 0);
  for (let attempt = 1; attempt < PIN_MAX_FAILURES; attempt += 1) {
    guard = registerPinFailure(guard, now);
    assert.equal(getLockRemainingMs(guard, now), 0);
  }
  guard = registerPinFailure(guard, now);
  assert.equal(getLockRemainingMs(guard, now), PIN_LOCK_DELAYS_MS[0]);
  assert.equal(guard.failedAttempts, 0);
  assert.equal(guard.lockouts, 1);

  const afterExpiry = registerPinFailure(guard, now + PIN_LOCK_DELAYS_MS[0] + 1);
  assert.equal(afterExpiry.lockedUntil, 0);
  let secondGuard = afterExpiry;
  for (let attempt = 1; attempt < PIN_MAX_FAILURES; attempt += 1) {
    secondGuard = registerPinFailure(secondGuard, now + 40000);
  }
  assert.equal(getLockRemainingMs(secondGuard, now + 40000), PIN_LOCK_DELAYS_MS[1]);
});

test('lockout state is persistent-format safe and cannot lock forever when corrupt', () => {
  const parsed = parsePinGuard(JSON.stringify({
    failedAttempts: 2,
    lockedUntil: 123,
    lockouts: 1
  }));
  assert.equal(parsed.failedAttempts, 2);
  assert.equal(parsePinGuard('bad json').failedAttempts, 0);
  const now = Date.now();
  assert.equal(getLockRemainingMs({ failedAttempts: 0, lockedUntil: now + 99999999, lockouts: 2 }, now), 0);
  assert.equal(getLockRemainingMs({ failedAttempts: 0, lockedUntil: now + 1000, lockouts: 0 }, now), 1000);
  assert.equal(getLockRemainingMs(registerPinSuccess(), now), 0);
});

test('legacy unsalted SHA-256 records can be verified only for migration', async () => {
  const legacy = await sha256Hex('13579');
  assert.match(legacy, /^[0-9a-f]{64}$/);
  assert.equal(await verifyLegacySha256Pin('13579', legacy), true);
  assert.equal(await verifyLegacySha256Pin('13570', legacy), false);
  assert.equal(await verifyLegacySha256Pin('13579', 'not-a-hash'), false);
});

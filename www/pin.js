export const PIN_RECORD_VERSION = 1;
export const PIN_ALGORITHM = 'PBKDF2-SHA-256';
export const PIN_ITERATIONS = 310_000;
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 12;
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_DELAYS_MS = Object.freeze([30_000, 60_000, 120_000, 300_000]);
export const PIN_MAX_LOCK_MS = PIN_LOCK_DELAYS_MS[PIN_LOCK_DELAYS_MS.length - 1];

const PIN_PATTERN = /^\d{4,12}$/;
const HEX_PATTERN = /^[0-9a-f]+$/;

export class PinRecordError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PinRecordError';
  }
}

export class PinValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PinValidationError';
  }
}

export function isValidPin(pin) {
  return typeof pin === 'string' && PIN_PATTERN.test(pin);
}

export function validatePinSetup(pin, confirmation) {
  if (!isValidPin(pin)) {
    throw new PinValidationError(`Use ${PIN_MIN_LENGTH}–${PIN_MAX_LENGTH} digits.`);
  }
  if (pin !== confirmation) {
    throw new PinValidationError('PINs do not match.');
  }
}

function requireSubtleCrypto() {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Secure hashing is unavailable in this WebView. The app cannot create or verify a PIN.');
  }
  return globalThis.crypto.subtle;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function timingSafeEqualHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (left.length !== right.length || !HEX_PATTERN.test(left) || !HEX_PATTERN.test(right)) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function deriveHash(pin, saltHex, iterations) {
  const subtle = requireSubtleCrypto();
  const key = await subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: hexToBytes(saltHex),
      iterations,
      hash: 'SHA-256'
    },
    key,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

export async function createPinRecord(pin, { iterations = PIN_ITERATIONS } = {}) {
  if (!isValidPin(pin)) throw new PinValidationError('PIN must contain 4–12 digits.');
  if (!Number.isInteger(iterations) || iterations < 1_000 || iterations > 2_000_000) {
    throw new PinValidationError('Unsupported PIN hash iteration count.');
  }
  const salt = new Uint8Array(16);
  globalThis.crypto.getRandomValues(salt);
  const saltHex = bytesToHex(salt);
  const hash = await deriveHash(pin, saltHex, iterations);
  return {
    version: PIN_RECORD_VERSION,
    algorithm: PIN_ALGORITHM,
    iterations,
    salt: saltHex,
    hash
  };
}

export function serializePinRecord(record) {
  assertValidPinRecord(record);
  return JSON.stringify(record);
}

export function parsePinRecord(raw) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new PinRecordError('The saved PIN record is not valid JSON.');
  }
  assertValidPinRecord(parsed);
  return parsed;
}

function assertValidPinRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new PinRecordError('The saved PIN record is malformed.');
  }
  if (record.version !== PIN_RECORD_VERSION || record.algorithm !== PIN_ALGORITHM) {
    throw new PinRecordError('The saved PIN record uses an unsupported format.');
  }
  if (!Number.isInteger(record.iterations)
    || record.iterations < 1_000
    || record.iterations > 2_000_000) {
    throw new PinRecordError('The saved PIN record has an invalid iteration count.');
  }
  if (typeof record.salt !== 'string' || record.salt.length !== 32 || !HEX_PATTERN.test(record.salt)) {
    throw new PinRecordError('The saved PIN record has an invalid salt.');
  }
  if (typeof record.hash !== 'string' || record.hash.length !== 64 || !HEX_PATTERN.test(record.hash)) {
    throw new PinRecordError('The saved PIN record has an invalid hash.');
  }
}

export async function verifyPin(pin, record) {
  if (!isValidPin(pin)) return false;
  assertValidPinRecord(record);
  const derived = await deriveHash(pin, record.salt, record.iterations);
  return timingSafeEqualHex(derived, record.hash);
}

export async function sha256Hex(value) {
  const subtle = requireSubtleCrypto();
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return bytesToHex(new Uint8Array(digest));
}

export async function verifyLegacySha256Pin(pin, expectedHash) {
  if (!isValidPin(pin) || typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
    return false;
  }
  const actual = await sha256Hex(pin);
  return timingSafeEqualHex(actual, expectedHash.toLowerCase());
}

export function emptyPinGuard() {
  return { failedAttempts: 0, lockedUntil: 0, lockouts: 0 };
}

export function parsePinGuard(raw) {
  if (typeof raw !== 'string' || !raw) return emptyPinGuard();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyPinGuard();
    const failedAttempts = Number.isInteger(parsed.failedAttempts) ? Math.max(0, Math.min(parsed.failedAttempts, 999)) : 0;
    const lockedUntil = Number.isFinite(parsed.lockedUntil) ? Math.max(0, parsed.lockedUntil) : 0;
    const lockouts = Number.isInteger(parsed.lockouts) ? Math.max(0, Math.min(parsed.lockouts, 20)) : 0;
    return { failedAttempts, lockedUntil, lockouts };
  } catch {
    return emptyPinGuard();
  }
}

export function getLockRemainingMs(guard, now = Date.now()) {
  const parsed = parsePinGuard(typeof guard === 'string' ? guard : JSON.stringify(guard || emptyPinGuard()));
  const remaining = parsed.lockedUntil - now;
  if (remaining <= 0) return 0;
  // A valid lockout is never longer than the maximum delay. A far-future
  // timestamp indicates damaged/tampered data and must not lock the app forever.
  if (remaining > PIN_MAX_LOCK_MS + 1000) return 0;
  return remaining;
}

export function registerPinFailure(guard, now = Date.now()) {
  const current = parsePinGuard(typeof guard === 'string' ? guard : JSON.stringify(guard || emptyPinGuard()));
  const failedAttempts = current.failedAttempts + 1;
  if (failedAttempts < PIN_MAX_FAILURES) {
    return { ...current, failedAttempts, lockedUntil: 0 };
  }
  const delayIndex = Math.min(current.lockouts, PIN_LOCK_DELAYS_MS.length - 1);
  return {
    failedAttempts: 0,
    lockedUntil: now + PIN_LOCK_DELAYS_MS[delayIndex],
    lockouts: Math.min(current.lockouts + 1, 20)
  };
}

export function registerPinSuccess() {
  return emptyPinGuard();
}

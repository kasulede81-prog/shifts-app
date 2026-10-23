export const TZ = Object.freeze({
  uganda: 'Africa/Kampala',
  dubai: 'Asia/Dubai',
  italy: 'Europe/Rome'
});

export const TIME_ZONE_OPTIONS = Object.freeze([TZ.dubai, TZ.uganda, TZ.italy]);

export const TIME_ZONE_NAMES = Object.freeze({
  [TZ.dubai]: 'Dubai',
  [TZ.uganda]: 'Uganda',
  [TZ.italy]: 'Italy / Europe'
});

const formatterCache = new Map();
const clockFormatterCache = new Map();
const dateFormatterCache = new Map();

export function isSupportedTimeZone(zone) {
  return TIME_ZONE_OPTIONS.includes(zone);
}

export function isValidDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1900 || year > 2200) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

export function isValidTime(value) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(':').map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

export function addDaysToDateKey(dateKey, days) {
  if (!isValidDateKey(dateKey) || !Number.isInteger(days)) throw new RangeError('Invalid date key');
  const [year, month, day] = dateKey.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, '0'),
    String(shifted.getUTCDate()).padStart(2, '0')
  ].join('-');
}

function getPartsFormatter(zone) {
  if (!formatterCache.has(zone)) {
    formatterCache.set(zone, new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }));
  }
  return formatterCache.get(zone);
}

export function partsInZone(date, zone) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new TypeError('Invalid date');
  if (!isSupportedTimeZone(zone)) throw new RangeError('Unsupported time zone');
  const parts = getPartsFormatter(zone).formatToParts(date);
  const result = {};
  for (const part of parts) {
    if (part.type !== 'literal') result[part.type] = part.value;
  }
  return result;
}

export function dateKeyInZone(date, zone) {
  const parts = partsInZone(date, zone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Convert a wall-clock time in an IANA zone to the corresponding instant.
 * Iteration accounts for the zone offset on that date, including DST changes.
 */
export function zonedDateTime(year, month, day, hour = 0, minute = 0, second = 0, zone = TZ.dubai) {
  if (!isSupportedTimeZone(zone)) throw new RangeError('Unsupported time zone');
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = target;
  for (let index = 0; index < 5; index += 1) {
    const parts = partsInZone(new Date(guess), zone);
    const represented = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    const correction = target - represented;
    guess += correction;
    if (correction === 0) break;
  }
  return new Date(guess);
}

export function zonedDateKeyTime(dateKey, time, zone) {
  if (!isValidDateKey(dateKey)) throw new RangeError('Invalid date key');
  if (!isValidTime(time)) throw new RangeError('Invalid time');
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return zonedDateTime(year, month, day, hour, minute, 0, zone);
}

/**
 * A shift ending earlier than it starts (for example 22:00 to 06:00) ends on
 * the following local date. Equal start/end times are rejected by validation.
 */
export function getShiftBounds(dateKey, schedule, zone) {
  if (!isValidDateKey(dateKey)) throw new RangeError('Invalid shift date');
  if (!schedule || !isValidTime(schedule.start) || !isValidTime(schedule.end)) {
    throw new RangeError('Invalid shift time');
  }
  if (schedule.start === schedule.end) throw new RangeError('Shift start and end times must differ');
  const endDateKey = schedule.end < schedule.start ? addDaysToDateKey(dateKey, 1) : dateKey;
  return {
    start: zonedDateKeyTime(dateKey, schedule.start, zone),
    end: zonedDateKeyTime(endDateKey, schedule.end, zone),
    startDateKey: dateKey,
    endDateKey,
    overnight: endDateKey !== dateKey
  };
}

export function getContractBounds(startDateKey, endDateKey, zone) {
  if (!isValidDateKey(startDateKey) || !isValidDateKey(endDateKey)) {
    throw new RangeError('Invalid contract date');
  }
  const endExclusiveKey = addDaysToDateKey(endDateKey, 1);
  return {
    start: zonedDateKeyTime(startDateKey, '00:00', zone),
    endExclusive: zonedDateKeyTime(endExclusiveKey, '00:00', zone)
  };
}

export function formatClock(date, zone, withSeconds = true) {
  if (!isSupportedTimeZone(zone)) throw new RangeError('Unsupported time zone');
  const cacheKey = `${zone}:${withSeconds ? 'seconds' : 'minutes'}`;
  if (!clockFormatterCache.has(cacheKey)) {
    clockFormatterCache.set(cacheKey, new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      ...(withSeconds ? { second: '2-digit' } : {}),
      hourCycle: 'h23'
    }));
  }
  return clockFormatterCache.get(cacheKey).format(date);
}

export function formatDate(date, zone) {
  if (!isSupportedTimeZone(zone)) throw new RangeError('Unsupported time zone');
  if (!dateFormatterCache.has(zone)) {
    dateFormatterCache.set(zone, new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    }));
  }
  return dateFormatterCache.get(zone).format(date);
}

export function formatDateTime(date, zone) {
  if (!isSupportedTimeZone(zone)) throw new RangeError('Unsupported time zone');
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    dateStyle: 'medium',
    timeStyle: 'medium'
  }).format(date);
}

export function formatDuration(ms) {
  let seconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

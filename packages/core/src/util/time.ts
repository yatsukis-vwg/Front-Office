/**
 * Timezone helpers.
 *
 * Everything is stored in UTC. The clinic knowledge base expresses working
 * hours in the clinic's local wall clock, so we need to convert both ways.
 * Node ships full ICU, so we derive the offset from Intl rather than hardcoding
 * +03:00 — that keeps the code correct if a clinic in a DST zone is onboarded.
 */

const PARTS_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = PARTS_FORMATTER_CACHE.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    PARTS_FORMATTER_CACHE.set(timeZone, formatter);
  }
  return formatter;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday, matching the KB's `weekday` keys. */
  weekday: number;
}

export function toZonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(date);
  const pick = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  const hour = pick('hour') % 24;
  const minute = pick('minute');
  const second = pick('second');
  // Day-of-week is derived from the zoned calendar date, not the UTC one.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, hour, minute, second, weekday };
}

/** Offset in minutes that `timeZone` is ahead of UTC at the given instant. */
export function zoneOffsetMinutes(date: Date, timeZone: string): number {
  const p = toZonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** Converts a wall-clock time in `timeZone` to the corresponding UTC instant. */
export function zonedToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Two passes settle the offset even across a DST transition.
  let guess = new Date(naive);
  for (let i = 0; i < 2; i++) {
    guess = new Date(naive - zoneOffsetMinutes(guess, timeZone) * 60000);
  }
  return guess;
}

/** `YYYY-MM-DD` in the clinic's timezone. */
export function zonedDateKey(date: Date, timeZone: string): string {
  const p = toZonedParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** `HH:MM` in the clinic's timezone. */
export function zonedTimeKey(date: Date, timeZone: string): string {
  const p = toZonedParts(date, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export function parseDateKey(key: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim());
  if (!match) throw new Error(`Expected a date in YYYY-MM-DD format, got "${key}"`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** Minutes since midnight for an `HH:MM` string. */
export function parseClock(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`Expected a time in HH:MM format, got "${value}"`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59) throw new Error(`"${value}" is not a valid time of day`);
  return hours * 60 + minutes;
}

export function formatClock(minutesFromMidnight: number): string {
  const h = Math.floor(minutesFromMidnight / 60) % 24;
  const m = minutesFromMidnight % 60;
  return `${pad(h)}:${pad(m)}`;
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60000);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400000);
}

export function nowIso(): string {
  return new Date().toISOString();
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

const AR_WEEKDAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const EN_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Human-readable slot label for the agent to read back to the patient, e.g.
 * "الثلاثاء ٩ سبتمبر الساعة ٤:٣٠ العصر". Kept out of the model's hands so the
 * date it confirms always matches the date it booked.
 */
export function describeSlot(date: Date, timeZone: string, locale: 'ar' | 'en'): string {
  const p = toZonedParts(date, timeZone);
  const day = locale === 'ar' ? AR_WEEKDAYS[p.weekday] : EN_WEEKDAYS[p.weekday];
  const monthName = new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', {
    timeZone,
    month: 'long',
  }).format(date);
  if (locale === 'ar') {
    const period = p.hour < 12 ? 'صباحًا' : p.hour < 16 ? 'ظهرًا' : p.hour < 19 ? 'العصر' : 'مساءً';
    const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
    return `${day} ${p.day} ${monthName} الساعة ${hour12}:${pad(p.minute)} ${period}`;
  }
  const period = p.hour < 12 ? 'AM' : 'PM';
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${day} ${p.day} ${monthName}, ${hour12}:${pad(p.minute)} ${period}`;
}

// Repeat rules, evaluated in the configured time zone so "every day at 9:00" stays 9:00 across DST.
import { DateTime } from 'luxon';

export const REPEATS = ['none', 'daily', 'weekly', 'monthly'];

export function nextOccurrence(sendAt, repeat, repeatDay, zone) {
  const dt = DateTime.fromMillis(sendAt, { zone });
  switch (repeat) {
    case 'daily':
      return dt.plus({ days: 1 }).toMillis();
    case 'weekly':
      return dt.plus({ weeks: 1 }).toMillis();
    case 'monthly': {
      // Keep the original day of month, clamped: Jan 31 -> Feb 28 -> Mar 31.
      const next = dt.plus({ months: 1 });
      return next.set({ day: Math.min(repeatDay || dt.day, next.daysInMonth) }).toMillis();
    }
    default:
      return null;
  }
}

// First occurrence strictly after `after` (skips any that were missed while offline).
export function nextFutureOccurrence(sendAt, repeat, repeatDay, zone, after) {
  let at = nextOccurrence(sendAt, repeat, repeatDay, zone);
  while (at !== null && at <= after) at = nextOccurrence(at, repeat, repeatDay, zone);
  return at;
}

export function dayOfMonth(sendAt, zone) {
  return DateTime.fromMillis(sendAt, { zone }).day;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { nextOccurrence, nextFutureOccurrence } from '../src/recurrence.js';

const at = (iso, zone) => DateTime.fromISO(iso, { zone }).toMillis();
const show = (ms, zone) => DateTime.fromMillis(ms, { zone }).toFormat("yyyy-MM-dd'T'HH:mm");

test('daily and weekly keep the wall-clock time', () => {
  const z = 'Asia/Riyadh';
  assert.equal(show(nextOccurrence(at('2026-10-24T09:00', z), 'daily', null, z), z), '2026-10-25T09:00');
  assert.equal(show(nextOccurrence(at('2026-10-24T09:00', z), 'weekly', null, z), z), '2026-10-31T09:00');
});

test('daily repeat stays at 09:00 across a DST change', () => {
  const z = 'America/New_York'; // DST ends 2026-11-01
  const next = nextOccurrence(at('2026-10-31T09:00', z), 'daily', null, z);
  assert.equal(show(next, z), '2026-11-01T09:00');
  assert.equal(next - at('2026-10-31T09:00', z), 25 * 3600_000);
});

test('monthly on the 31st clamps to short months and returns to the 31st', () => {
  const z = 'Asia/Riyadh';
  const feb = nextOccurrence(at('2027-01-31T09:00', z), 'monthly', 31, z);
  assert.equal(show(feb, z), '2027-02-28T09:00');
  const mar = nextOccurrence(feb, 'monthly', 31, z);
  assert.equal(show(mar, z), '2027-03-31T09:00');
});

test('none does not repeat', () => {
  assert.equal(nextOccurrence(Date.now(), 'none', null, 'UTC'), null);
});

test('nextFutureOccurrence skips occurrences missed while offline', () => {
  const z = 'UTC';
  const start = at('2026-10-01T09:00', z);
  const now = at('2026-10-05T12:00', z);
  assert.equal(show(nextFutureOccurrence(start, 'daily', null, z, now), z), '2026-10-06T09:00');
});

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { Scheduler, PermanentError } from '../src/scheduler.js';
import { FakeClock, FakeSender, silentLogger, testConfig } from './helpers.js';

const MIN = 60_000;
let clock, db, sender, scheduler, alerts;

function setup(configOverrides = {}) {
  clock = new FakeClock();
  db = openDb(':memory:', { now: clock.now });
  sender = new FakeSender();
  alerts = [];
  scheduler = new Scheduler({
    db,
    sender,
    config: testConfig(configOverrides),
    logger: silentLogger,
    alert: async (key) => alerts.push(key),
    now: clock.now,
    sleep: async () => {},
  });
}

const schedule = (fields = {}) =>
  db.messages.create({ to: '966500000000@s.whatsapp.net', toName: 'Ali', body: 'hi', sendAt: clock.now(), ...fields });

beforeEach(() => setup());

test('sends a due message once and records its WhatsApp id', async () => {
  const m = schedule();
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(sender.sent.length, 1);
  const after = db.messages.get(m.id);
  assert.equal(after.status, 'sent');
  assert.equal(after.waId, 'MSG1');
  assert.equal(after.ack, 1);
});

test('does not send messages scheduled in the future', async () => {
  schedule({ sendAt: clock.now() + 10 * MIN });
  await scheduler.tick();
  assert.equal(sender.sent.length, 0);
});

test('does nothing while WhatsApp is disconnected', async () => {
  schedule();
  sender.state.status = 'disconnected';
  await scheduler.tick();
  assert.equal(sender.sent.length, 0);
});

test('concurrent ticks never double-send', async () => {
  schedule();
  await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()]);
  assert.equal(sender.sent.length, 1);
});

test('a claimed message cannot be claimed again', () => {
  const m = schedule();
  assert.equal(db.messages.claim(m.id), true);
  assert.equal(db.messages.claim(m.id), false);
});

test('marks a message missed when it is later than the grace period', async () => {
  const m = schedule({ sendAt: clock.now() - 2 * 60 * MIN });
  await scheduler.tick();
  assert.equal(sender.sent.length, 0);
  assert.equal(db.messages.get(m.id).status, 'missed');
  assert.deepEqual(alerts, ['missed']);
});

test('still sends a message that is late but within the grace period', async () => {
  schedule({ sendAt: clock.now() - 30 * MIN });
  await scheduler.tick();
  assert.equal(sender.sent.length, 1);
});

test('retries with backoff, then fails permanently and alerts', async () => {
  const m = schedule();
  sender.failWith = new Error('socket closed');

  await scheduler.tick();
  let row = db.messages.get(m.id);
  assert.equal(row.status, 'pending');
  assert.equal(row.retryAt, clock.now() + 1 * MIN);

  await scheduler.tick(); // not yet time to retry
  assert.equal(db.messages.get(m.id).attempts, 1);

  clock.advance(1 * MIN);
  await scheduler.tick();
  row = db.messages.get(m.id);
  assert.equal(row.attempts, 2);
  assert.equal(row.retryAt, clock.now() + 5 * MIN);

  clock.advance(5 * MIN);
  await scheduler.tick();
  row = db.messages.get(m.id);
  assert.equal(row.status, 'failed');
  assert.equal(row.error, 'socket closed');
  assert.equal(alerts.length, 1);
});

test('a retry that succeeds ends up sent', async () => {
  const m = schedule();
  sender.failWith = new Error('timeout');
  await scheduler.tick();
  sender.failWith = null;
  clock.advance(MIN);
  await scheduler.tick();
  assert.equal(db.messages.get(m.id).status, 'sent');
});

test('permanent errors are not retried', async () => {
  const m = schedule();
  sender.failWith = new PermanentError('not on WhatsApp');
  await scheduler.tick();
  assert.equal(db.messages.get(m.id).status, 'failed');
});

test('a repeating message queues exactly one next occurrence', async () => {
  const m = schedule({ repeat: 'daily' });
  await scheduler.tick();
  scheduler.spawnNext(db.messages.get(m.id)); // second call must be a no-op
  const upcoming = db.messages.upcoming();
  assert.equal(upcoming.length, 1);
  assert.equal(upcoming[0].sendAt, m.sendAt + 24 * 60 * MIN);
  assert.equal(upcoming[0].seriesId, m.id);
});

test('a missed repeating message still schedules the next one', async () => {
  schedule({ repeat: 'weekly', sendAt: clock.now() - 3 * 60 * MIN });
  await scheduler.tick();
  assert.equal(db.messages.upcoming().length, 1);
});

test('crash recovery: unconfirmed in-flight sends become failed, never resent', async () => {
  const m = schedule();
  db.messages.claim(m.id); // simulate a crash mid-send
  scheduler.recoverInterrupted();
  assert.equal(db.messages.get(m.id).status, 'failed');
  await scheduler.tick();
  assert.equal(sender.sent.length, 0);
});

test('crash recovery: in-flight sends WhatsApp acknowledged become sent', () => {
  const m = schedule();
  db.messages.claim(m.id);
  db.messages.update(m.id, { waId: 'X1' });
  db.messages.setAck('X1', 2);
  scheduler.recoverInterrupted();
  assert.equal(db.messages.get(m.id).status, 'sent');
});

test('delivery receipts only move forward', () => {
  const m = schedule();
  db.messages.update(m.id, { waId: 'X2' });
  db.messages.setAck('X2', 4);
  db.messages.setAck('X2', 3);
  assert.equal(db.messages.get(m.id).ack, 4);
});

test('daily limit holds remaining messages', async () => {
  setup({ dailyLimit: 2 });
  schedule();
  schedule();
  schedule();
  await scheduler.tick();
  assert.equal(sender.sent.length, 2);
  assert.equal(db.messages.upcoming().length, 1);
  assert.deepEqual(alerts, ['limit']);
});

test('send now works for failed messages and does not auto-retry', async () => {
  const m = schedule();
  sender.failWith = new PermanentError('boom');
  await scheduler.tick();
  sender.failWith = null;
  const after = await scheduler.sendNow(m.id);
  assert.equal(after.status, 'sent');
});

test('send now refuses messages already sent', async () => {
  const m = schedule();
  await scheduler.tick();
  await assert.rejects(scheduler.sendNow(m.id), /already sent/);
});

test('cancelled messages are never sent', async () => {
  const m = schedule();
  db.messages.update(m.id, { status: 'cancelled' });
  await scheduler.tick();
  assert.equal(sender.sent.length, 0);
});

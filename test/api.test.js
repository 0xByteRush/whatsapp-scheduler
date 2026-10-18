import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { Scheduler } from '../src/scheduler.js';
import { createApp } from '../src/server.js';
import { FakeSender, silentLogger, testConfig } from './helpers.js';

const PASSWORD = 'correct horse battery';

function start(configOverrides) {
  const config = testConfig(configOverrides);
  const db = openDb(':memory:');
  const sender = new FakeSender();
  const scheduler = new Scheduler({ db, sender, config, logger: silentLogger, sleep: async () => {} });
  const app = createApp({ config, db, sender, scheduler, logger: silentLogger });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const base = `http://localhost:${server.address().port}`;
      resolve({ server, base, db, sender });
    });
  });
}

const json = (body, extra = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...extra },
  body: JSON.stringify(body),
});

let open, locked;
before(async () => {
  open = await start();
  locked = await start({ adminPassword: PASSWORD });
});
after(() => {
  open.server.close();
  locked.server.close();
});

test('health check is public', async () => {
  const res = await fetch(`${locked.base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

// fetch() won't let us override Host, so use a raw request.
const statusWithHost = (base, host) =>
  new Promise((resolve, reject) => {
    const { port } = new URL(base);
    http.get({ host: '127.0.0.1', port, path: '/api/status', headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });

test('rejects unknown Host headers (DNS rebinding)', async () => {
  assert.equal(await statusWithHost(open.base, 'evil.example'), 403);
  assert.equal(await statusWithHost(open.base, 'localhost:1234'), 200);
});

test('bodiless cross-site POSTs are refused (CSRF)', async () => {
  const res = await fetch(`${open.base}/api/whatsapp/logout`, { method: 'POST' });
  assert.equal(res.status, 415);
});

test('sets security headers', async () => {
  const res = await fetch(`${open.base}/`);
  assert.ok(res.headers.get('content-security-policy'));
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('API requires sign-in when a password is set', async () => {
  const res = await fetch(`${locked.base}/api/messages`);
  assert.equal(res.status, 401);
});

test('wrong password is rejected, right password signs in', async () => {
  let res = await fetch(`${locked.base}/api/login`, json({ password: 'nope' }));
  assert.equal(res.status, 401);

  res = await fetch(`${locked.base}/api/login`, json({ password: PASSWORD }));
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  res = await fetch(`${locked.base}/api/messages`, { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(res.status, 200);
});

test('a tampered session cookie is rejected', async () => {
  const res = await fetch(`${locked.base}/api/messages`, {
    headers: { Cookie: `wa_session=${Date.now() + 1e9}.${'0'.repeat(64)}` },
  });
  assert.equal(res.status, 401);
});

test('non-JSON state changes are refused (CSRF)', async () => {
  const res = await fetch(`${open.base}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'to=1&body=x',
  });
  assert.equal(res.status, 415);
});

test('creates, lists, edits and cancels a message', async () => {
  const sendAt = new Date(Date.now() + 3600_000).toISOString();
  let res = await fetch(`${open.base}/api/messages`, json({ to: '+966 50 000 0000', body: 'Hello', sendAt, repeat: 'monthly' }));
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.equal(created.to, '966500000000@s.whatsapp.net');
  assert.equal(created.status, 'pending');

  res = await fetch(`${open.base}/api/messages/${created.id}`, { ...json({ to: created.to, body: 'Edited', sendAt }), method: 'PUT' });
  assert.equal((await res.json()).body, 'Edited');

  const list = await (await fetch(`${open.base}/api/messages`)).json();
  assert.equal(list.length, 1);

  res = await fetch(`${open.base}/api/messages/${created.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
  assert.equal(res.status, 200);
  const history = await (await fetch(`${open.base}/api/messages?view=history`)).json();
  assert.equal(history[0].status, 'cancelled');
});

test('validates input', async () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  const cases = [
    [{ body: 'x', sendAt: future }, /Pick a chat/],
    [{ to: '+966500000000', body: '  ', sendAt: future }, /empty/],
    [{ to: '+966500000000', body: 'x', sendAt: '2020-01-01T00:00:00Z' }, /past/],
    [{ to: '+966500000000', body: 'x', sendAt: 'tomorrow' }, /Invalid date/],
    [{ to: '+966500000000', body: 'x'.repeat(5000), sendAt: future }, /too long/],
    [{ to: '+966500000000', body: 'x', sendAt: future, repeat: 'hourly' }, /repeat/],
  ];
  for (const [body, pattern] of cases) {
    const res = await fetch(`${open.base}/api/messages`, json(body));
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).error, pattern);
  }
});

test('contact search finds saved contacts and groups', async () => {
  open.db.contacts.upsertMany([
    { jid: '1@s.whatsapp.net', name: 'Mom', isGroup: false },
    { jid: '2@g.us', name: 'Family 100%', isGroup: true },
  ]);
  const found = await (await fetch(`${open.base}/api/contacts?q=fam`)).json();
  assert.deepEqual(found, [{ jid: '2@g.us', name: 'Family 100%', isGroup: true }]);
  const literal = await (await fetch(`${open.base}/api/contacts?q=${encodeURIComponent('100%')}`)).json();
  assert.equal(literal.length, 1);
});

test('unknown API routes return JSON 404', async () => {
  const res = await fetch(`${open.base}/api/nope`);
  assert.equal(res.status, 404);
});

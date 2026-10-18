// HTTP API + static UI. Exported as a factory so tests can run it against fakes.
import express from 'express';
import helmet from 'helmet';
import { createAuth } from './auth.js';
import { REPEATS, dayOfMonth } from './recurrence.js';
import { PermanentError } from './scheduler.js';

const MAX_BODY_CHARS = 4096;
const MAX_AHEAD_MS = 2 * 365 * 24 * 60 * 60_000;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

class BadRequest extends Error {}

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

function toApi(m) {
  return {
    id: m.id,
    to: m.to,
    toName: m.toName,
    body: m.body,
    sendAt: iso(m.sendAt),
    repeat: m.repeat,
    status: m.status,
    attempts: m.attempts,
    retryAt: iso(m.retryAt),
    ack: m.ack,
    error: m.error,
    sentAt: iso(m.sentAt),
  };
}

export function createApp({ config, db, sender, scheduler, logger, now = Date.now }) {
  const app = express();
  const auth = createAuth({ config, db, now });
  const allowedHosts = new Set([...LOCAL_HOSTS, ...config.allowedHosts]);

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  // Reject other Host headers (blocks DNS-rebinding attacks from web pages).
  app.use((req, res, next) => {
    const host = (req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    if (allowedHosts.has(host)) return next();
    res.status(403).send('Forbidden host. Add it to ALLOWED_HOSTS.');
  });

  app.use(helmet({ crossOriginEmbedderPolicy: false }));
  app.use(express.json({ limit: '64kb' }));

  // State changes must declare JSON, even with no body: a cross-site page can't set that header
  // without a CORS preflight, which we never approve. (req.is() skips bodiless requests, so check the header.)
  app.use('/api', (req, res, next) => {
    const type = String(req.headers['content-type'] || '').toLowerCase();
    if (req.method !== 'GET' && req.method !== 'HEAD' && !type.startsWith('application/json')) {
      return res.status(415).json({ error: 'Send JSON.' });
    }
    next();
  });

  app.get('/healthz', (req, res) => {
    res.json({ ok: true, whatsapp: sender.state.status, pending: db.messages.pendingCount() });
  });

  // No max-age: browsers revalidate via ETag, so a refresh always picks up a new release.
  app.use(express.static(config.publicDir, { index: 'index.html' }));

  app.get('/api/session', (req, res) => {
    res.json({ authenticated: auth.isAuthenticated(req), authRequired: auth.enabled });
  });
  app.post('/api/login', auth.login);
  app.post('/api/logout', auth.logout);

  app.use('/api', auth.requireAuth);

  const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  async function parseMessage(body) {
    const text = String(body.body ?? '').trim();
    const sendAt = Date.parse(body.sendAt);
    const repeat = body.repeat ?? 'none';

    if (!body.to) throw new BadRequest('Pick a chat or enter a phone number.');
    if (!text) throw new BadRequest('Message is empty.');
    if (text.length > MAX_BODY_CHARS) throw new BadRequest(`Message is too long (max ${MAX_BODY_CHARS} characters).`);
    if (Number.isNaN(sendAt)) throw new BadRequest('Invalid date/time.');
    if (sendAt < now() - 60_000) throw new BadRequest('That time is in the past.');
    if (sendAt > now() + MAX_AHEAD_MS) throw new BadRequest('That is more than two years away.');
    if (!REPEATS.includes(repeat)) throw new BadRequest('Invalid repeat option.');

    const recipient = await sender.resolveRecipient(body.to);
    return {
      to: recipient.jid,
      toName: String(body.toName || recipient.name).slice(0, 100),
      body: text,
      sendAt,
      repeat,
      repeatDay: repeat === 'monthly' ? dayOfMonth(sendAt, config.timezone) : null,
    };
  }

  app.get('/api/status', (req, res) => {
    res.json({
      ...sender.state,
      mode: sender.mode,
      timezone: config.timezone,
      graceMinutes: config.graceMinutes,
    });
  });

  app.get('/api/contacts', (req, res) => {
    const q = String(req.query.q || '').trim();
    res.json(q ? db.contacts.search(q, 30) : []);
  });

  app.get('/api/messages', (req, res) => {
    const list = req.query.view === 'history' ? db.messages.history(200) : db.messages.upcoming(500);
    res.json(list.map(toApi));
  });

  app.post('/api/messages', route(async (req, res) => {
    const fields = await parseMessage(req.body);
    const m = db.messages.create(fields);
    logger.info({ id: m.id, to: m.toName, sendAt: iso(m.sendAt) }, 'Message scheduled');
    res.status(201).json(toApi(m));
  }));

  app.put('/api/messages/:id', route(async (req, res) => {
    const m = db.messages.get(req.params.id);
    if (!m) return res.status(404).json({ error: 'Not found.' });
    if (m.status !== 'pending') throw new BadRequest('Only pending messages can be edited.');
    const fields = await parseMessage(req.body);
    res.json(toApi(db.messages.update(m.id, { ...fields, retryAt: null, attempts: 0, error: null })));
  }));

  app.post('/api/messages/:id/send-now', route(async (req, res) => {
    if (!db.messages.get(req.params.id)) return res.status(404).json({ error: 'Not found.' });
    res.json(toApi(await scheduler.sendNow(req.params.id)));
  }));

  // Pending -> cancelled (also ends a repeating series). Anything else -> removed from history.
  app.delete('/api/messages/:id', (req, res) => {
    const m = db.messages.get(req.params.id);
    if (!m) return res.status(404).json({ error: 'Not found.' });
    if (m.status === 'sending') return res.status(409).json({ error: 'It is being sent right now.' });
    if (m.status === 'pending') db.messages.update(m.id, { status: 'cancelled', nextSpawned: true });
    else db.messages.remove(m.id);
    res.json({ ok: true });
  });

  // Sender errors here are user-facing ("already linked", "not supported in desktop mode").
  const senderAction = (fn) => route(async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      throw new BadRequest(err.message);
    }
  });

  app.post('/api/whatsapp/pair', senderAction(async (req) => ({ code: await sender.requestPairingCode(req.body.phone || '') })));
  app.post('/api/whatsapp/logout', senderAction(async () => {
    await sender.logout();
    return { ok: true };
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof BadRequest || err instanceof PermanentError) {
      return res.status(400).json({ error: err.message });
    }
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return res.status(400).json({ error: 'Invalid request body.' });
    }
    logger.error({ err, path: req.path }, 'Request failed');
    res.status(err.status && err.status < 500 ? err.status : 500).json({ error: err.expose ? err.message : 'Something went wrong.' });
  });

  return app;
}

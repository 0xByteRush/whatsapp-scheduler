// Single-user password login with a signed, HttpOnly, SameSite=Strict session cookie.
import crypto from 'node:crypto';

const COOKIE = 'wa_session';
const SESSION_MS = 30 * 24 * 60 * 60_000;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_ATTEMPTS = 10;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createAuth({ config, db, now = Date.now }) {
  const enabled = Boolean(config.adminPassword);
  let secret = db.settings.get('session_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    db.settings.set('session_secret', secret);
  }
  // Changing ADMIN_PASSWORD signs everyone out.
  const pwTag = sha256(`pw:${config.adminPassword}`).toString('hex').slice(0, 16);
  const sign = (expires) => crypto.createHmac('sha256', secret).update(`v1.${expires}.${pwTag}`).digest('hex');

  const attempts = new Map(); // ip -> { count, since }

  function isAuthenticated(req) {
    if (!enabled) return true;
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return false;
    const [expires, sig] = token.split('.');
    if (!expires || !sig || Number(expires) < now()) return false;
    const expected = Buffer.from(sign(expires), 'hex');
    const given = Buffer.from(sig, 'hex');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  function cookie(req, value, maxAgeMs) {
    const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
    if (req.secure) parts.push('Secure');
    return parts.join('; ');
  }

  function login(req, res) {
    if (!enabled) return res.json({ ok: true });
    const ip = req.ip;
    const entry = attempts.get(ip);
    if (entry && now() - entry.since < LOGIN_WINDOW_MS && entry.count >= LOGIN_MAX_ATTEMPTS) {
      return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    }
    const ok = crypto.timingSafeEqual(sha256(String(req.body?.password ?? '')), sha256(config.adminPassword));
    if (!ok) {
      const fresh = !entry || now() - entry.since >= LOGIN_WINDOW_MS;
      attempts.set(ip, fresh ? { count: 1, since: now() } : { count: entry.count + 1, since: entry.since });
      return res.status(401).json({ error: 'Wrong password.' });
    }
    attempts.delete(ip);
    const expires = now() + SESSION_MS;
    res.setHeader('Set-Cookie', cookie(req, `${expires}.${sign(expires)}`, SESSION_MS));
    res.json({ ok: true });
  }

  function logout(req, res) {
    res.setHeader('Set-Cookie', cookie(req, '', 0));
    res.json({ ok: true });
  }

  function requireAuth(req, res, next) {
    if (isAuthenticated(req)) return next();
    res.status(401).json({ error: 'Please sign in.' });
  }

  return { enabled, isAuthenticated, login, logout, requireAuth };
}

// All settings come from environment variables (or a .env file next to package.json).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

const num = (value, fallback) => {
  const n = Number(value);
  return value === undefined || value === '' || Number.isNaN(n) ? fallback : n;
};

export function loadConfig(overrides = {}) {
  const config = {
    port: num(env.PORT, 3737),
    host: env.HOST || '127.0.0.1',
    dataDir: path.resolve(env.DATA_DIR || path.join(root, 'data')),
    publicDir: path.join(root, 'public'),
    // baileys: own linked-device session (works headless, groups, receipts)
    // desktop: drives the WhatsApp Desktop app signed in on this Windows PC
    sender: env.SENDER || 'baileys',
    timezone: env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    adminPassword: env.ADMIN_PASSWORD || '',
    graceMinutes: num(env.MISSED_GRACE_MINUTES, 60),
    maxAttempts: num(env.MAX_ATTEMPTS, 3),
    minSendGapMs: num(env.MIN_SEND_GAP_MS, 4000),
    dailyLimit: num(env.DAILY_SEND_LIMIT, 200),
    tickMs: num(env.TICK_MS, 5000),
    alertNtfyUrl: env.ALERT_NTFY_URL || '',
    logLevel: env.LOG_LEVEL || 'info',
    trustProxy: env.TRUST_PROXY === '1',
    allowedHosts: (env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    ...overrides,
  };
  validate(config);
  return config;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function validate(config) {
  if (!['baileys', 'desktop'].includes(config.sender)) {
    throw new Error(`SENDER must be "baileys" or "desktop" (got "${config.sender}").`);
  }
  if (config.sender === 'desktop' && process.platform !== 'win32') {
    throw new Error('SENDER=desktop only works on Windows with WhatsApp Desktop installed.');
  }
  // Anyone who reaches the page can message as you, so a password is mandatory off-localhost.
  if (!LOOPBACK.has(config.host) && !config.adminPassword) {
    throw new Error(`HOST=${config.host} exposes the app beyond this machine; set ADMIN_PASSWORD.`);
  }
  if (config.adminPassword && config.adminPassword.length < 10) {
    throw new Error('ADMIN_PASSWORD must be at least 10 characters.');
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: config.timezone });
  } catch {
    throw new Error(`TZ "${config.timezone}" is not a valid IANA time zone (e.g. Asia/Riyadh).`);
  }
}

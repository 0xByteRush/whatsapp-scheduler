// Entry point: wires config, storage, the WhatsApp sender, the scheduler and the web server.
import './quiet-libsignal.js'; // must load before Baileys
import path from 'node:path';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { openDb, importLegacyJson } from './db.js';
import { createSender } from './senders/index.js';
import { Scheduler } from './scheduler.js';
import { createAlerter } from './alerts.js';
import { createApp } from './server.js';

const DISCONNECT_ALERT_DELAY_MS = 5 * 60_000;

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`Configuration error: ${err.message}`);
  process.exit(1);
}

const logger = createLogger(config.logLevel);
process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled promise rejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception; exiting so the supervisor can restart us');
  process.exit(1);
});

const db = openDb(path.join(config.dataDir, 'scheduler.db'));
importLegacyJson(db, path.join(config.dataDir, 'messages.json'), logger);

const alert = createAlerter({ config, logger });
const sender = await createSender({ config, db, logger });
const scheduler = new Scheduler({ db, sender, config, logger, alert });

// Brief reconnects are normal; only alert if WhatsApp stays down.
let downTimer = null;
sender.on('disconnected', () => {
  clearTimeout(downTimer);
  downTimer = setTimeout(() => {
    if (!sender.isReady()) alert('down', 'WhatsApp disconnected', 'WhatsApp has been disconnected for 5 minutes.');
  }, DISCONNECT_ALERT_DELAY_MS);
});
sender.on('ready', () => clearTimeout(downTimer));
sender.on('logged_out', () => alert('logged_out', 'WhatsApp unlinked', 'The scheduler was unlinked. Open the app and link again.'));
sender.on('conflict', () => alert('conflict', 'WhatsApp session conflict', 'Another copy of the app is using this session.'));

scheduler.start();
await sender.start();

const app = createApp({ config, db, sender, scheduler, logger });
const server = app.listen(config.port, config.host, () => {
  const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
  logger.info(`WhatsApp Scheduler running at http://${shown}:${config.port} (sender: ${config.sender}, TZ: ${config.timezone})`);
});
server.on('error', (err) => {
  logger.fatal({ err: err.message }, 'Could not start the web server');
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  const force = setTimeout(() => process.exit(1), 15_000).unref();
  server.close();
  await scheduler.stop(); // finishes an in-flight send
  await sender.stop();
  db.close();
  clearTimeout(force);
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

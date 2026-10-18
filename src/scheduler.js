// The job engine: finds due messages, claims each one atomically, sends it, retries with
// backoff, and queues the next occurrence of repeating messages exactly once.
import { nextFutureOccurrence } from './recurrence.js';

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
const DAY_MS = 24 * 60 * 60_000;

export class PermanentError extends Error {}

export class Scheduler {
  constructor({ db, sender, config, logger, alert = async () => {}, now = Date.now, sleep }) {
    this.db = db;
    this.sender = sender;
    this.config = config;
    this.log = logger;
    this.alert = alert;
    this.now = now;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.running = null; // promise of the tick in progress
    this.timer = null;
    this.lastSendAt = 0;
  }

  start() {
    this.recoverInterrupted();
    this.timer = setInterval(() => this.tick(), this.config.tickMs);
    this.sender.on('ready', () => this.tick());
    this.sender.on('ack', (waId, ack) => this.db.messages.setAck(waId, ack));
  }

  async stop() {
    clearInterval(this.timer);
    await this.running; // let an in-flight send finish
  }

  // A crash between "sending" and "sent" leaves us unsure whether WhatsApp got it.
  // Never auto-resend those: a duplicate is worse than asking.
  recoverInterrupted() {
    for (const m of this.db.messages.interrupted()) {
      if (m.ack >= 2) {
        this.db.messages.update(m.id, { status: 'sent', sentAt: m.sentAt || m.updatedAt });
      } else {
        this.db.messages.update(m.id, {
          status: 'failed',
          error: 'Interrupted while sending. Check WhatsApp before re-sending.',
        });
      }
      this.spawnNext(m);
    }
  }

  tick() {
    if (this.running || !this.sender.isReady()) return this.running;
    this.running = this.processDue()
      .catch((err) => this.log.error({ err }, 'Scheduler tick failed'))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  async processDue() {
    for (const m of this.db.messages.due(this.now())) {
      if (!this.sender.isReady()) return;

      const lateMs = this.now() - m.sendAt;
      if (m.attempts === 0 && lateMs > this.config.graceMinutes * 60_000) {
        this.db.messages.update(m.id, {
          status: 'missed',
          error: `WhatsApp wasn't available at the scheduled time (${Math.round(lateMs / 60_000)} min ago).`,
        });
        this.log.warn({ id: m.id }, 'Message missed');
        this.alert('missed', 'Scheduled message missed', `Message to ${m.toName} was not sent on time.`);
        this.spawnNext(m);
        continue;
      }

      if (this.db.messages.sentSince(this.now() - DAY_MS) >= this.config.dailyLimit) {
        this.log.warn('Daily send limit reached; holding remaining messages');
        this.alert('limit', 'Daily send limit reached', `DAILY_SEND_LIMIT (${this.config.dailyLimit}) reached.`);
        return;
      }

      await this.pace();
      if (!this.db.messages.claim(m.id)) continue; // cancelled or sent-now meanwhile
      await this.deliver(this.db.messages.get(m.id));
    }
  }

  // Space out sends: bursts look like spam to WhatsApp.
  async pace() {
    const gap = this.config.minSendGapMs * (1 + Math.random() * 0.5);
    const wait = this.lastSendAt + gap - this.now();
    if (wait > 0) await this.sleep(wait);
  }

  // m must already be claimed (status 'sending').
  async deliver(m) {
    const waId = this.sender.newMessageId();
    if (waId) this.db.messages.update(m.id, { waId });
    try {
      const sentId = await this.sender.send(m.to, m.body, { messageId: waId });
      this.lastSendAt = this.now();
      const finalId = sentId || waId;
      this.db.messages.update(m.id, { status: 'sent', sentAt: this.now(), error: null, retryAt: null, waId: finalId });
      // MAX() in setAck keeps a receipt that may already have arrived during the send.
      if (finalId) this.db.messages.setAck(finalId, 1);
      this.log.info({ id: m.id, to: m.toName }, 'Message sent');
      this.spawnNext(m);
      return true;
    } catch (err) {
      this.lastSendAt = this.now();
      const permanent = err instanceof PermanentError;
      if (!permanent && m.attempts < this.config.maxAttempts) {
        const delay = RETRY_DELAYS_MS[Math.min(m.attempts - 1, RETRY_DELAYS_MS.length - 1)];
        this.db.messages.update(m.id, { status: 'pending', retryAt: this.now() + delay, error: err.message });
        this.log.warn({ id: m.id, attempt: m.attempts, err: err.message }, 'Send failed; will retry');
      } else {
        this.db.messages.update(m.id, { status: 'failed', error: err.message, retryAt: null });
        this.log.error({ id: m.id, err: err.message }, 'Send failed permanently');
        this.alert(`failed:${m.id}`, 'Scheduled message failed', `Message to ${m.toName} failed: ${err.message}`);
        this.spawnNext(m);
      }
      return false;
    }
  }

  // Queue the next occurrence of a repeating message, once per occurrence.
  spawnNext(m) {
    if (m.repeat === 'none' || m.nextSpawned) return null;
    return this.db.tx(() => {
      const fresh = this.db.messages.get(m.id);
      if (fresh.nextSpawned) return null;
      this.db.messages.update(m.id, { nextSpawned: true });
      const sendAt = nextFutureOccurrence(m.sendAt, m.repeat, m.repeatDay, this.config.timezone, this.now());
      return this.db.messages.create({
        seriesId: m.seriesId,
        to: m.to,
        toName: m.toName,
        body: m.body,
        sendAt,
        repeat: m.repeat,
        repeatDay: m.repeatDay,
      });
    });
  }

  // "Send now" from the UI, for pending, failed or missed messages.
  async sendNow(id) {
    const m = this.db.messages.get(id);
    if (!m) throw new PermanentError('Message not found.');
    if (!['pending', 'failed', 'missed'].includes(m.status)) throw new PermanentError(`Message is already ${m.status}.`);
    if (!this.sender.isReady()) throw new PermanentError('WhatsApp is not connected.');
    if (m.status !== 'pending') this.db.messages.update(id, { status: 'pending', attempts: 0, retryAt: null });
    if (!this.db.messages.claim(id)) throw new PermanentError('Message is being sent right now.');
    // Manual sends shouldn't trigger automatic retries.
    const claimed = this.db.messages.update(id, { attempts: this.config.maxAttempts });
    await this.deliver(claimed);
    return this.db.messages.get(id);
  }
}

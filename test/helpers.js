import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import pino from 'pino';

export const silentLogger = pino({ level: 'silent' });

export function testConfig(overrides = {}) {
  return {
    port: 0,
    host: '127.0.0.1',
    publicDir: fileURLToPath(new URL('../public/', import.meta.url)),
    sender: 'baileys',
    timezone: 'Asia/Riyadh',
    adminPassword: '',
    graceMinutes: 60,
    maxAttempts: 3,
    minSendGapMs: 0,
    dailyLimit: 200,
    tickMs: 60_000,
    alertNtfyUrl: '',
    trustProxy: false,
    allowedHosts: [],
    ...overrides,
  };
}

export class FakeClock {
  constructor(start = Date.UTC(2026, 9, 18, 9, 0)) {
    this.t = start;
  }
  now = () => this.t;
  advance(ms) {
    this.t += ms;
  }
}

export class FakeSender extends EventEmitter {
  constructor() {
    super();
    this.mode = 'baileys';
    this.state = { status: 'ready' };
    this.sent = [];
    this.failWith = null; // Error to throw from send()
    this.ids = 0;
  }
  isReady() {
    return this.state.status === 'ready';
  }
  async resolveRecipient(input) {
    if (String(input).includes('@')) return { jid: input, name: 'Group' };
    const digits = String(input).replace(/\D/g, '');
    return { jid: `${digits}@s.whatsapp.net`, name: `+${digits}` };
  }
  newMessageId() {
    return `MSG${++this.ids}`;
  }
  async send(jid, text, { messageId } = {}) {
    if (this.failWith) throw this.failWith;
    this.sent.push({ jid, text, messageId });
    return messageId;
  }
  async requestPairingCode() {
    return 'ABCD1234';
  }
  async logout() {}
  async stop() {}
}

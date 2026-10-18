// Sends through WhatsApp's own protocol (Baileys) as a linked device: no browser, no screen.
import { EventEmitter } from 'node:events';
import QRCode from 'qrcode';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  generateMessageIDV2,
  isJidGroup,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
} from 'baileys';
import { useSqliteAuthState } from './auth-state.js';
import { PermanentError } from '../scheduler.js';

const MAX_BACKOFF_MS = 60_000;

export class BaileysSender extends EventEmitter {
  constructor({ db, logger }) {
    super();
    this.mode = 'baileys';
    this.db = db;
    this.log = logger.child({ component: 'whatsapp' });
    this.sock = null;
    this.stopped = false;
    this.retries = 0;
    this.reconnectTimer = null;
    this.state = { status: 'starting', qr: null, pairingCode: null, me: null, error: null };
  }

  setState(fields) {
    Object.assign(this.state, fields);
  }

  isReady() {
    return this.state.status === 'ready';
  }

  async start() {
    this.stopped = false;
    await this.connect();
  }

  async connect() {
    clearTimeout(this.reconnectTimer);
    const { state, saveCreds, clear } = useSqliteAuthState(this.db);
    this.clearAuth = clear;

    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      // Falls back to the version bundled with Baileys.
    }

    const quiet = this.log.child({ component: 'baileys' }, { level: 'warn' });
    const sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, quiet) },
      logger: quiet,
      browser: Browsers.windows('Chrome'),
      markOnlineOnConnect: false, // keep phone notifications working
      syncFullHistory: false,
      // WhatsApp asks for a resend when a recipient's device couldn't decrypt.
      getMessage: async (key) => {
        const m = this.db.messages.getByWaId(key.id);
        return m ? { conversation: m.body } : undefined;
      },
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => this.onConnectionUpdate(sock, update));
    sock.ev.on('messages.update', (updates) => {
      for (const { key, update } of updates) {
        if (key.fromMe && typeof update.status === 'number') this.emit('ack', key.id, update.status);
      }
    });
    sock.ev.on('messaging-history.set', ({ contacts }) => this.saveContacts(contacts));
    sock.ev.on('contacts.upsert', (contacts) => this.saveContacts(contacts));
    sock.ev.on('contacts.update', (contacts) => this.saveContacts(contacts));
    sock.ev.on('groups.upsert', (groups) => this.saveGroups(groups));
    sock.ev.on('groups.update', (groups) => this.saveGroups(groups.filter((g) => g.subject)));
  }

  async onConnectionUpdate(sock, { connection, lastDisconnect, qr }) {
    if (sock !== this.sock) return; // event from a socket we've already replaced

    if (qr) {
      this.setState({ status: 'qr', qr: await QRCode.toDataURL(qr, { margin: 1, width: 280 }), error: null });
    }

    if (connection === 'open') {
      this.retries = 0;
      const me = sock.user;
      this.setState({
        status: 'ready',
        qr: null,
        pairingCode: null,
        error: null,
        me: { name: me?.name || me?.verifiedName || 'You', number: jidNormalizedUser(me?.id).split('@')[0] },
      });
      this.log.info({ number: this.state.me.number }, 'WhatsApp connected');
      this.emit('ready');
      sock.groupFetchAllParticipating()
        .then((groups) => this.saveGroups(Object.values(groups)))
        .catch((err) => this.log.warn({ err: err.message }, 'Could not fetch groups'));
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const wasReady = this.isReady();
      this.setState({ status: 'disconnected', me: wasReady ? this.state.me : null });
      if (this.stopped) return;

      if (code === DisconnectReason.loggedOut) {
        this.log.warn('WhatsApp session logged out; clearing credentials');
        this.clearAuth();
        this.setState({ status: 'logged_out', me: null, error: 'Unlinked from your phone. Link again to keep sending.' });
        this.emit('logged_out');
        this.scheduleReconnect(1000);
      } else if (code === DisconnectReason.connectionReplaced) {
        // Another process is using the same session. Fighting over it would loop forever.
        this.setState({ status: 'error', error: 'Another copy of this app took over the WhatsApp session.' });
        this.emit('conflict');
      } else {
        const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(1000 * 2 ** this.retries, MAX_BACKOFF_MS);
        this.retries++;
        this.setState({ error: wasReady ? 'Connection lost. Reconnecting...' : this.state.error });
        if (wasReady) this.emit('disconnected', code);
        this.log.warn({ code, delay }, 'WhatsApp connection closed; reconnecting');
        this.scheduleReconnect(delay);
      }
    }
  }

  scheduleReconnect(delay) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        this.log.error({ err: err.message }, 'Reconnect failed');
        this.scheduleReconnect(Math.min(1000 * 2 ** ++this.retries, MAX_BACKOFF_MS));
      });
    }, delay);
  }

  saveContacts(list = []) {
    const rows = [];
    for (const c of list) {
      const name = c.name || c.notify || c.verifiedName;
      const jid = c.phoneNumber || c.id;
      if (name && jid && !isJidGroup(jid)) rows.push({ jid: jidNormalizedUser(jid), name, isGroup: false });
    }
    this.db.contacts.upsertMany(rows);
  }

  saveGroups(list = []) {
    this.db.contacts.upsertMany(list.filter((g) => g.id && g.subject).map((g) => ({ jid: g.id, name: g.subject, isGroup: true })));
  }

  // Phone number or a jid picked from the contact list -> { jid, name }.
  async resolveRecipient(input) {
    const to = String(input).trim();
    if (to.includes('@')) {
      const known = this.db.contacts.get(to);
      return { jid: to, name: known?.name || to.split('@')[0] };
    }
    const digits = to.replace(/\D/g, '').replace(/^00/, '');
    if (digits.length < 7) throw new PermanentError('Phone number looks too short. Include the country code.');
    if (!this.isReady()) return { jid: `${digits}@s.whatsapp.net`, name: `+${digits}` };
    const [result] = (await this.sock.onWhatsApp(digits)) || [];
    if (!result?.exists) throw new PermanentError(`+${digits} is not on WhatsApp.`);
    const jid = jidNormalizedUser(result.jid);
    return { jid, name: this.db.contacts.get(jid)?.name || `+${digits}` };
  }

  newMessageId() {
    return generateMessageIDV2(this.sock?.user?.id);
  }

  async send(jid, text, { messageId } = {}) {
    if (!this.isReady()) throw new Error('WhatsApp is not connected.');
    // Rows created in desktop mode (or imported) store bare phone digits.
    if (!jid.includes('@')) jid = (await this.resolveRecipient(jid)).jid;
    const msg = await this.sock.sendMessage(jid, { text }, { messageId });
    return msg?.key?.id;
  }

  async requestPairingCode(phone) {
    if (this.isReady()) throw new Error('Already linked.');
    if (!this.sock || this.state.status !== 'qr') throw new Error('Not ready to link yet. Try again in a few seconds.');
    const digits = String(phone).replace(/\D/g, '').replace(/^00/, '');
    if (digits.length < 7) throw new Error('Enter your full number with country code.');
    const code = await this.sock.requestPairingCode(digits);
    this.setState({ pairingCode: code });
    return code;
  }

  async logout() {
    if (!this.sock) return;
    await this.sock.logout(); // triggers loggedOut -> credentials cleared -> fresh QR
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    try {
      this.sock?.end(undefined);
    } catch {
      // already closed
    }
  }
}

// Fallback sender for Windows: drives the WhatsApp Desktop app already signed in on this PC.
// No new device link needed, but Windows must be unlocked at send time and only phone numbers work.
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PermanentError } from '../scheduler.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'desktop-send.ps1');

function powershell(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args],
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout.trim())),
    );
  });
}

export class DesktopSender extends EventEmitter {
  constructor({ logger }) {
    super();
    this.mode = 'desktop';
    this.log = logger.child({ component: 'desktop' });
    this.state = { status: 'starting', qr: null, pairingCode: null, me: null, error: null };
    this.queue = Promise.resolve();
    this.keepAwakeProc = null;
  }

  isReady() {
    return this.state.status === 'ready';
  }

  async start() {
    try {
      const version = await powershell(['-Command', '(Get-AppxPackage *WhatsAppDesktop*).Version'], 30_000);
      if (!version) throw new Error('WhatsApp Desktop is not installed. Install it from the Microsoft Store and sign in.');
      Object.assign(this.state, { status: 'ready', error: null, me: { name: 'WhatsApp Desktop', number: null } });
      this.keepAwake();
      this.log.info({ version }, 'Using WhatsApp Desktop');
      this.emit('ready');
    } catch (err) {
      Object.assign(this.state, { status: 'error', error: err.message });
      this.log.error({ err: err.message }, 'WhatsApp Desktop unavailable');
    }
  }

  // Stops Windows from sleeping while we run; the helper exits on its own when we do.
  keepAwake() {
    const cmd =
      `Add-Type -Name P -Namespace W -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);';` +
      `[W.P]::SetThreadExecutionState(0x80000001) | Out-Null; Wait-Process -Id ${process.pid}`;
    this.keepAwakeProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      windowsHide: true,
      stdio: 'ignore',
    });
    this.keepAwakeProc.unref();
  }

  async resolveRecipient(input) {
    const to = String(input).trim();
    if (to.includes('@')) throw new PermanentError('Desktop mode can only send to phone numbers, not groups.');
    const digits = to.replace(/\D/g, '').replace(/^00/, '');
    if (digits.length < 7) throw new PermanentError('Phone number looks too short. Include the country code.');
    return { jid: digits, name: `+${digits}` };
  }

  newMessageId() {
    return null; // the desktop app doesn't expose message ids or receipts
  }

  // One at a time: each send takes over the WhatsApp window.
  send(to, text) {
    const run = async () => {
      const { jid } = await this.resolveRecipient(to);
      const b64 = Buffer.from(text, 'utf8').toString('base64');
      await powershell(['-File', SCRIPT, '-Phone', jid, '-TextB64', b64], 90_000);
      return null;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async requestPairingCode() {
    throw new Error('Not needed in desktop mode.');
  }

  async logout() {
    throw new Error('Desktop mode uses your WhatsApp Desktop app. Sign out there instead.');
  }

  async stop() {
    this.keepAwakeProc?.kill();
  }
}

// SQLite storage (Node's built-in node:sqlite). One file, WAL mode, versioned migrations.
// All timestamps are epoch milliseconds.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  `CREATE TABLE messages (
     id            TEXT PRIMARY KEY,
     series_id     TEXT NOT NULL,
     to_jid        TEXT NOT NULL,
     to_name       TEXT NOT NULL,
     body          TEXT NOT NULL,
     send_at       INTEGER NOT NULL,
     repeat        TEXT NOT NULL DEFAULT 'none',
     repeat_day    INTEGER,
     status        TEXT NOT NULL DEFAULT 'pending',
     attempts      INTEGER NOT NULL DEFAULT 0,
     retry_at      INTEGER,
     next_spawned  INTEGER NOT NULL DEFAULT 0,
     wa_id         TEXT,
     ack           INTEGER,
     error         TEXT,
     created_at    INTEGER NOT NULL,
     updated_at    INTEGER NOT NULL,
     sent_at       INTEGER
   );
   CREATE INDEX messages_due ON messages (status, send_at);
   CREATE INDEX messages_wa_id ON messages (wa_id);
   CREATE TABLE contacts (
     jid        TEXT PRIMARY KEY,
     name       TEXT NOT NULL,
     is_group   INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
];

const COLUMNS = {
  seriesId: 'series_id', to: 'to_jid', toName: 'to_name', body: 'body', sendAt: 'send_at',
  repeat: 'repeat', repeatDay: 'repeat_day', status: 'status', attempts: 'attempts',
  retryAt: 'retry_at', nextSpawned: 'next_spawned', waId: 'wa_id', ack: 'ack', error: 'error',
  sentAt: 'sent_at',
};

function toMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    seriesId: row.series_id,
    to: row.to_jid,
    toName: row.to_name,
    body: row.body,
    sendAt: row.send_at,
    repeat: row.repeat,
    repeatDay: row.repeat_day,
    status: row.status,
    attempts: row.attempts,
    retryAt: row.retry_at,
    nextSpawned: row.next_spawned === 1,
    waId: row.wa_id,
    ack: row.ack,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at,
  };
}

// node:sqlite rejects undefined and booleans; normalize before binding.
const bind = (v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v);

export function openDb(file, { now = Date.now } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  let depth = 0;
  // Nested calls join the outer transaction.
  function tx(fn) {
    if (depth > 0) return fn();
    db.exec('BEGIN IMMEDIATE');
    depth++;
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      depth--;
    }
  }

  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    tx(() => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }

  const stmt = {
    get: db.prepare('SELECT * FROM messages WHERE id = ?'),
    byWaId: db.prepare('SELECT * FROM messages WHERE wa_id = ?'),
    insert: db.prepare(`INSERT INTO messages
      (id, series_id, to_jid, to_name, body, send_at, repeat, repeat_day, status, created_at, updated_at)
      VALUES (:id, :seriesId, :to, :toName, :body, :sendAt, :repeat, :repeatDay, 'pending', :now, :now)`),
    due: db.prepare(`SELECT * FROM messages
      WHERE status = 'pending' AND COALESCE(retry_at, send_at) <= ?
      ORDER BY COALESCE(retry_at, send_at) LIMIT 50`),
    claim: db.prepare(`UPDATE messages SET status = 'sending', attempts = attempts + 1, updated_at = ?
      WHERE id = ? AND status = 'pending'`),
    upcoming: db.prepare(`SELECT * FROM messages WHERE status IN ('pending', 'sending') ORDER BY send_at LIMIT ?`),
    history: db.prepare(`SELECT * FROM messages WHERE status NOT IN ('pending', 'sending')
      ORDER BY COALESCE(sent_at, send_at) DESC LIMIT ?`),
    remove: db.prepare('DELETE FROM messages WHERE id = ?'),
    sentSince: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE sent_at >= ?'),
    pendingCount: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE status = 'pending'`),
    interrupted: db.prepare(`SELECT * FROM messages WHERE status = 'sending'`),
    ack: db.prepare('UPDATE messages SET ack = MAX(COALESCE(ack, 0), ?), updated_at = ? WHERE wa_id = ?'),
    contactUpsert: db.prepare(`INSERT INTO contacts (jid, name, is_group, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (jid) DO UPDATE SET name = excluded.name, is_group = excluded.is_group, updated_at = excluded.updated_at`),
    contactGet: db.prepare('SELECT * FROM contacts WHERE jid = ?'),
    contactSearch: db.prepare(`SELECT * FROM contacts WHERE name LIKE ? ESCAPE '\\' ORDER BY is_group, name LIMIT ?`),
    authGet: db.prepare('SELECT value FROM auth_kv WHERE key = ?'),
    authSet: db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
    authDel: db.prepare('DELETE FROM auth_kv WHERE key = ?'),
    authClear: db.prepare('DELETE FROM auth_kv'),
    settingGet: db.prepare('SELECT value FROM settings WHERE key = ?'),
    settingSet: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
  };

  const messages = {
    get: (id) => toMessage(stmt.get.get(id)),
    getByWaId: (waId) => toMessage(stmt.byWaId.get(waId)),

    create(fields) {
      const id = crypto.randomUUID();
      stmt.insert.run({
        id,
        seriesId: fields.seriesId || id,
        to: fields.to,
        toName: fields.toName,
        body: fields.body,
        sendAt: fields.sendAt,
        repeat: fields.repeat || 'none',
        repeatDay: bind(fields.repeatDay),
        now: now(),
      });
      return messages.get(id);
    },

    update(id, fields) {
      const sets = [];
      const values = [];
      for (const [key, value] of Object.entries(fields)) {
        if (!COLUMNS[key]) throw new Error(`Unknown message field: ${key}`);
        sets.push(`${COLUMNS[key]} = ?`);
        values.push(bind(value));
      }
      sets.push('updated_at = ?');
      values.push(now(), id);
      db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...values);
      return messages.get(id);
    },

    // Atomically move pending -> sending. Returns false if someone else got it first.
    claim: (id) => stmt.claim.run(now(), id).changes === 1,
    due: (at) => stmt.due.all(at).map(toMessage),
    upcoming: (limit = 500) => stmt.upcoming.all(limit).map(toMessage),
    history: (limit = 200) => stmt.history.all(limit).map(toMessage),
    remove: (id) => stmt.remove.run(id).changes === 1,
    sentSince: (at) => stmt.sentSince.get(at).n,
    pendingCount: () => stmt.pendingCount.get().n,
    interrupted: () => stmt.interrupted.all().map(toMessage),
    // Receipts only ever move forward (sent -> delivered -> read).
    setAck: (waId, ack) => stmt.ack.run(ack, now(), waId).changes,
  };

  const contacts = {
    upsertMany(list) {
      if (!list.length) return;
      tx(() => {
        for (const c of list) stmt.contactUpsert.run(c.jid, c.name, c.isGroup ? 1 : 0, now());
      });
    },
    get(jid) {
      const row = stmt.contactGet.get(jid);
      return row && { jid: row.jid, name: row.name, isGroup: row.is_group === 1 };
    },
    search(query, limit = 30) {
      const like = `%${String(query).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      return stmt.contactSearch.all(like, limit).map((r) => ({ jid: r.jid, name: r.name, isGroup: r.is_group === 1 }));
    },
  };

  const auth = {
    get: (key) => stmt.authGet.get(key)?.value ?? null,
    set: (key, value) => stmt.authSet.run(key, value),
    del: (key) => stmt.authDel.run(key),
    clear: () => stmt.authClear.run(),
    tx,
  };

  const settings = {
    get: (key) => stmt.settingGet.get(key)?.value ?? null,
    set: (key, value) => stmt.settingSet.run(key, String(value)),
  };

  return { messages, contacts, auth, settings, tx, close: () => db.close() };
}

// One-time import of the v1 JSON store.
export function importLegacyJson(db, file, logger) {
  if (!fs.existsSync(file)) return 0;
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  db.tx(() => {
    for (const m of list) {
      const created = db.messages.create({
        to: String(m.to).replace(/@c\.us$/, '@s.whatsapp.net'), // whatsapp-web.js -> WhatsApp jid
        toName: m.toName || m.to,
        body: m.body,
        sendAt: Date.parse(m.sendAt),
        repeat: m.repeat || 'none',
        repeatDay: m.repeatDay,
      });
      const status = m.status === 'sending' ? 'failed' : m.status;
      db.messages.update(created.id, {
        status,
        error: m.error || null,
        sentAt: m.sentAt ? Date.parse(m.sentAt) : null,
        nextSpawned: status !== 'pending',
      });
    }
  });
  fs.renameSync(file, `${file}.imported`);
  logger?.info({ count: list.length }, 'Imported messages from messages.json');
  return list.length;
}

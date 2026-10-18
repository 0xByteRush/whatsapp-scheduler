// Baileys login state stored in SQLite (Baileys' own file-based store is not meant for production).
import { initAuthCreds, BufferJSON, proto } from 'baileys';

export function useSqliteAuthState(db) {
  const read = (key) => {
    const raw = db.auth.get(key);
    return raw ? JSON.parse(raw, BufferJSON.reviver) : null;
  };
  const write = (key, value) => db.auth.set(key, JSON.stringify(value, BufferJSON.replacer));

  const creds = read('creds') || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          for (const id of ids) {
            let value = read(`${type}:${id}`);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            out[id] = value;
          }
          return out;
        },
        set: async (data) => {
          db.auth.tx(() => {
            for (const category of Object.keys(data)) {
              for (const [id, value] of Object.entries(data[category])) {
                if (value) write(`${category}:${id}`, value);
                else db.auth.del(`${category}:${id}`);
              }
            }
          });
        },
      },
    },
    saveCreds: async () => write('creds', creds),
    clear: () => db.auth.clear(),
  };
}

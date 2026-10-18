// libsignal (Baileys' encryption library) prints whole session records with console.* —
// including private keys. Drop those lines so key material never reaches logs.
// Plain decrypt errors ("Failed to decrypt...", "Session error:...") carry no keys and stay visible.
const SECRET_LINES = /^(Closing session|Opening session|Removing old closed session|Session already (closed|open)|Closing open session|Migrating session|Decrypted message with closed session|Unhandled bucket type)/;

for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const original = console[level].bind(console);
  console[level] = (first, ...rest) => {
    if (typeof first === 'string' && SECRET_LINES.test(first)) return;
    original(first, ...rest);
  };
}

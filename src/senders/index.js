// Every sender implements the same interface:
//   state, isReady(), start(), stop(), resolveRecipient(input) -> { jid, name },
//   newMessageId(), send(jid, text, { messageId }) -> waId | null,
//   requestPairingCode(phone), logout(); emits 'ready', 'ack', 'disconnected', 'logged_out', 'conflict'.
export async function createSender({ config, db, logger }) {
  if (config.sender === 'desktop') {
    const { DesktopSender } = await import('./desktop.js');
    return new DesktopSender({ logger });
  }
  const { BaileysSender } = await import('./baileys.js');
  return new BaileysSender({ db, logger });
}

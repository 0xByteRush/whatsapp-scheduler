// Push alerts (via ntfy.sh or a self-hosted ntfy) when something needs your attention.
// Without ALERT_NTFY_URL, alerts only go to the log.
const THROTTLE_MS = 30 * 60_000;

export function createAlerter({ config, logger }) {
  const lastSent = new Map();

  return async function alert(key, title, message) {
    logger.warn({ alert: key }, `${title}: ${message}`);
    if (!config.alertNtfyUrl) return;

    const now = Date.now();
    if (now - (lastSent.get(key) || 0) < THROTTLE_MS) return;
    lastSent.set(key, now);

    try {
      const res = await fetch(config.alertNtfyUrl, {
        method: 'POST',
        headers: { Title: title, Priority: 'high', Tags: 'warning' },
        body: message,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      logger.error({ err: err.message }, 'Could not deliver alert');
    }
  };
}

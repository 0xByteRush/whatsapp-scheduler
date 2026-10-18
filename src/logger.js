import pino from 'pino';

export function createLogger(level = 'info') {
  return pino({ level, base: undefined, timestamp: pino.stdTimeFunctions.isoTime });
}

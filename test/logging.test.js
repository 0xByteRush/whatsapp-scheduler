import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const moduleUrl = new URL('../src/quiet-libsignal.js', import.meta.url).href;

test('libsignal session dumps (private keys) never reach the console', () => {
  const script = `
    await import(${JSON.stringify(moduleUrl)});
    console.info('Closing session:', { privKey: 'SECRET-1' });
    console.info('Opening session:', { privKey: 'SECRET-2' });
    console.warn('Session already closed', { privKey: 'SECRET-3' });
    console.info('Removing old closed session:', { privKey: 'SECRET-4' });
    console.error('Failed to decrypt message with any known session...');
    console.log('normal line');
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.doesNotMatch(out, /SECRET/);
  assert.match(out, /normal line/);
});

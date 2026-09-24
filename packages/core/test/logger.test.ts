import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/index.ts';

function capture() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, destination };
}

describe('createLogger', () => {
  it('redacts credentials and email bodies at any depth', () => {
    const { lines, destination } = capture();
    const log = createLogger({ service: 'test', destination });
    log.info(
      {
        tenant_id: 't1',
        password: 'hunter2-app-password',
        connection: { credentials: 'sealed-bytes', pass: 'imap-pass' },
        message: {
          headers: { authorization: 'Bearer abc' },
          body_text: 'Dear customer, my card is 4111',
        },
      },
      'processing',
    );
    const out = lines.join('');
    expect(out).toContain('"tenant_id":"t1"');
    for (const leaked of [
      'hunter2-app-password',
      'sealed-bytes',
      'imap-pass',
      'Bearer abc',
      '4111',
    ]) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain('[REDACTED]');
  });
});

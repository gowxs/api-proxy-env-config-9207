import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EnvError, loadEnv } from '../src/index.ts';

const schema = z.object({
  DATABASE_URL: z.url(),
  PORT: z.coerce.number().int().positive(),
});

describe('loadEnv', () => {
  it('parses valid configuration', () => {
    expect(loadEnv(schema, { DATABASE_URL: 'postgres://u:p@h/db', PORT: '8080' })).toEqual({
      DATABASE_URL: 'postgres://u:p@h/db',
      PORT: 8080,
    });
  });

  it('names missing and malformed variables without echoing values', () => {
    const secretLooking = 'not-a-url-but-a-secret-s3cr3t';
    let error: unknown;
    try {
      loadEnv(schema, { DATABASE_URL: secretLooking });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvError);
    const message = (error as EnvError).message;
    expect((error as EnvError).variables.sort()).toEqual(['DATABASE_URL', 'PORT']);
    expect(message).toContain('PORT: required');
    expect(message).not.toContain(secretLooking);
  });
});

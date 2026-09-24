/**
 * Prints a service token for the LOCAL Storage container in
 * docker/compose.dev.yml (signed with its local-only secret). Never use it
 * for the cloud project.
 *   node packages/kb/scripts/local-storage-token.ts
 */
import { createHmac } from 'node:crypto';

const secret =
  process.env.LOCAL_STORAGE_JWT_SECRET ?? 'local-dev-jwt-secret-at-least-32-characters-long';
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'service_role', iss: 'noctiv-local', iat: now, exp: now + 365 * 86_400 })}`;
console.log(`${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`);

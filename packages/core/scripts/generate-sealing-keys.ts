/**
 * Generates the credential sealing key pair.
 *   node packages/core/scripts/generate-sealing-keys.ts secrets/sealing-private.key
 * Prints the public key (for the API's CREDENTIALS_PUBLIC_KEY) and writes the
 * private key to the given file with 0600 permissions (worker only).
 */
import { writeFileSync } from 'node:fs';
import { generateSealingKeyPair, sealingKeyId } from '../src/crypto/sealed-box.ts';

const target = process.argv[2];
if (!target) {
  console.error('usage: generate-sealing-keys.ts <private-key-output-file>');
  process.exit(1);
}
const pair = generateSealingKeyPair();
writeFileSync(target, `${pair.privateKey}\n`, { mode: 0o600, flag: 'wx' });
console.log(`CREDENTIALS_PUBLIC_KEY=${pair.publicKey}`);
console.log(`# key id: ${sealingKeyId(pair.publicKey)}; private key written to ${target}`);

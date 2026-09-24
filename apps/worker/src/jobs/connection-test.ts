import { JobError, type Job } from '@noctiv/db';
import {
  openMailboxPassword,
  testMailConnection,
  type ConnectionTestResult,
  type MailServerSettings,
} from '@noctiv/mail';

export interface ConnectionTestDeps {
  keys: { publicKey: string; privateKey: string };
  allowInsecure: boolean;
}

/**
 * Worker side of the wizard's live test: the only place the password is
 * decrypted. The result never contains the password or the ciphertext.
 */
export function connectionTestHandler(deps: ConnectionTestDeps) {
  return async (job: Job): Promise<ConnectionTestResult> => {
    const p = job.payload as { connectionId: string; settings: MailServerSettings; sealed: string };
    let password: string;
    try {
      password = openMailboxPassword(
        Buffer.from(p.sealed, 'base64'),
        deps.keys,
        job.tenantId,
        p.connectionId,
      );
    } catch {
      throw new JobError('sealed credentials could not be opened', { retryable: false });
    }
    return testMailConnection(p.settings, password, { allowInsecure: deps.allowInsecure });
  };
}

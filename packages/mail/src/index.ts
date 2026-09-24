export { connectImap, createSmtpTransport, verifySmtp } from './clients.ts';
export { openMailboxPassword, sealMailboxPassword } from './credentials.ts';
export { resolveMailEndpoint, type ResolvedEndpoint } from './endpoint.ts';
export {
  classifyImapError,
  classifySmtpError,
  MAIL_ERROR_MESSAGES,
  MailConnectError,
  safeDetail,
  type MailErrorCode,
} from './errors.ts';
export {
  isUnsupportedProvider,
  PRESETS,
  resolveSettings,
  savesSentAutomatically,
} from './presets.ts';
export { testMailConnection, type ConnectionTestResult } from './test-connection.ts';
export type { ConnectOptions, MailProvider, MailServerSettings } from './types.ts';
export { fetchNewMessages, MAX_MESSAGE_BYTES, type FetchBatch, type InboxState } from './fetch.ts';
export { parseInbound, type InboundMessage } from './parse.ts';

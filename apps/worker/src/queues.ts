/** Queue names shared by producers and the worker. */
export const QUEUES = {
  connectionTest: 'connection.test',
  mailFetch: 'mail.fetch',
  mailProcess: 'mail.process',
  mailSend: 'mail.send',
  kbIngest: 'kb.ingest',
} as const;

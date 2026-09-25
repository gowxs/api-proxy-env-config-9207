/** Queue names shared by producers and the worker. */
export const QUEUES = {
  connectionTest: 'connection.test',
  mailFetch: 'mail.fetch',
  mailProcess: 'mail.process',
  mailSend: 'mail.send',
  kbIngest: 'kb.ingest',
  followup: 'followup.generate',
  healthCheck: 'connection.health',
  tenantDelete: 'tenant.delete',
  quotesImport: 'quotes.import',
} as const;

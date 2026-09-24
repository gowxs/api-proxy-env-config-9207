/** Owner-facing wording for knowledge-source errors ("reason" or "reason:detail"). */
const DETAIL: Record<string, string> = {
  rate_limited: 'The AI service is busy (per-minute limit).',
  quota_exhausted: 'The daily AI allowance is used up; it resets tomorrow.',
  auth: 'The AI service rejected our credentials. We have been notified.',
  invalid_request: 'The AI service rejected the request.',
  unavailable: 'The AI service is temporarily unavailable.',
  timeout: 'The AI service took too long to answer.',
  not_found: 'The configured AI model is not available.',
};

const REASON: Record<string, string> = {
  embedding_failed: 'The text could not be prepared for search.',
  fetch_failed:
    'The website could not be read (unreachable, blocked by robots.txt, or no pages found).',
  extraction_failed: 'The text could not be extracted from this file.',
  no_text: 'No readable text was found.',
  upload_missing: 'The uploaded file is no longer available; please upload it again.',
  budget_halted: "Today's AI budget is used up; it resumes tomorrow.",
  free_tier_customer_data:
    'Not processed: the free AI tier may only be used while all connected mailboxes are test mailboxes.',
  source_not_found: 'This source no longer exists.',
};

export function kbErrorText(error: string | null | undefined): string | null {
  if (!error) return null;
  const [reason = '', detail] = error.split(':');
  const main = REASON[reason] ?? reason.replace(/_/g, ' ');
  const extra = detail ? (DETAIL[detail] ?? detail.replace(/_/g, ' ')) : null;
  return extra ? `${main} ${extra}` : main;
}

/**
 * Puts Supabase Auth's e-mails (sign-in link, confirmation, recovery, …) in
 * the Noctiv brand shell: the header from packages/brand and a white card.
 * The text and every {{ .Variable }} of each template are kept as they are.
 * Idempotent: the shell is marked and replaced on each run.
 *   node --env-file=.env scripts/brand-auth-emails.ts   (SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF)
 */
const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF;
if (!token || !ref) throw new Error('SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are required');
const url = `https://api.supabase.com/v1/projects/${ref}/config/auth`;
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

const START = '<!-- noctiv-brand:start -->';
const END = '<!-- noctiv-brand:end -->';
const HEADER = 'https://noctiv.io/brand/email-header.png';

const shell = (inner: string) =>
  `<div style="margin:0;padding:16px 8px;background:#F5F6FA">` +
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">` +
  `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden">` +
  `<tr><td style="background:#0B1026"><img src="${HEADER}" width="600" height="80" alt="Noctiv" style="display:block;width:100%;max-width:600px;height:auto;border:0;color:#EEF1FA;font:800 22px system-ui,sans-serif"></td></tr>` +
  `<tr><td style="padding:20px 24px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#131A2E">` +
  `${START}${inner}${END}` +
  `<p style="color:#646C8A;font-size:13px;margin-bottom:0">Noctiv, the e-mail assistant that works while you sleep. noctiv.io</p>` +
  `</td></tr></table></td></tr></table></div>`;

/** The template's own content, without a previous shell and link styling. */
const unwrap = (html: string) => {
  const i = html.indexOf(START);
  const j = html.indexOf(END);
  const inner = i >= 0 && j > i ? html.slice(i + START.length, j) : html;
  return inner.replace(/<a style="[^"]*" href=/g, '<a href=');
};
const styleLinks = (html: string) =>
  html.replace(
    /<a href=/g,
    '<a style="display:inline-block;padding:10px 16px;border-radius:6px;background:#3B2FD0;color:#ffffff;text-decoration:none;font-weight:600" href=',
  );

const res = await fetch(url, { headers });
if (!res.ok) throw new Error(`read auth config: ${res.status}`);
const config = (await res.json()) as Record<string, unknown>;
const patch: Record<string, string> = {};
for (const [key, value] of Object.entries(config)) {
  if (!key.startsWith('mailer_templates_') || !key.endsWith('_content')) continue;
  if (typeof value !== 'string' || !value.trim()) continue;
  patch[key] = shell(styleLinks(unwrap(value)));
}
const put = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(patch) });
if (!put.ok) throw new Error(`update auth config: ${put.status} ${await put.text()}`);
console.log(`branded ${Object.keys(patch).length} auth e-mail templates`);

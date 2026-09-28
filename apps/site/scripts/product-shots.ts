/**
 * Real product screenshots for the home page (phone size), from the local dev
 * stack with demo data. Writes src/images/shot-*.webp (committed).
 *
 *   pnpm dev:stack                         (in another terminal; demo business)
 *   node apps/site/scripts/product-shots.ts
 *
 * Example data is created for the shots (customer "Anna Berg"), so no real
 * or test names end up on the site. The invoice PDF page is rasterised with
 * PyMuPDF (python3; set PYTHONPATH if it is installed elsewhere).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import postgres from 'postgres';
import { renderNotificationEmail } from '../../worker/src/notify/templates.ts';

const APP = process.env.APP_URL ?? 'http://localhost:3000';
const API = process.env.API_URL ?? 'http://localhost:4000';
const OWNER_DB = process.env.OWNER_DB ?? 'postgres://postgres:postgres@localhost:54322/postgres';
const OUT = join(import.meta.dirname, '..', 'src/images');
const DEV_USER = 'd0e10000-0000-4000-8000-000000000001';

const sql = postgres(OWNER_DB, { onnotice: () => {} });
const [member] = await sql<{ tenant_id: string }[]>`
  select tenant_id from public.tenant_members where user_id = ${DEV_USER}`;
if (!member)
  throw new Error('No demo business: start the dev stack with demo data (pnpm dev:stack).');
const tenantId = member.tenant_id;

// --- The API as the demo owner (dev login).
const { accessToken } = (await (await fetch(`${API}/dev/login`, { method: 'POST' })).json()) as {
  accessToken: string;
};
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const r = await fetch(`${API}/v1/tenants/${tenantId}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return (r.headers.get('content-type')?.includes('json') ? r.json() : r.arrayBuffer()) as T;
};

// --- Example invoice: Anna Berg, website development, €290 + VAT, due in 7 days.
const { id: docId } = await api<{ id: string }>('POST', '/documents', { type: 'invoice' });
const draft = await api<{ data: Record<string, unknown> }>('GET', `/documents/${docId}`);
const due = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
await api('PATCH', `/documents/${docId}`, {
  data: {
    ...draft.data,
    buyer: {
      name: 'Anna Berg',
      address: 'Brīvības iela 1, Rīga, LV-1010',
      regNo: '',
      vatNo: '',
      email: 'anna@example.com',
    },
    lines: [{ name: 'Website development', unit: 'pcs', qty: 1, unitPriceCents: 29000 }],
    dueDate: due,
  },
});
const issued = await api<{ number: string }>('POST', `/documents/${docId}/issue`, {});
const pdf = Buffer.from(await api<ArrayBuffer>('GET', `/documents/${docId}/pdf`));

// --- Example assistant conversation (the owner's words, the invoice card waiting for Confirm).
const [conv] = await sql<{ id: string }[]>`
  insert into public.assistant_conversations (tenant_id, user_id, purpose)
  values (${tenantId}, ${DEV_USER}, 'app') returning id`;
await sql`insert into public.assistant_messages (tenant_id, conversation_id, role, text)
          values (${tenantId}, ${conv!.id}, 'owner', 'Send Anna an invoice for €290, due in 7 days.')`;
const [answer] = await sql<{ id: string }[]>`
  insert into public.assistant_messages (tenant_id, conversation_id, role, text)
  values (${tenantId}, ${conv!.id}, 'assistant',
          'Here are the invoice for Anna Berg and the e-mail to her. Nothing is created or sent until you confirm.')
  returning id`;
const [card] = await sql<{ id: string }[]>`
  insert into public.assistant_proposals (tenant_id, conversation_id, message_id, type, title, payload)
  values (${tenantId}, ${conv!.id}, ${answer!.id}, 'create_document', 'Invoice for Anna Berg',
          ${sql.json({
            docType: 'invoice',
            buyer: {
              leadId: null,
              name: 'Anna Berg',
              email: 'anna@example.com',
              address: 'Brīvības iela 1, Rīga, LV-1010',
              regNo: '',
              vatNo: '',
              threadId: null,
            },
            lines: [{ name: 'Website development', unit: 'pcs', qty: 1, unitPriceCents: 29000 }],
            withPrices: true,
            dueDate: due,
            currency: 'EUR',
            vatMode: 'exclusive',
            vatRate: 21,
            totals: { subtotalCents: 29000, vatCents: 6090, totalCents: 35090 },
          })})
  returning id`;
await sql`insert into public.assistant_proposals (tenant_id, conversation_id, message_id, type, title, payload,
                                                  requires_confirmation)
          values (${tenantId}, ${conv!.id}, ${answer!.id}, 'send_email', 'E-mail to Anna Berg',
                  ${sql.json({
                    to: 'anna@example.com',
                    name: 'Anna Berg',
                    subject: 'Invoice for website development',
                    body: 'Hello Anna,\n\nplease find your invoice attached.\n\nKind regards,\nNordlicht Candles',
                    documentIds: [],
                    attachLabels: [
                      'The new invoice for Anna Berg, €350.90 (once you confirm it above)',
                    ],
                    attachProposalId: card!.id,
                  })}, true)`;
await sql.end();

// --- Screenshots at 390 × 844, stored as 360 × 780 (shown) at 2× for sharp phones.
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  locale: 'en-GB',
  timezoneId: 'Europe/Riga',
});
const page = await ctx.newPage();

async function save(p: Page, name: string, png: Buffer, height = 780) {
  const webp = await p.evaluate(
    async ([dataUrl, h]) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = 720;
      c.height = h * 2;
      const g = c.getContext('2d')!;
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/webp', 0.82);
    },
    [`data:image/png;base64,${png.toString('base64')}`, height] as const,
  );
  const buf = Buffer.from(webp.split(',')[1]!, 'base64');
  writeFileSync(join(OUT, `${name}.webp`), buf);
  console.log(`${name}.webp ${Math.round(buf.length / 1024)} KB`);
}

await page.goto(`${APP}/login`);
await page.getByRole('button', { name: /Sign in as the demo owner/ }).click();
await page.waitForURL(`${APP}/`);
await page.getByText('This month').waitFor();
await page.waitForTimeout(1200);
await save(page, 'shot-dashboard', await page.screenshot());

await page.getByRole('button', { name: 'Noctiv Assistant' }).click();
await page.getByText('Invoice for Anna Berg', { exact: true }).waitFor();
await page.waitForTimeout(800);
// Start the conversation at the owner's message.
await page.evaluate(() => {
  const list = document.querySelector('[aria-live=polite]');
  if (list) list.scrollTop = 0;
});
await page.waitForTimeout(400);
await save(page, 'shot-assistant', await page.screenshot());

// The Monday summary, rendered by the same code that sends it (example numbers).
const week = {
  answered: 38,
  avgReplySeconds: 4 * 60,
  avgBusinessHoursSeconds: 9 * 3600,
  outsideHoursShare: 0.42,
  followupsSent: 11,
  wonBack: 4,
  quotesSent: [{ currency: 'EUR', count: 6, totalCents: 214_500 }],
  quotesAccepted: [{ currency: 'EUR', count: 3, totalCents: 98_000 }],
  invoicesPaid: [{ currency: 'EUR', count: 5, totalCents: 131_090 }],
  minutesSaved: 38 * 4 + 11 * 3,
  assumptions: { minutesPerReply: 4, minutesPerFollowup: 3 },
};
const email = renderNotificationEmail({
  id: 'example',
  tenantId,
  tenantName: 'Nordlicht Candles',
  audience: 'owner',
  kind: 'weekly_report',
  payload: {
    weekLabel: '21 – 27 September 2026',
    monthLabel: 'September',
    highlight: 'Fastest reply: 41 seconds at 23:12 on Tuesday',
    week,
    month: {
      ...week,
      answered: 142,
      followupsSent: 37,
      wonBack: 12,
      minutesSaved: 142 * 4 + 37 * 3,
    },
  },
  links: { dashboard: 'https://app.noctiv.io/', unsubscribe: 'https://app.noctiv.io/' },
});
await page.setContent(
  email.html ??
    `<pre style="font:15px/1.5 system-ui;padding:16px;white-space:pre-wrap">${email.text}</pre>`,
);
await page.waitForTimeout(400);
await save(page, 'shot-weekly', await page.screenshot());

// The invoice PDF as a phone shows it: the first page, full width.
const dir = mkdtempSync(join(tmpdir(), 'noctiv-shots-'));
writeFileSync(join(dir, 'invoice.pdf'), pdf);
execFileSync('python3', [
  '-c',
  `import pymupdf, sys
d = pymupdf.open(sys.argv[1]); p = d[0]
p.get_pixmap(dpi=150).save(sys.argv[2])`,
  join(dir, 'invoice.pdf'),
  join(dir, 'invoice.png'),
]);
const pageImg = readFileSync(join(dir, 'invoice.png')).toString('base64');
await page.setContent(
  `<body style="margin:0;background:#3a3f4b;font:13px system-ui;color:#fff">` +
    `<div style="padding:14px 16px;background:#23262e">${issued.number}.pdf</div>` +
    `<img src="data:image/png;base64,${pageImg}" style="display:block;width:calc(100% - 16px);margin:12px auto;box-shadow:0 2px 8px rgb(0 0 0/.4)"></body>`,
);
await page.waitForTimeout(400);
// A4 is shorter than a phone screen: the viewer and the page only (390 × 594 → 360 × 548).
await page.setViewportSize({ width: 390, height: 594 });
await page.waitForTimeout(200);
await save(page, 'shot-invoice', await page.screenshot(), 548);

await browser.close();

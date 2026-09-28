/**
 * The small product screenshots of the home page's "From e-mail to paid" flow
 * and the Monday e-mail for the mail-app frame, from the local dev stack with
 * example data (customers "Sarah Miller" and "Anna Berg"; no real names).
 * Writes src/images/mini-*.webp and mail-weekly.webp (committed).
 *
 *   pnpm dev:stack                          (in another terminal; demo business)
 *   node apps/site/scripts/home-shots.ts
 *
 * PDFs are rasterised with PyMuPDF (python3 -m pip install pymupdf).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderQuotePdf } from '../../../packages/quotes/src/index.ts';
import { chromium, type Page } from 'playwright-core';
import postgres from 'postgres';
import { renderNotificationEmail } from '../../worker/src/notify/templates.ts';

const APP = process.env.APP_URL ?? 'http://localhost:3000';
const API = process.env.API_URL ?? 'http://localhost:4000';
const OWNER_DB = process.env.OWNER_DB ?? 'postgres://postgres:postgres@localhost:54322/postgres';
const OUT = join(import.meta.dirname, '..', 'src/images');
const DEV_USER = 'd0e10000-0000-4000-8000-000000000001';
const BUSINESS = 'Nordlicht Candles';

const sql = postgres(OWNER_DB, { onnotice: () => {} });
const [member] = await sql<{ tenant_id: string }[]>`
  select tenant_id from public.tenant_members where user_id = ${DEV_USER}`;
if (!member)
  throw new Error('No demo business: start the dev stack with demo data (pnpm dev:stack).');
const tenantId = member.tenant_id;
const [conn] = await sql<{ id: string }[]>`
  select id from public.email_connections where tenant_id = ${tenantId} order by created_at limit 1`;

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

// --- 1. A customer's question at night and Noctiv's draft reply.
const [lead] = await sql<{ id: string }[]>`
  insert into public.leads (tenant_id, email, name) values (${tenantId}, 'sarah@example.com', 'Sarah Miller')
  on conflict (tenant_id, email) do update set name = excluded.name, last_activity_at = now() returning id`;
const [thread] = await sql<{ id: string }[]>`
  insert into public.threads (tenant_id, connection_id, lead_id, subject, status)
  values (${tenantId}, ${conn!.id}, ${lead!.id}, 'Lavender candles for a wedding', 'open') returning id`;
const [msg] = await sql<{ id: string }[]>`
  insert into public.messages (tenant_id, connection_id, thread_id, direction, message_id_header, reference_ids,
                               from_address, from_name, subject, body_text, received_at)
  values (${tenantId}, ${conn!.id}, ${thread!.id}, 'inbound', ${`<example-${Date.now()}@example.com>`}, '{}',
          'sarah@example.com', 'Sarah Miller', 'Lavender candles for a wedding',
          'Hi, do you have 20 lavender soy candles for a wedding on 14 June, and what would they cost?',
          now() - interval '8 hours')
  returning id`;
await sql`insert into public.message_processing (tenant_id, message_id, status, classification)
          values (${tenantId}, ${msg!.id}, 'drafted',
                  ${sql.json({ summary: 'Asks for 20 lavender soy candles for a wedding on 14 June and the price.' })})`;
await sql`
  insert into public.drafts (tenant_id, thread_id, source_message_id, kind, to_address, subject, body, status)
  values (${tenantId}, ${thread!.id}, ${msg!.id}, 'reply', 'sarah@example.com', 'Re: Lavender candles for a wedding',
          ${'Hi Sarah,\n\nyes, we can make 20 lavender soy candles for 14 June. They are €24 each, €480 for twenty, and we deliver within 3 business days.\n\nShall I send you a quote to accept online?'},
          'pending_approval')`;
await sql.end();

// --- 2. The quote PDF (the product's own renderer, example numbers).
const quotePdf = await renderQuotePdf({
  number: 'Q-2026-0042',
  language: 'en',
  createdAt: new Date('2026-09-28T09:00:00Z'),
  validUntil: new Date('2026-10-12T09:00:00Z'),
  customer: { name: 'Sarah Miller', email: 'sarah@example.com' },
  currency: 'EUR',
  vatMode: 'exclusive',
  vatRatePercent: 21,
  lines: [
    {
      name: 'Lavender soy candle',
      unit: 'pcs',
      qty: 20,
      unitPriceCents: 2400,
      lineTotalCents: 48000,
      vatNote: null,
    },
  ],
  subtotalCents: 48000,
  vatCents: 10080,
  totalCents: 58080,
  notes: null,
  acceptUrl: 'https://app.noctiv.io/q/example',
  brand: {
    companyName: BUSINESS,
    color: '#B4532A',
    website: null,
    phone: null,
    address: 'Brīvības iela 1, Rīga',
    logo: null,
  },
});

// --- 3. The invoice (issued through the API, like a real one), then marked paid.
const { id: docId } = await api<{ id: string }>('POST', '/documents', { type: 'invoice' });
const draft = await api<{ data: Record<string, unknown> }>('GET', `/documents/${docId}`);
await api('PATCH', `/documents/${docId}`, {
  data: {
    ...draft.data,
    buyer: {
      name: 'Sarah Miller',
      address: 'Hauptstraße 5, Berlin',
      regNo: '',
      vatNo: '',
      email: 'sarah@example.com',
    },
    lines: [{ name: 'Lavender soy candle', unit: 'pcs', qty: 20, unitPriceCents: 2400 }],
    dueDate: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
  },
});
await api('POST', `/documents/${docId}/issue`, {});
const invoicePdf = Buffer.from(await api<ArrayBuffer>('GET', `/documents/${docId}/pdf`));
await api('POST', `/documents/${docId}/mark`, { status: 'paid' });

/** The top of a PDF's first page as a PNG (the part a thumbnail shows). */
function pdfTop(pdf: Buffer): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'noctiv-home-'));
  writeFileSync(join(dir, 'in.pdf'), pdf);
  execFileSync('python3', [
    '-c',
    `import pymupdf, sys
d = pymupdf.open(sys.argv[1]); p = d[0]; r = p.rect
p.get_pixmap(dpi=144, clip=pymupdf.Rect(0, 0, r.width, r.width * 1.1)).save(sys.argv[2])`,
    join(dir, 'in.pdf'),
    join(dir, 'out.png'),
  ]);
  return readFileSync(join(dir, 'out.png'));
}

// --- Screenshots.
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

/** Encodes a PNG as WebP at the given CSS size (2× pixels). */
async function save(p: Page, name: string, png: Buffer, w: number, h: number) {
  const webp = await p.evaluate(
    async ([dataUrl, w, h]) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = w * 2;
      c.height = h * 2;
      const g = c.getContext('2d')!;
      g.imageSmoothingQuality = 'high';
      // Cover: fill the box, keep the top.
      const s = Math.max(c.width / img.width, c.height / img.height);
      g.drawImage(img, (c.width - img.width * s) / 2, 0, img.width * s, img.height * s);
      return c.toDataURL('image/webp', 0.8);
    },
    [`data:image/png;base64,${png.toString('base64')}`, w, h] as const,
  );
  const buf = Buffer.from(webp.split(',')[1]!, 'base64');
  writeFileSync(join(OUT, `${name}.webp`), buf);
  console.log(`${name}.webp ${Math.round(buf.length / 1024)} KB`);
}

await page.goto(`${APP}/login`);
await page.getByRole('button', { name: /Sign in as the demo owner/ }).click();
await page.waitForURL('**/home');

// Reply: the conversation with the draft, the part with the customer's question and the reply.
await page.goto(`${APP}/conversations/${thread!.id}`);
await page.getByText('Shall I send you a quote').waitFor();
await page.waitForTimeout(800);
const draftBox = page
  .getByText('Shall I send you a quote')
  .locator('xpath=ancestor::*[self::section or self::article or self::div][3]');
// The dev stack's mailbox address reads as an example address.
await page.evaluate(() => {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());)
    n.nodeValue = n.nodeValue!.replace(/shop@demo\.test/g, 'hello@nordlicht.example');
});
await draftBox.scrollIntoViewIfNeeded();
await save(page, 'mini-reply', await draftBox.screenshot(), 240, 300);

// Paid: the invoice in the app with its status.
await page.goto(`${APP}/documents/${docId}`);
await page.getByText('Paid', { exact: true }).first().waitFor();
await page.waitForTimeout(800);
// Only the invoice's own card (number, customer, total, Paid); the editor below is not the point.
await page.evaluate(() => {
  const badge = [...document.querySelectorAll('span, div')].find(
    (e) => e.textContent?.trim() === 'Paid' && e.children.length === 0,
  );
  let card = badge?.parentElement;
  while (card && card.parentElement && card.parentElement.children.length < 2)
    card = card.parentElement;
  while (card && card.parentElement && !/rounded/.test(card.className)) card = card.parentElement;
  let next = card?.nextElementSibling;
  while (next) {
    const n = next.nextElementSibling;
    next.remove();
    next = n;
  }
});
await save(page, 'mini-paid', await page.screenshot(), 240, 300);

// Quote and invoice: the top of each PDF.
await save(page, 'mini-quote', pdfTop(quotePdf), 360, 450);
await save(page, 'mini-invoice', pdfTop(invoicePdf), 360, 450);

// The Monday e-mail at a mail app's reading width.
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
  tenantName: BUSINESS,
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
await page.setViewportSize({ width: 600, height: 760 });
await page.setContent(email.html ?? `<pre>${email.text}</pre>`);
await page.waitForTimeout(400);
await save(page, 'mail-weekly', await page.screenshot(), 600, 760);

await browser.close();

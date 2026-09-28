import { randomUUID } from 'node:crypto';
import {
  createFakeGoogleCalendar,
  openCalendarToken,
  signFormLink,
  signManageToken,
  signReplyLink,
} from '@noctiv/bookings';
import { createLogger, generateSealingKeyPair } from '@noctiv/core';
import { seedTenant, type SeededTenant } from '@noctiv/db/testing';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { createTokenVerifier } from '../src/auth.ts';
import { testAuth } from './helpers.ts';

const SECRET = 'b'.repeat(40);
const keys = generateSealingKeyPair();
const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const apiSql = postgres(inject('apiDatabaseUrl'), { max: 6, onnotice: () => {} });
const google = createFakeGoogleCalendar();
let auth: Awaited<ReturnType<typeof testAuth>>;
let app: ReturnType<typeof buildApp>;
let A: SeededTenant;
let B: SeededTenant;

beforeAll(async () => {
  auth = await testAuth();
  app = buildApp({
    logger: createLogger({ service: 'api-test', level: process.env.TEST_LOG ?? 'silent' }),
    sql: apiSql,
    checkDatabase: async () => true,
    verifyToken: createTokenVerifier({ jwks: auth.jwks }),
    credentialsPublicKey: keys.publicKey,
    connectionTestWaitMs: 1_000,
    actionSecret: SECRET,
    appUrl: 'https://app.noctiv.test',
    publicApiUrl: 'https://app.noctiv.test/api',
    rateLimits: false,
    google,
    bookingWaitMs: 1_500,
  });
  A = await seedTenant(owner, 'book-a', { embeddingAxis: 150 });
  B = await seedTenant(owner, 'book-b', { embeddingAxis: 151 });
  // Seeded calendars are fake rows; these tests start without one.
  await owner`delete from public.calendar_connections where tenant_id in (${A.tenantId}, ${B.tenantId})`;
  await owner`delete from public.calendar_busy where tenant_id in (${A.tenantId}, ${B.tenantId})`;
  await owner`delete from public.bookings where tenant_id in (${A.tenantId}, ${B.tenantId})`;
});
afterAll(() => Promise.all([owner.end(), apiSql.end()]));

async function call(
  method: 'GET' | 'PATCH' | 'POST' | 'DELETE',
  s: SeededTenant,
  path: string,
  body?: unknown,
) {
  const res = await app.inject({
    method,
    url: `/v1/tenants/${s.tenantId}${path}`,
    headers: { authorization: `Bearer ${await auth.token(s.userId)}` },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: res.statusCode, json: res.body ? res.json() : undefined };
}

const page = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers });
const post = (url: string, form: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(form).toString(),
  });

/** The first free time link on a times page. */
const firstSlot = (html: string) => {
  const m = /href="(\/book\/[^"]+\/t\/[^"?]+)(\?[^"]*)?"/.exec(html);
  if (!m) throw new Error('no free time on the page');
  return (m[1] + (m[2] ?? '')).replace(/&amp;/g, '&');
};

/** Plays the worker: confirms the pending booking once the page is waiting. */
function confirmSoon(tenantId: string, status: 'confirmed' | 'taken' = 'confirmed') {
  return (async () => {
    for (let i = 0; i < 40; i++) {
      const [b] = await owner<{ id: string }[]>`
        select id from public.bookings where tenant_id = ${tenantId} and status = 'pending' order by created_at desc limit 1`;
      if (b) {
        await owner`update public.bookings set status = ${status}, confirmed_at = now() where id = ${b.id}`;
        if (status === 'confirmed')
          await owner`update public.bookings set status = 'rescheduled'
                      where id = (select rescheduled_from from public.bookings where id = ${b.id})`;
        return b.id;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  })();
}

let slug = '';

describe('setup', () => {
  it('turning Bookings on gives a page address from the name', async () => {
    expect((await call('PATCH', A, '', { bookingsEnabled: true })).status).toBe(200);
    const s = await call('GET', A, '/bookings/setup');
    expect(s.json).toMatchObject({ enabled: true, googleConfigured: true, calendar: null });
    slug = s.json.slug;
    expect(slug).toMatch(/^tenant-book-a/);
    expect(s.json.pageUrl).toBe(`https://app.noctiv.test/book/${slug}`);
    expect(s.json.problems).toContain('online_link_missing');
  });

  it('validates settings and the address', async () => {
    expect((await call('PATCH', A, '/bookings/setup', { slotMinutes: 5 })).status).toBe(400);
    expect((await call('PATCH', A, '/bookings/setup', { slug: 'help' })).status).toBe(400);
    expect((await call('PATCH', A, '/bookings/setup', { slug: 'Bad slug' })).status).toBe(400);
    await call('PATCH', B, '', { bookingsEnabled: true });
    const bSlug = (await call('GET', B, '/bookings/setup')).json.slug;
    expect((await call('PATCH', A, '/bookings/setup', { slug: bSlug })).status).toBe(409);
    const ok = await call('PATCH', A, '/bookings/setup', {
      locationKind: 'online_link',
      locationText: 'https://meet.example.com/a',
      meetingTitle: 'Intro call',
      noticeHours: 0,
      formId: null,
      hours: Object.fromEntries(
        ['1', '2', '3', '4', '5', '6', '7'].map((d) => [d, [{ from: '00:00', to: '23:30' }]]),
      ),
    });
    expect(ok.status).toBe(200);
    expect(ok.json.problems).toEqual([]);
  });
});

describe('booking page', () => {
  it('is closed until the setup is complete, and 404 for unknown or switched-off pages', async () => {
    const bSlug = (await call('GET', B, '/bookings/setup')).json.slug;
    expect((await page(`/book/${bSlug}`)).statusCode).toBe(503);
    expect((await page('/book/no-such-business')).statusCode).toBe(404);
  });

  it('shows free times in the customer language, without script', async () => {
    const res = await page(`/book/${slug}`, { 'accept-language': 'de-DE,de;q=0.9' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.body).toContain('Termin bei');
    expect(res.body).toContain('Intro call');
    expect(res.body).not.toMatch(/<script/i);
    firstSlot(res.body);
  });

  it('checks the details, books, and lands on the manage link once confirmed', async () => {
    const slotUrl = firstSlot((await page(`/book/${slug}`)).body);
    const bad = await post(slotUrl, { name: '', email: 'nope' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('Please enter a valid e-mail address.');

    const worker = confirmSoon(A.tenantId);
    const ok = await post(slotUrl, {
      name: 'Anna Berg',
      email: 'Anna@Example.com',
      note: 'About the shop',
    });
    const id = await worker;
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toMatch(new RegExp(`^/book/${slug}/manage/b1\\.[^?]+\\?done=1$`));
    const [b] =
      await owner`select name, email, note, status, source from public.bookings where id = ${id}`;
    expect(b).toMatchObject({
      name: 'Anna Berg',
      email: 'anna@example.com',
      note: 'About the shop',
      status: 'confirmed',
      source: 'page',
    });
    const [job] =
      await owner`select queue from public.jobs where tenant_id = ${A.tenantId} and payload->>'bookingId' = ${id}`;
    expect(job).toMatchObject({ queue: 'bookings.confirm' });

    const done = await page(ok.headers.location as string);
    expect(done.body).toContain('You&#39;re booked');
    expect(done.body).toContain('https://meet.example.com/a');

    // The time is gone for the next visitor, and booking it again is refused.
    const again = await post(slotUrl, { name: 'Bob', email: 'bob@example.com' });
    expect(again.statusCode).toBe(409);
    expect(again.body).toContain('That time was just taken');
  });

  it('waits with "almost done" when the worker is slow, and stores nothing for a filled honeypot', async () => {
    const slotUrl = firstSlot((await page(`/book/${slug}`)).body);
    const slow = await post(slotUrl, { name: 'Cara', email: 'cara@example.com' });
    expect(slow.statusCode).toBe(202);
    expect(slow.body).toContain('Almost done');
    const [count] = await owner<
      { n: number }[]
    >`select count(*)::int as n from public.bookings where tenant_id = ${A.tenantId}`;
    const bot = await post(firstSlot((await page(`/book/${slug}`)).body), {
      name: 'x',
      email: 'x@example.com',
      website: 'spam',
    });
    expect(bot.statusCode).toBe(200);
    const [after] = await owner<
      { n: number }[]
    >`select count(*)::int as n from public.bookings where tenant_id = ${A.tenantId}`;
    expect(after!.n).toBe(count!.n);
    // The worker never ran for Cara's booking: out of the way for the next tests.
    await owner`update public.bookings set status = 'taken' where tenant_id = ${A.tenantId} and status = 'pending'`;
  });

  it('ties a booking from a reply link to the lead and thread', async () => {
    const r = signReplyLink(
      { tenantId: A.tenantId, leadId: A.leadId, threadId: A.threadId, language: 'lv' },
      SECRET,
    );
    const list = await page(`/book/${slug}?r=${encodeURIComponent(r)}`);
    expect(list.body).toContain('Pierakstīties pie');
    const slotUrl = firstSlot(list.body);
    const form = await page(slotUrl);
    expect(form.body).toContain('value="customer-book-a@example.test"');
    const worker = confirmSoon(A.tenantId);
    await post(slotUrl, { name: 'Customer', email: 'customer-book-a@example.test' });
    const id = await worker;
    const [b] =
      await owner`select lead_id, thread_id, language, source from public.bookings where id = ${id}`;
    expect(b).toMatchObject({
      lead_id: A.leadId,
      thread_id: A.threadId,
      language: 'lv',
      source: 'reply',
    });
    // Another business's reply link is ignored.
    const other = signReplyLink({ tenantId: B.tenantId, leadId: B.leadId }, SECRET);
    expect((await page(`/book/${slug}?r=${encodeURIComponent(other)}`)).body).not.toContain(
      'Pierakstīties',
    );
  });
});

describe('manage link', () => {
  const booking = async () => {
    const [b] = await owner<{ id: string; ends_at: Date }[]>`
      select id, ends_at from public.bookings where tenant_id = ${A.tenantId} and status = 'confirmed'
      order by created_at limit 1`;
    return {
      ...b!,
      token: signManageToken(
        { tenantId: A.tenantId, bookingId: b!.id, endsAt: b!.ends_at },
        SECRET,
      ),
    };
  };

  it('offers an .ics, and refuses other businesses and bad links', async () => {
    const b = await booking();
    const ics = await page(`/book/${slug}/manage/${b.token}/ics`);
    expect(ics.headers['content-type']).toContain('text/calendar');
    expect(ics.body).toContain(`UID:${b.id}@noctiv.io`);
    const bSlug = (await call('GET', B, '/bookings/setup')).json.slug;
    expect((await page(`/book/${bSlug}/manage/${b.token}`)).statusCode).toBe(404);
    expect((await page(`/book/${slug}/manage/b1.x.y`)).statusCode).toBe(404);
  });

  it('moves a booking to another time', async () => {
    const b = await booking();
    const times = await page(`/book/${slug}/manage/${b.token}/times`);
    expect(times.body).toContain('Choose another time');
    const m = /href="(\/book\/[^"]+\/manage\/[^"]+\/t\/[^"?]+)"/.exec(times.body);
    const confirmPage = await page(m![1]!);
    expect(confirmPage.body).toContain('Move my booking');
    const worker = confirmSoon(A.tenantId);
    const moved = await post(m![1]!, {});
    const newId = await worker;
    expect(moved.statusCode).toBe(303);
    expect(moved.headers.location).toContain('?moved=1');
    const [nb] = await owner`select rescheduled_from from public.bookings where id = ${newId}`;
    expect(nb!.rescheduled_from).toBe(b.id);
    const [old] = await owner`select status from public.bookings where id = ${b.id}`;
    expect(old!.status).toBe('rescheduled');
  });

  it('cancels after a confirmation step and queues the e-mails', async () => {
    const b = await booking();
    const ask = await post(`/book/${slug}/manage/${b.token}/cancel`, {});
    expect(ask.body).toContain('name="confirm" value="yes"');
    const done = await post(`/book/${slug}/manage/${b.token}/cancel`, { confirm: 'yes' });
    expect(done.statusCode).toBe(303);
    const [row] = await owner`select status, cancelled_by from public.bookings where id = ${b.id}`;
    expect(row).toMatchObject({ status: 'cancelled', cancelled_by: 'customer' });
    const [job] =
      await owner`select payload from public.jobs where queue = 'bookings.cancel' and payload->>'bookingId' = ${b.id}`;
    expect(job!.payload).toMatchObject({ by: 'customer' });
    expect((await page(`/book/${slug}/manage/${b.token}?lang=en`)).body).toContain(
      'Your booking is cancelled',
    );
  });
});

describe('owner', () => {
  it('lists bookings and cancels one; other businesses see nothing', async () => {
    const worker = confirmSoon(A.tenantId);
    await post(firstSlot((await page(`/book/${slug}`)).body), {
      name: 'Dora',
      email: 'dora@example.com',
    });
    const id = await worker;
    const list = await call('GET', A, '/bookings?scope=upcoming');
    expect(list.json.map((b: { id: string }) => b.id)).toContain(id);
    expect((await call('GET', B, '/bookings?scope=upcoming')).json).toEqual([]);
    expect((await call('POST', B, `/bookings/${id}/cancel`)).status).toBe(409);
    expect((await call('POST', A, `/bookings/${id}/cancel`)).status).toBe(200);
    const [row] = await owner`select status, cancelled_by from public.bookings where id = ${id}`;
    expect(row).toMatchObject({ status: 'cancelled', cancelled_by: 'owner' });
  });
});

describe('Google Calendar connection', () => {
  it('connects through OAuth and stores the token sealed for the worker', async () => {
    const start = await call('POST', A, '/calendar/google/start');
    expect(start.status).toBe(200);
    const url = new URL(start.json.url);
    expect(url.pathname).toBe('/api/calendar/google/callback');
    const cb = await page(`/calendar/google/callback${url.search}`);
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe(
      'https://app.noctiv.test/bookings?tab=setup&calendar=connected',
    );
    const [c] = await owner<
      { id: string; account_email: string; credentials_ciphertext: Buffer }[]
    >`
      select id, account_email, credentials_ciphertext from public.calendar_connections where tenant_id = ${A.tenantId}`;
    expect(c!.account_email).toBe('calendar@example.com');
    expect(openCalendarToken(c!.credentials_ciphertext, keys, A.tenantId, c!.id)).toBe(
      'fake-refresh-token',
    );
    expect((await call('GET', A, '/bookings/setup')).json.calendar).toMatchObject({
      status: 'connected',
    });
  });

  it('refuses a bad state, a refused consent and missing scopes', async () => {
    expect(
      (await page('/calendar/google/callback?state=c1.x.y&code=fake-code')).headers.location,
    ).toContain('reason=state');
    const start = new URL((await call('POST', A, '/calendar/google/start')).json.url);
    const state = start.searchParams.get('state')!;
    expect(
      (await page(`/calendar/google/callback?state=${state}&error=access_denied`)).headers.location,
    ).toContain('reason=denied');
    const exchange = google.exchangeCode;
    google.exchangeCode = async () => ({
      refreshToken: 'r',
      email: 'x@example.com',
      scopes: ['openid', 'email'],
    });
    expect(
      (await page(`/calendar/google/callback?state=${state}&code=fake-code`)).headers.location,
    ).toContain('reason=scopes');
    google.exchangeCode = exchange;
  });

  it('disconnect queues the revocation', async () => {
    expect((await call('DELETE', A, '/calendar')).status).toBe(200);
    const [c] =
      await owner`select status from public.calendar_connections where tenant_id = ${A.tenantId}`;
    expect(c!.status).toBe('revoking');
    const [job] =
      await owner`select 1 from public.jobs where tenant_id = ${A.tenantId} and queue = 'calendar.disconnect'`;
    expect(job).toBeTruthy();
  });
});

describe('intake forms', () => {
  let formId = '';
  it('are created with at most 10 fields', async () => {
    const tooMany = Array.from({ length: 11 }, (_, i) => ({
      label: `Q${i}`,
      type: 'text',
      required: false,
    }));
    expect((await call('POST', A, '/forms', { name: 'Too big', fields: tooMany })).status).toBe(
      400,
    );
    expect(
      (
        await call('POST', A, '/forms', {
          name: 'x',
          fields: [{ label: 'Pick', type: 'choice', required: true, options: ['a'] }],
        })
      ).status,
    ).toBe(400);
    const ok = await call('POST', A, '/forms', {
      name: 'Project questions',
      intro: 'So we can prepare.',
      fields: [
        { label: 'Company', type: 'text', required: true },
        { label: 'Budget', type: 'number', required: false },
        { label: 'Need', type: 'choice', required: true, options: ['Website', 'Shop'] },
      ],
    });
    expect(ok.status).toBe(200);
    formId = ok.json.id;
  });

  it('takes a submission from a general link: new lead, owner notified', async () => {
    const link = await call('POST', A, `/forms/${formId}/link`, {});
    const path = new URL(link.json.url).pathname;
    expect(path).toMatch(/^\/f\/f1\./);
    const form = await page(path);
    expect(form.body).toContain('Project questions');
    expect(form.body).toContain('name="email"');
    const bad = await post(path, { name: 'Eve', email: 'eve@example.com', f3: 'Castle' });
    expect(bad.statusCode).toBe(400);
    const ok = await post(path, {
      name: 'Eve',
      email: 'eve@example.com',
      f1: 'Eve & Co',
      f2: '1500',
      f3: 'Shop',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('Thank you!');
    const [s] = await owner`select s.answers, s.form_name, l.email from public.intake_submissions s
                            join public.leads l on l.id = s.lead_id where s.form_id = ${formId}`;
    expect(s!.email).toBe('eve@example.com');
    expect(s!.answers).toEqual([
      { key: 'f1', label: 'Company', type: 'text', value: 'Eve & Co' },
      { key: 'f2', label: 'Budget', type: 'number', value: '1500' },
      { key: 'f3', label: 'Need', type: 'choice', value: 'Shop' },
    ]);
    const [n] =
      await owner`select payload from public.notifications where tenant_id = ${A.tenantId} and kind = 'intake_submitted'`;
    expect(n!.payload).toMatchObject({
      formName: 'Project questions',
      answerCount: 3,
      senderDomain: 'example.com',
    });
    expect(n!.payload.answers).toBeUndefined();
  });

  it('a customer link skips name and e-mail and attaches to the thread', async () => {
    const link = await call('POST', A, `/forms/${formId}/link`, { threadId: A.threadId });
    const path = new URL(link.json.url).pathname;
    expect((await page(path)).body).not.toContain('name="email"');
    await post(path, { f1: 'Acme', f3: 'Website' });
    const subs = await call('GET', A, `/forms/submissions?threadId=${A.threadId}`);
    expect(subs.json[0]).toMatchObject({
      lead_id: A.leadId,
      thread_id: A.threadId,
      email: 'customer-book-a@example.test',
    });
    expect((await call('GET', B, `/forms/submissions?threadId=${A.threadId}`)).json).toEqual([]);
    // A link signed for another business's form is refused.
    const forged = signFormLink({ tenantId: B.tenantId, formId }, SECRET);
    expect((await page(`/f/${forged}`)).statusCode).toBe(404);
    expect((await page(`/f/${randomUUID()}`)).statusCode).toBe(404);
  });
});

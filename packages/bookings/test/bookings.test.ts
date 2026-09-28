import { describe, expect, it } from 'vitest';
import {
  BOOKING_LABELS,
  BOOKING_LANGUAGES,
  bookingEmail,
  bookingIcs,
  bookingSettingsPatch,
  DEFAULT_SETTINGS,
  detailsPage,
  formSchema,
  formatTime,
  freeSlots,
  isFreeSlot,
  offerBlock,
  offerText,
  readAnswers,
  readContact,
  settingsProblems,
  signCalendarState,
  signFormLink,
  signManageToken,
  signReplyLink,
  slotsPage,
  slugFromName,
  slugProblem,
  verifyCalendarState,
  verifyFormLink,
  verifyManageToken,
  verifyReplyLink,
  withKeys,
  type FormField,
} from '../src/index.ts';

const SECRET = 'x'.repeat(40);
const T = '11111111-1111-4111-8111-111111111111';
const U = '22222222-2222-4222-8222-222222222222';
const RIGA = 'Europe/Riga';
const settings = { ...DEFAULT_SETTINGS, noticeHours: 0, bufferMinutes: 0 };
const iso = (d: Date) => d.toISOString().slice(0, 16);

describe('free times', () => {
  // Monday 5 October 2026, 07:00 UTC = 10:00 in Riga (EEST, UTC+3).
  const monday = new Date('2026-10-05T07:00:00Z');

  it('cuts the weekly hours into slots in the business time zone', () => {
    const s = freeSlots({ settings, timeZone: RIGA, busy: [], now: monday, limit: 3 });
    expect(s.map((x) => iso(x.start))).toEqual([
      '2026-10-05T07:00',
      '2026-10-05T07:30',
      '2026-10-05T08:00',
    ]);
    expect(s[0]!.end.getTime() - s[0]!.start.getTime()).toBe(30 * 60_000);
  });

  it('skips closed days, respects notice and horizon', () => {
    // Friday 16:45 local: the last slot of the day has started, next is Monday 09:00.
    const friday = new Date('2026-10-09T13:45:00Z');
    const s = freeSlots({ settings, timeZone: RIGA, busy: [], now: friday, limit: 1 });
    expect(iso(s[0]!.start)).toBe('2026-10-12T06:00');
    const notice = freeSlots({
      settings: { ...settings, noticeHours: 24 },
      timeZone: RIGA,
      busy: [],
      now: monday,
      limit: 1,
    });
    expect(iso(notice[0]!.start)).toBe('2026-10-06T07:00');
    const all = freeSlots({
      settings: { ...settings, horizonDays: 2 },
      timeZone: RIGA,
      busy: [],
      now: monday,
    });
    expect(all.every((x) => x.end.getTime() <= monday.getTime() + 2 * 86_400_000)).toBe(true);
  });

  it('keeps the buffer around busy times', () => {
    const busy = [
      { start: new Date('2026-10-05T08:00:00Z'), end: new Date('2026-10-05T09:00:00Z') },
    ];
    const s = freeSlots({
      settings: { ...settings, bufferMinutes: 15 },
      timeZone: RIGA,
      busy,
      now: monday,
      limit: 4,
    });
    // 10:00, then 10:30 ends at 11:00 = busy start - 0 but inside the 15-minute buffer: gone.
    expect(s.map((x) => iso(x.start))).toEqual([
      '2026-10-05T07:00',
      '2026-10-05T09:30',
      '2026-10-05T10:00',
      '2026-10-05T10:30',
    ]);
  });

  it('follows the wall clock across the DST change', () => {
    // Riga leaves summer time on Sunday 25 October 2026: 09:00 is 06:00Z before, 07:00Z after.
    const s = freeSlots({
      settings: { ...settings, horizonDays: 10 },
      timeZone: RIGA,
      busy: [],
      now: new Date('2026-10-23T05:00:00Z'),
    });
    expect(s.find((x) => iso(x.start).startsWith('2026-10-23'))!.start.toISOString()).toBe(
      '2026-10-23T06:00:00.000Z',
    );
    expect(s.find((x) => iso(x.start).startsWith('2026-10-26'))!.start.toISOString()).toBe(
      '2026-10-26T07:00:00.000Z',
    );
    expect(
      formatTime(s.find((x) => iso(x.start).startsWith('2026-10-26'))!.start, 'en', RIGA),
    ).toBe('09:00');
  });

  it('isFreeSlot accepts only a slot on offer', () => {
    const input = { settings, timeZone: RIGA, busy: [], now: monday };
    expect(isFreeSlot(input, new Date('2026-10-06T08:30:00Z'))).not.toBeNull();
    expect(isFreeSlot(input, new Date('2026-10-06T08:10:00Z'))).toBeNull();
    expect(isFreeSlot(input, new Date('2026-10-10T08:00:00Z'))).toBeNull(); // Saturday
  });
});

describe('settings and slug', () => {
  it('validates hours and the location', () => {
    expect(
      bookingSettingsPatch.safeParse({ hours: { '1': [{ from: '10:00', to: '09:00' }] } }).success,
    ).toBe(false);
    expect(
      bookingSettingsPatch.safeParse({
        hours: {
          '1': [
            { from: '09:00', to: '12:00' },
            { from: '11:00', to: '14:00' },
          ],
        },
      }).success,
    ).toBe(false);
    expect(bookingSettingsPatch.safeParse({ slotMinutes: 10 }).success).toBe(false);
    expect(settingsProblems({ ...DEFAULT_SETTINGS, locationText: 'http://x' })).toEqual([
      'online_link_missing',
    ]);
    expect(settingsProblems({ ...DEFAULT_SETTINGS, locationKind: 'phone', hours: {} })).toEqual([
      'no_hours',
    ]);
  });

  it('makes slugs from names', () => {
    expect(slugFromName('Nordlicht Candles GmbH')).toBe('nordlicht-candles-gmbh');
    expect(slugFromName('Café Ēnas & Co.')).toBe('cafe-enas-co');
    expect(slugFromName('AB')).toBe('ab-now');
    expect(slugFromName('Admin')).toBe('admin-1');
    expect(slugProblem('ok-slug')).toBeNull();
    expect(slugProblem('Bad Slug')).toBe('format');
    expect(slugProblem('a--b')).toBe('format');
    expect(slugProblem('help')).toBe('reserved');
  });
});

describe('links', () => {
  it('round-trip, and refuse tampering, expiry and swapping kinds', () => {
    const now = new Date('2026-10-05T10:00:00Z');
    const c = signCalendarState({ tenantId: T, userId: U }, SECRET, now);
    expect(verifyCalendarState(c, SECRET, now)).toMatchObject({
      ok: true,
      claims: { tenantId: T, userId: U },
    });
    expect(verifyCalendarState(c, SECRET, new Date(now.getTime() + 11 * 60_000))).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyCalendarState(`${c}x`, SECRET, now).ok).toBe(false);
    expect(verifyCalendarState(c, 'y'.repeat(40), now).ok).toBe(false);

    const b = signManageToken(
      { tenantId: T, bookingId: U, endsAt: new Date('2026-10-06T10:00:00Z') },
      SECRET,
    );
    expect(verifyManageToken(b, SECRET, now)).toMatchObject({ ok: true, claims: { bookingId: U } });
    expect(verifyManageToken(b, SECRET, new Date('2026-10-07T00:00:00Z')).ok).toBe(false);
    expect(verifyCalendarState(b, SECRET, now).ok).toBe(false);

    const r = signReplyLink({ tenantId: T, leadId: U, language: 'de' }, SECRET, now);
    expect(verifyReplyLink(r, SECRET, now)).toMatchObject({
      ok: true,
      claims: { leadId: U, threadId: null, language: 'de' },
    });
    expect(verifyReplyLink(r, SECRET, new Date(now.getTime() + 31 * 86_400_000))).toEqual({
      ok: false,
      reason: 'expired',
    });

    const f = signFormLink({ tenantId: T, formId: U }, SECRET);
    expect(verifyFormLink(f, SECRET, now)).toMatchObject({
      ok: true,
      claims: { formId: U, leadId: null, expiresAt: null },
    });
    const [kind, body, sig] = f.split('.');
    const forged = Buffer.from(JSON.stringify({ t: T, f: U, l: U })).toString('base64url');
    expect(verifyFormLink(`${kind}.${forged}.${sig}`, SECRET, now).ok).toBe(false);
    expect(body).toBeTruthy();
  });
});

describe('forms', () => {
  const fields: FormField[] = withKeys([
    { label: 'Company', type: 'text' as const, required: true },
    { label: 'Budget', type: 'number' as const, required: false },
    { label: 'Start', type: 'date' as const, required: false },
    { label: 'Size', type: 'choice' as const, required: true, options: ['S', 'M'] },
    { label: 'Existing site?', type: 'yes_no' as const, required: false },
  ]);

  it('checks the definition', () => {
    expect(fields.map((f) => f.key)).toEqual(['f1', 'f2', 'f3', 'f4', 'f5']);
    expect(formSchema.safeParse({ name: 'Intake', intro: '', fields }).success).toBe(true);
    const eleven = withKeys(
      Array.from({ length: 11 }, (_, i) => ({
        label: `F${i}`,
        type: 'text' as const,
        required: false,
      })),
    );
    expect(formSchema.safeParse({ name: 'Too many', intro: '', fields: eleven }).success).toBe(
      false,
    );
    expect(
      formSchema.safeParse({
        name: 'x',
        intro: '',
        fields: [{ key: 'f1', label: 'One', type: 'choice', required: true, options: ['a'] }],
      }).success,
    ).toBe(false);
  });

  it('reads answers with labels, and reports errors per field', () => {
    const ok = readAnswers(fields, {
      f1: '  Acme  Ltd ',
      f2: '1500',
      f3: '2026-11-02',
      f4: 'M',
      f5: 'yes',
    });
    expect(ok.errors).toEqual({});
    expect(ok.answers.map((a) => [a.label, a.value])).toEqual([
      ['Company', 'Acme Ltd'],
      ['Budget', '1500'],
      ['Start', '2026-11-02'],
      ['Size', 'M'],
      ['Existing site?', 'yes'],
    ]);
    const bad = readAnswers(fields, { f2: 'lots', f3: '2026-02-30', f4: 'XL' });
    expect(bad.errors).toEqual({ f1: 'required', f2: 'number', f3: 'date', f4: 'choice' });
    const c = readContact(
      { name: ' Anna ', email: 'Anna@Example.com ', phone: 'call me' },
      { note: true, phone: true },
    );
    expect(c.contact).toMatchObject({ name: 'Anna', email: 'anna@example.com' });
    expect(c.errors).toEqual({ phone: 'phone' });
  });
});

describe('texts, labels and .ics', () => {
  const start = new Date('2026-10-06T07:00:00Z');
  const end = new Date('2026-10-06T07:30:00Z');

  it('has every label in every language', () => {
    const keys = Object.keys(BOOKING_LABELS.en).sort();
    for (const l of BOOKING_LANGUAGES) expect(Object.keys(BOOKING_LABELS[l]).sort()).toEqual(keys);
  });

  it('offers times with the link, in the customer language', () => {
    const block = offerBlock({
      language: 'de',
      timeZone: RIGA,
      slots: [{ start, end }],
      bookingUrl: 'https://app.noctiv.io/book/x?r=abc',
    });
    expect(block).toContain('Osteuropäische Zeit');
    expect(block).toContain('• Dienstag, 6. Oktober, 10:00');
    expect(block).toContain('https://app.noctiv.io/book/x?r=abc');
    const text = offerText({ language: 'lv', customerName: 'Anna', block: 'BLOCK' });
    expect(text.split('\n')[0]).toBe('Labdien, Anna!');
    expect(text).toContain('Paldies par ziņu.');
    expect(text).toContain('BLOCK');
  });

  it('writes the customer e-mails for every kind and language', () => {
    for (const language of BOOKING_LANGUAGES)
      for (const kind of [
        'booked',
        'moved',
        'cancelled_by_customer',
        'cancelled_by_owner',
      ] as const) {
        const m = bookingEmail({
          kind,
          language,
          customerName: 'Anna',
          start,
          end,
          timeZone: RIGA,
          locationKind: 'online_link',
          locationText: 'https://meet.example/abc',
          manageUrl: 'https://app.noctiv.io/book/x/manage/tok',
          bookingUrl: 'https://app.noctiv.io/book/x',
        });
        expect(m.subject.length).toBeGreaterThan(5);
        if (kind.startsWith('cancelled')) expect(m.text).not.toContain('manage/tok');
        else expect(m.text).toContain('https://meet.example/abc');
      }
    const en = bookingEmail({
      kind: 'booked',
      language: 'en',
      customerName: null,
      start,
      end,
      timeZone: RIGA,
      locationKind: 'phone',
      locationText: '',
      manageUrl: 'https://m',
      bookingUrl: null,
    });
    expect(en.text).toContain(
      'Thank you for booking. Your appointment is confirmed for Tuesday, 6 October 2026, 10:00–10:30 (Eastern European Time).',
    );
    expect(en.text).toContain('We will call you');
  });

  it('builds a valid, folded .ics', () => {
    const ics = bookingIcs({
      method: 'REQUEST',
      uid: `${U}@noctiv.io`,
      sequence: 0,
      start,
      end,
      summary: 'Meeting, with; Nordlicht',
      description: 'Line one\nLine two '.repeat(10),
      location: 'Brīvības iela 1, Rīga',
      organizer: { name: 'Nordlicht "Candles"', email: 'hello@nordlicht.example' },
      attendee: { name: 'Anna', email: 'anna@example.com' },
      now: start,
    });
    expect(ics).toContain('DTSTART:20261006T070000Z');
    expect(ics).toContain('SUMMARY:Meeting\\, with\\; Nordlicht');
    expect(ics).toContain('ORGANIZER;CN="Nordlicht Candles":mailto:hello@nordlicht.example');
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('renders the pages without script and escapes the owner text', () => {
    const brand = { headerHtml: '<p>B</p>', name: 'A <b>', color: '#FFE66D' };
    const meeting = {
      title: 'Intro <call>',
      minutes: 30,
      locationKind: 'in_person' as const,
      locationText: 'Street 1',
    };
    const list = slotsPage({
      lang: 'en',
      brand,
      meeting,
      timeZone: RIGA,
      days: [{ day: start, slots: [{ start, end, href: '/book/x/t/2026-10-06T07:00Z' }] }],
      earlierHref: null,
      laterHref: '/book/x?from=2026-10-13',
    });
    expect(list.body).not.toMatch(/<script/i);
    expect(list.body).toContain('Intro &lt;call&gt;');
    expect(list.body).toContain('href="/book/x/t/2026-10-06T07:00Z"');
    const details = detailsPage({
      lang: 'fr',
      brand,
      meeting,
      timeZone: RIGA,
      slot: { start, end },
      action: '/book/x/t/2026-10-06T07:00Z',
      changeHref: '/book/x',
      hidden: { r: 'tok"en' },
      values: { name: '"><script>' },
      errors: { email: 'required' },
      form: null,
    });
    expect(details.body).toContain('value="tok&quot;en"');
    expect(details.body).not.toContain('<script>');
    expect(details.body).toContain('Veuillez remplir ce champ.');
    expect(details.body).toContain('name="website"');
  });
});

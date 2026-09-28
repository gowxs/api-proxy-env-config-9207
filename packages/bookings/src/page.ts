import { brandTextColor } from '@noctiv/core';
import type { Answer, Contact, FieldError, FormField } from './forms.ts';
import {
  bookingLabels,
  formatDay,
  formatTime,
  formatWhen,
  zoneName,
  type BookingLabels,
} from './labels.ts';
import type { LocationKind } from './settings.ts';
import type { Slot } from './slots.ts';

/**
 * The public booking and form pages (PLAN.md §29.4, §29.7): server-rendered,
 * no script, phone-first, inline styles only (the CSP allows nothing else),
 * in the style of the quote Accept page. Every function returns the page
 * body; `bookingDocument` wraps it.
 */
export const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const e = escapeHtml;

const INK = '#1F2430';
const MUTED = '#5B6275';
const LINE = '#C9CEDA';
const ERROR = '#B42318';
const CARD =
  'margin:16px 0 0;padding:20px;border-radius:12px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.06)';

export function bookingDocument(i: {
  lang: string;
  title: string;
  body: string;
  color: string | null;
}): string {
  const bar = i.color && /^#[0-9A-Fa-f]{6}$/.test(i.color) ? i.color : '#2F3A56';
  return (
    `<!doctype html><html lang="${e(i.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${e(i.title)}</title></head>` +
    `<body style="margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:${INK};background:#F4F5F7;line-height:1.45">` +
    `<div style="height:6px;background:${bar}"></div>` +
    `<main style="max-width:560px;margin:24px auto 48px;padding:0 16px">${i.body}</main></body></html>`
  );
}

/** Links and buttons use the brand colour, darkened when too light for white text. */
const accent = (color: string | null) => brandTextColor(color);
const button = (label: string, color: string | null) =>
  `<button type="submit" style="width:100%;margin-top:20px;font-size:16px;font-weight:600;padding:14px 18px;border:0;border-radius:8px;color:#fff;background:${accent(color)};cursor:pointer">${e(label)}</button>`;
const quietButton = (label: string) =>
  `<button type="submit" style="width:100%;margin-top:12px;font-size:16px;padding:13px 18px;border:1.5px solid ${LINE};border-radius:8px;color:${INK};background:#fff;cursor:pointer">${e(label)}</button>`;
const link = (href: string, label: string, color: string | null) =>
  `<a href="${e(href)}" style="color:${accent(color)};font-weight:600">${e(label)}</a>`;

export interface PageBrand {
  /** brandHeader(): the logo as a data URI, or the name in the brand colour. */
  headerHtml: string;
  name: string;
  color: string | null;
}

export interface MeetingInfo {
  title: string;
  minutes: number;
  locationKind: LocationKind;
  /** Shown for in_person and online_link; the Meet link is only in the e-mail. */
  locationText: string;
}

function meetingLine(t: BookingLabels, m: MeetingInfo): string {
  const where =
    m.locationKind === 'in_person'
      ? `${t.where.in_person}: ${m.locationText}`
      : m.locationKind === 'phone'
        ? t.where.phone
        : m.locationKind === 'online_link'
          ? t.where.online_link
          : t.where.google_meet;
  return `<p style="margin:4px 0 0;color:${MUTED}">${e(t.minutes(m.minutes))} · ${e(where)}</p>`;
}

function head(brand: PageBrand, title: string, sub = ''): string {
  return `${brand.headerHtml}<h1 style="margin:8px 0 0;font-size:24px;line-height:1.25">${e(title)}</h1>${sub}`;
}

// ------------------------------------------------------------- times

export interface DaySlots {
  day: Date;
  slots: (Slot & { href: string })[];
}

export function slotsPage(i: {
  lang: string;
  brand: PageBrand;
  meeting: MeetingInfo;
  timeZone: string;
  days: DaySlots[];
  earlierHref: string | null;
  laterHref: string | null;
  /** Rescheduling: the current booking, shown above the times. */
  current?: { start: Date; end: Date } | null;
  heading?: string;
}): { title: string; body: string } {
  const t = bookingLabels(i.lang);
  const title = i.heading ?? t.heading(i.brand.name);
  const days = i.days.filter((d) => d.slots.length);
  const list = days.length
    ? days
        .map(
          (d) =>
            `<section style="${CARD}"><h2 style="margin:0;font-size:17px">${e(formatDay(d.day, i.lang, i.timeZone))}</h2>` +
            `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:8px;margin-top:12px">` +
            d.slots
              .map(
                (s) =>
                  `<a href="${e(s.href)}" style="display:block;padding:11px 0;text-align:center;border:1.5px solid ${accent(i.brand.color)};border-radius:8px;color:${accent(i.brand.color)};font-weight:600;text-decoration:none;font-variant-numeric:tabular-nums">${e(formatTime(s.start, i.lang, i.timeZone))}</a>`,
              )
              .join('') +
            `</div></section>`,
        )
        .join('')
    : `<p style="${CARD}">${e(t.noTimes)}</p>`;
  const nav = [
    i.earlierHref ? link(i.earlierHref, `← ${t.earlierDates}`, i.brand.color) : '',
    i.laterHref ? link(i.laterHref, `${t.laterDates} →`, i.brand.color) : '',
  ].filter(Boolean);
  const current = i.current
    ? `<p style="${CARD};margin-top:16px"><span style="color:${MUTED}">${e(t.yourTime)}</span><br><b>${e(formatWhen(i.current.start, i.current.end, i.lang, i.timeZone))}</b></p>`
    : '';
  return {
    title,
    body:
      head(
        i.brand,
        title,
        `${i.meeting.title ? `<p style="margin:8px 0 0;font-weight:600">${e(i.meeting.title)}</p>` : ''}${meetingLine(t, i.meeting)}`,
      ) +
      current +
      `<p style="margin:16px 0 0">${e(t.intro)} <span style="color:${MUTED}">${e(t.timesIn(zoneName(i.lang, i.timeZone, i.days[0]?.day)))}</span></p>` +
      list +
      (nav.length
        ? `<p style="display:flex;justify-content:space-between;gap:16px;margin:20px 0 0">${nav.join('')}</p>`
        : ''),
  };
}

// ------------------------------------------------------------- details

export type Values = Record<string, string>;
export type Errors = Record<string, FieldError>;

function field(
  t: BookingLabels,
  o: {
    name: string;
    label: string;
    value: string;
    error?: FieldError | undefined;
    required: boolean;
    kind: 'text' | 'email' | 'tel' | 'number' | 'date' | 'textarea' | 'select' | 'yes_no';
    autocomplete?: string;
    options?: string[];
    max?: number;
  },
): string {
  const id = `f-${o.name}`;
  const errId = `${id}-err`;
  const style = `display:block;box-sizing:border-box;width:100%;margin-top:6px;padding:12px;font:inherit;font-size:16px;border:1.5px solid ${o.error ? ERROR : LINE};border-radius:8px;background:#fff;color:${INK}`;
  const aria = `${o.required ? ' required' : ''}${o.error ? ` aria-invalid="true" aria-describedby="${errId}"` : ''}`;
  const label =
    `<label for="${id}" style="font-weight:600;font-size:15px">${e(o.label)}` +
    (o.required ? '' : ` <span style="font-weight:400;color:${MUTED}">(${e(t.optional)})</span>`) +
    `</label>`;
  let control: string;
  if (o.kind === 'textarea') {
    control = `<textarea id="${id}" name="${e(o.name)}" rows="3" maxlength="${o.max ?? 2000}"${aria} style="${style};resize:vertical">${e(o.value)}</textarea>`;
  } else if (o.kind === 'select') {
    control =
      `<select id="${id}" name="${e(o.name)}"${aria} style="${style}"><option value="">${e(t.choose)}</option>` +
      (o.options ?? [])
        .map((op) => `<option${op === o.value ? ' selected' : ''}>${e(op)}</option>`)
        .join('') +
      `</select>`;
  } else if (o.kind === 'yes_no') {
    const radio = (v: 'yes' | 'no', text: string) =>
      `<label style="display:inline-flex;align-items:center;gap:8px;margin:8px 20px 0 0;font-size:16px"><input type="radio" name="${e(o.name)}" value="${v}"${o.value === v ? ' checked' : ''}${o.required ? ' required' : ''} style="width:20px;height:20px;margin:0">${e(text)}</label>`;
    return (
      `<fieldset style="margin:14px 0 0;padding:0;border:0"${o.error ? ` aria-describedby="${errId}"` : ''}><legend style="font-weight:600;font-size:15px;padding:0">${e(o.label)}` +
      (o.required
        ? ''
        : ` <span style="font-weight:400;color:${MUTED}">(${e(t.optional)})</span>`) +
      `</legend>${radio('yes', t.yes)}${radio('no', t.no)}` +
      (o.error
        ? `<span id="${errId}" style="display:block;margin-top:4px;color:${ERROR};font-size:14px">${e(t.errors[o.error])}</span>`
        : '') +
      `</fieldset>`
    );
  } else {
    const type = o.kind === 'number' ? 'text" inputmode="decimal' : o.kind;
    control = `<input id="${id}" name="${e(o.name)}" type="${type}" value="${e(o.value)}" maxlength="${o.max ?? 200}"${o.autocomplete ? ` autocomplete="${o.autocomplete}"` : ''}${aria} style="${style}">`;
  }
  return (
    `<p style="margin:14px 0 0">${label}${control}` +
    (o.error
      ? `<span id="${errId}" style="display:block;margin-top:4px;color:${ERROR};font-size:14px">${e(t.errors[o.error])}</span>`
      : '') +
    `</p>`
  );
}

const FIELD_KIND: Record<FormField['type'], Parameters<typeof field>[1]['kind']> = {
  text: 'text',
  long_text: 'textarea',
  email: 'email',
  phone: 'tel',
  number: 'number',
  date: 'date',
  choice: 'select',
  yes_no: 'yes_no',
};

function contactFields(
  t: BookingLabels,
  v: Values,
  errors: Errors,
  o: { phone: 'required' | 'optional' | 'hidden'; note: boolean; lockEmail?: boolean },
): string {
  return (
    field(t, {
      name: 'name',
      label: t.name,
      value: v.name ?? '',
      error: errors.name,
      required: true,
      kind: 'text',
      autocomplete: 'name',
    }) +
    field(t, {
      name: 'email',
      label: t.email,
      value: v.email ?? '',
      error: errors.email,
      required: true,
      kind: 'email',
      autocomplete: 'email',
    }) +
    (o.phone === 'hidden'
      ? ''
      : field(t, {
          name: 'phone',
          label: t.phone,
          value: v.phone ?? '',
          error: errors.phone,
          required: o.phone === 'required',
          kind: 'tel',
          autocomplete: 'tel',
          max: 25,
        })) +
    (o.note
      ? field(t, {
          name: 'note',
          label: t.note,
          value: v.note ?? '',
          error: errors.note,
          required: false,
          kind: 'textarea',
          max: 1000,
        })
      : '')
  );
}

function formFields(t: BookingLabels, fields: FormField[], v: Values, errors: Errors): string {
  return fields
    .map((f) =>
      field(t, {
        name: f.key,
        label: f.label,
        value: v[f.key] ?? '',
        error: errors[f.key],
        required: f.required,
        kind: FIELD_KIND[f.type],
        options: f.options,
        max: f.type === 'long_text' ? 2000 : 200,
      }),
    )
    .join('');
}

/** Off-screen field that people never fill in; bots often do. */
const HONEYPOT =
  '<div aria-hidden="true" style="position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden"><label>Website<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>';

function errorSummary(t: BookingLabels, errors: Errors): string {
  return Object.keys(errors).length
    ? `<p role="alert" style="margin:16px 0 0;padding:10px 12px;border-radius:8px;background:#FEF3F2;color:${ERROR};font-size:14px">${e(t.fixBelow)}</p>`
    : '';
}

export function detailsPage(i: {
  lang: string;
  brand: PageBrand;
  meeting: MeetingInfo;
  timeZone: string;
  slot: Slot;
  action: string;
  changeHref: string;
  hidden: Record<string, string>;
  values: Values;
  errors: Errors;
  form: { intro: string; fields: FormField[] } | null;
}): { title: string; body: string } {
  const t = bookingLabels(i.lang);
  const title = t.heading(i.brand.name);
  const hidden = Object.entries(i.hidden)
    .map(([k, v]) => `<input type="hidden" name="${e(k)}" value="${e(v)}">`)
    .join('');
  return {
    title,
    body:
      head(i.brand, title) +
      `<section style="${CARD}"><p style="margin:0;color:${MUTED}">${e(t.yourTime)}</p>` +
      `<p style="margin:2px 0 0;font-size:18px;font-weight:700">${e(formatWhen(i.slot.start, i.slot.end, i.lang, i.timeZone))}</p>` +
      `<p style="margin:2px 0 0;color:${MUTED};font-size:14px">${e(zoneName(i.lang, i.timeZone, i.slot.start))}</p>` +
      meetingLine(t, i.meeting) +
      `<p style="margin:10px 0 0">${link(i.changeHref, t.chooseAnother, i.brand.color)}</p></section>` +
      errorSummary(t, i.errors) +
      `<form method="post" action="${e(i.action)}" style="position:relative" novalidate>${hidden}${HONEYPOT}` +
      `<fieldset style="${CARD};border:0"><legend style="float:left;width:100%;padding:0;font-size:18px;font-weight:700">${e(t.yourDetails)}</legend><div style="clear:both"></div>` +
      contactFields(t, i.values, i.errors, {
        phone: i.meeting.locationKind === 'phone' ? 'required' : 'optional',
        note: true,
      }) +
      (i.form
        ? (i.form.intro ? `<p style="margin:16px 0 0;color:${MUTED}">${e(i.form.intro)}</p>` : '') +
          formFields(t, i.form.fields, i.values, i.errors)
        : '') +
      `</fieldset>${button(t.book, i.brand.color)}</form>`,
  };
}

// ------------------------------------------------------------- results

export function bookedPage(i: {
  lang: string;
  brand: PageBrand;
  meeting: MeetingInfo;
  timeZone: string;
  start: Date;
  end: Date;
  email: string;
  icsHref: string;
  moved?: boolean;
}): { title: string; body: string } {
  const t = bookingLabels(i.lang);
  const title = i.moved ? t.movedTitle : t.bookedTitle;
  return {
    title,
    body:
      head(i.brand, title) +
      `<section style="${CARD}"><p style="margin:0;font-size:18px;font-weight:700">${e(formatWhen(i.start, i.end, i.lang, i.timeZone))}</p>` +
      `<p style="margin:2px 0 0;color:${MUTED};font-size:14px">${e(zoneName(i.lang, i.timeZone, i.start))}</p>` +
      meetingLine(t, i.meeting) +
      (i.meeting.locationKind === 'online_link' && i.meeting.locationText
        ? `<p style="margin:8px 0 0;word-break:break-all">${link(i.meeting.locationText, i.meeting.locationText, i.brand.color)}</p>`
        : i.meeting.locationKind === 'google_meet'
          ? `<p style="margin:8px 0 0;color:${MUTED}">${e(t.meetLater)}</p>`
          : '') +
      `<p style="margin:16px 0 0"><a href="${e(i.icsHref)}" style="display:inline-block;padding:11px 16px;border:1.5px solid ${LINE};border-radius:8px;color:${INK};text-decoration:none;font-weight:600">${e(t.addToCalendar)}</a></p></section>` +
      `<p style="margin:16px 0 0">${e(t.bookedBody(i.email))} ${e(t.manageHint)}</p>`,
  };
}

export function messagePage(i: {
  lang: string;
  brand: PageBrand | null;
  title: string;
  text: string;
  extra?: string;
}): { title: string; body: string } {
  return {
    title: i.title,
    body:
      (i.brand ? i.brand.headerHtml : '') +
      `<h1 style="margin:8px 0 0;font-size:22px">${e(i.title)}</h1><p style="margin:8px 0 0">${e(i.text)}</p>${i.extra ?? ''}`,
  };
}

export function managePage(i: {
  lang: string;
  brand: PageBrand;
  meeting: MeetingInfo;
  timeZone: string;
  start: Date;
  end: Date;
  status: 'confirmed' | 'pending' | 'cancelled' | 'past';
  cancelAction: string;
  rescheduleHref: string;
  icsHref: string;
  confirmCancel?: boolean;
}): { title: string; body: string } {
  const t = bookingLabels(i.lang);
  const card =
    `<section style="${CARD}"><p style="margin:0;font-size:18px;font-weight:700${i.status === 'cancelled' ? ';text-decoration:line-through;color:' + MUTED : ''}">${e(formatWhen(i.start, i.end, i.lang, i.timeZone))}</p>` +
    `<p style="margin:2px 0 0;color:${MUTED};font-size:14px">${e(zoneName(i.lang, i.timeZone, i.start))}</p>` +
    meetingLine(t, i.meeting) +
    (i.status === 'confirmed'
      ? `<p style="margin:16px 0 0"><a href="${e(i.icsHref)}" style="color:${accent(i.brand.color)};font-weight:600">${e(t.addToCalendar)}</a></p>`
      : '') +
    `</section>`;
  if (i.status === 'cancelled')
    return { title: t.cancelledTitle, body: head(i.brand, t.cancelledTitle) + card };
  if (i.status === 'past')
    return {
      title: t.manageTitle,
      body:
        head(i.brand, t.manageTitle) + card + `<p style="margin:16px 0 0">${e(t.pastBooking)}</p>`,
    };
  const actions = i.confirmCancel
    ? `<form method="post" action="${e(i.cancelAction)}"><input type="hidden" name="confirm" value="yes">` +
      `<p style="margin:20px 0 0;font-weight:600">${e(t.cancelQuestion)}</p>${button(t.cancelYes, '#B42318')}</form>` +
      `<p style="margin:16px 0 0;text-align:center">${link(i.rescheduleHref.replace(/\/times(\?.*)?$/, ''), t.keep, i.brand.color)}</p>`
    : `<p style="margin:20px 0 0"><a href="${e(i.rescheduleHref)}" style="display:block;box-sizing:border-box;width:100%;padding:14px 18px;text-align:center;border-radius:8px;color:#fff;background:${accent(i.brand.color)};font-weight:600;text-decoration:none">${e(t.chooseAnother)}</a></p>` +
      `<form method="post" action="${e(i.cancelAction)}">${quietButton(t.cancel)}</form>`;
  return { title: t.manageTitle, body: head(i.brand, t.manageTitle) + card + actions };
}

// ------------------------------------------------------------- intake form

export function intakePage(i: {
  lang: string;
  brand: PageBrand;
  form: { name: string; intro: string; fields: FormField[] };
  action: string;
  values: Values;
  errors: Errors;
  /** Tied to a customer: name and e-mail are already known and not asked again. */
  known: { name: string; email: string } | null;
}): { title: string; body: string } {
  const t = bookingLabels(i.lang);
  return {
    title: i.form.name,
    body:
      head(
        i.brand,
        i.form.name,
        i.form.intro ? `<p style="margin:8px 0 0;color:${MUTED}">${e(i.form.intro)}</p>` : '',
      ) +
      errorSummary(t, i.errors) +
      `<form method="post" action="${e(i.action)}" style="position:relative" novalidate>${HONEYPOT}` +
      `<div style="${CARD}">` +
      (i.known ? '' : contactFields(t, i.values, i.errors, { phone: 'hidden', note: false })) +
      formFields(t, i.form.fields, i.values, i.errors) +
      `</div>${button(t.send, i.brand.color)}</form>`,
  };
}

export function intakeSentPage(i: { lang: string; brand: PageBrand }): {
  title: string;
  body: string;
} {
  const t = bookingLabels(i.lang);
  return messagePage({ lang: i.lang, brand: i.brand, title: t.formSent, text: t.formSentBody });
}

/** The answers as plain lines, for notifications and the event description. */
export function answersText(contact: Partial<Contact>, answers: Answer[]): string {
  return [
    ...(contact.phone ? [`Phone: ${contact.phone}`] : []),
    ...(contact.note ? [`Note: ${contact.note}`] : []),
    ...answers.map((a) => `${a.label}: ${a.value}`),
  ].join('\n');
}

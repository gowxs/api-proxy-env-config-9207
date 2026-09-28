/**
 * iCalendar (RFC 5545) for a booking: attached to the customer's e-mails and
 * offered as "Add to calendar" on the confirmation page. One UID per booking
 * (a moved booking keeps it, with a higher SEQUENCE), so calendar apps update
 * or remove the same entry. RSVP is off: nothing to answer.
 */
export interface IcsInput {
  method: 'REQUEST' | 'CANCEL';
  uid: string;
  sequence: number;
  start: Date;
  end: Date;
  summary: string;
  description: string;
  location: string;
  url?: string | null;
  organizer: { name: string; email: string };
  attendee: { name: string; email: string };
  now?: Date;
}

const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

/** TEXT value escaping (backslash, semicolon, comma, newline). */
export const icsText = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Quoted parameter value (CN): no quotes or control characters allowed inside. */
const param = (s: string) => `"${s.replace(/["\p{Cc}]/gu, '').slice(0, 100)}"`;
const address = (e: string) => e.replace(/[^A-Za-z0-9.!#$%&'*+/=?^_`{|}~@-]/g, '');

/** Lines longer than 75 octets are folded (CRLF + space), never inside a UTF-8 character. */
function fold(line: string): string {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += n;
  }
  out.push(current);
  return out.join('\r\n ');
}

export function bookingIcs(i: IcsInput): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Noctiv//Bookings//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${i.method}`,
    'BEGIN:VEVENT',
    `UID:${i.uid}`,
    `SEQUENCE:${i.sequence}`,
    `DTSTAMP:${stamp(i.now ?? new Date())}`,
    `DTSTART:${stamp(i.start)}`,
    `DTEND:${stamp(i.end)}`,
    `SUMMARY:${icsText(i.summary)}`,
    ...(i.description ? [`DESCRIPTION:${icsText(i.description)}`] : []),
    ...(i.location ? [`LOCATION:${icsText(i.location)}`] : []),
    ...(i.url ? [`URL:${i.url.replace(/[\r\n]/g, '')}`] : []),
    `ORGANIZER;CN=${param(i.organizer.name)}:mailto:${address(i.organizer.email)}`,
    `ATTENDEE;CN=${param(i.attendee.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:${address(i.attendee.email)}`,
    `STATUS:${i.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/**
 * Removes quoted history from a plain-text email so classification and
 * replies look only at what the sender wrote now. Everything after a common
 * reply header ("On … wrote:", "Am … schrieb", …) is dropped, as are lines
 * starting with ">". The full text is still stored for the owner.
 */
const REPLY_HEADER_RE = new RegExp(
  [
    '^On .{3,200}wrote:\\s*$',
    '^Am .{3,200}schrieb .{0,100}:\\s*$',
    '^Op .{3,200}schreef .{0,100}:\\s*$',
    '^Le .{3,200}a écrit\\s*:\\s*$',
    '^El .{3,200}escribió\\s*:\\s*$',
    '^.{3,200}rakstīja\\s*:\\s*$',
    '^-{2,}\\s*(?:Original Message|Ursprüngliche Nachricht|Oorspronkelijk bericht|Message d.origine|Mensaje original)\\s*-{2,}\\s*$',
    '^From:\\s.+\\n(?:Sent|Date):\\s.+',
    '^Von:\\s.+\\n(?:Gesendet|Datum):\\s.+',
  ].join('|'),
  'imu',
);

export function stripQuotedText(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  const m = REPLY_HEADER_RE.exec(normalized);
  const head = m ? normalized.slice(0, m.index) : normalized;
  return head
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .trim();
}

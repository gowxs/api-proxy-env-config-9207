/**
 * Sends a customer email to the local demo mailbox (GreenMail), so the local
 * stack has something to process:
 *   pnpm dev:mail "Candle price" "Hello, how much is one candle?" [from@address]
 */
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { DEV } from './dev-seed.ts';

const [
  subject = 'Question',
  text = 'Hello, how much is one candle?',
  from = 'customer@example-mail.test',
] = process.argv.slice(2);

const message = [
  `From: ${from}`,
  `To: ${DEV.mailbox}`,
  `Subject: ${subject.replace(/[\r\n]+/g, ' ')}`,
  `Message-ID: <${randomUUID()}@example-mail.test>`,
  `Date: ${new Date().toUTCString()}`,
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: 8bit',
  '',
  text.replace(/^\./gm, '..'),
].join('\r\n');

const commands = [
  'EHLO dev.local',
  `MAIL FROM:<${from}>`,
  `RCPT TO:<${DEV.mailbox}>`,
  'DATA',
  `${message}\r\n.`,
  'QUIT',
];
const socket = connect(DEV.smtpPort, 'localhost');
let step = -1;
socket.on('data', (d) => {
  const reply = d.toString();
  if (/^[45]\d\d/m.test(reply)) {
    console.error(`SMTP error: ${reply.trim()}`);
    socket.end();
    process.exit(1);
  }
  step++;
  if (step < commands.length) socket.write(`${commands[step]}\r\n`);
  else socket.end();
});
socket.on('end', () => console.log(`Sent "${subject}" from ${from} to ${DEV.mailbox}.`));
socket.on('error', (e) => {
  console.error(
    `Could not reach GreenMail on localhost:${DEV.smtpPort} (${e.message}). Is pnpm dev:stack running?`,
  );
  process.exit(1);
});

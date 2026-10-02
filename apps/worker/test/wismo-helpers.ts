import { randomUUID } from 'node:crypto';
import type { GenerateRequest } from '@noctiv/core';
import { FakeProvider } from '@noctiv/llm';
import type { InboundMessage } from '@noctiv/mail';

export const GVIDO = 'gowxs612@gmail.com';

export type Kind = 'classify' | 'generate' | 'verify';
export const kindOf = (req: GenerateRequest): Kind =>
  req.system.startsWith('You classify')
    ? 'classify'
    : req.system.startsWith('You check a draft')
      ? 'verify'
      : 'generate';

export const cls = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    category: 'order_status',
    sentiment: 'neutral',
    urgency: 'normal',
    language: 'en',
    summary: 'Customer asks where an order is.',
    ...patch,
  });

/** A model that words whatever facts it is given, and refuses to invent. */
export function model(classify = cls()) {
  return new FakeProvider({
    responder: (req) => {
      const kind = kindOf(req);
      if (kind === 'classify') return classify;
      if (kind === 'verify') return '{"supported":true,"unsupported_claims":[]}';
      const base = {
        intent: 'order status',
        language: 'en',
        confidence: 0.95,
        action: 'auto_send',
        escalate_reason: null,
        conflicts: [],
      };
      if (req.system.includes('could not be matched'))
        return JSON.stringify({
          ...base,
          action: 'draft',
          reply:
            'Hello,\n\nCould you send me your order number and the e-mail address you used at checkout? Then I can look into it.',
          sources: [],
        });
      const kb = req.parts.find((p) => p.kind === 'kb_context')?.text ?? '';
      const f = /\[S1\]\n([\s\S]*?)\n\n<<<END_KB_DATA/.exec(kb)?.[1] ?? '';
      const get = (k: string) => new RegExp(`${k}: ([^;\\n]+)`).exec(f)?.[1];
      const name = /^Order (#\d+)/.exec(f)?.[1];
      const shipped = /Shipping: shipped/.test(f);
      const parts = [
        'Hello,',
        `Your order ${name} ${shipped ? 'has shipped' : 'has not shipped yet'}.`,
        ...(shipped
          ? [
              [
                get('carrier') && `Carrier: ${get('carrier')}`,
                get('tracking number') && `tracking number ${get('tracking number')}`,
              ]
                .filter(Boolean)
                .join(', ') + '.',
              get('tracking link') ? `Track it here: ${get('tracking link')}` : '',
            ]
          : []),
      ].filter(Boolean);
      return JSON.stringify({ ...base, reply: parts.join('\n\n'), sources: ['S1'] });
    },
  });
}

export const inbound = (o: { from?: string; subject: string; text: string }): InboundMessage => ({
  messageId: `<${randomUUID()}@wismo.test>`,
  inReplyTo: null,
  references: [],
  from: { address: o.from ?? GVIDO, name: 'Gvido' },
  replyTo: [],
  to: ['shop@store.test'],
  cc: [],
  subject: o.subject,
  text: o.text,
  htmlHiddenText: false,
  loopHeaders: {},
  attachments: [],
  date: new Date(),
});

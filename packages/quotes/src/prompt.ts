import type { PricedItem } from './mapping.ts';

/**
 * The mapping prompt: the customer's e-mail (untrusted) and the confirmed
 * price list as labels, names, units and quantity limits. Prices are not
 * shown: the model cannot quote what it cannot see.
 */
export function buildQuoteMappingPrompt(input: {
  emailBlock: string;
  emailRule: string;
  labels: Map<string, PricedItem>;
}): { system: string; parts: { kind: 'untrusted_email' | 'kb_context'; text: string }[] } {
  const list = [...input.labels.entries()]
    .map(([label, it]) => {
      const limits = [
        it.minQty !== null ? `min ${it.minQty}` : '',
        it.maxQty !== null ? `max ${it.maxQty}` : '',
      ]
        .filter(Boolean)
        .join(', ');
      const desc = it.description ? ` — ${it.description.replace(/\s+/g, ' ').slice(0, 160)}` : '';
      return `${label}: ${it.name.replace(/\s+/g, ' ').slice(0, 160)}${desc} (unit: ${it.unit}${limits ? `; ${limits}` : ''})`;
    })
    .join('\n');
  const system = [
    "You map a customer's price request to a business's price list. You never write prices or totals.",
    input.emailRule,
    'The price list follows as labels P1, P2, …',
    'For each thing the customer asks a price for, output a line with: item (the label of the matching price-list entry), qty (the quantity the customer wrote, as a number; 1 if they named none), customer_text (their words for it, max 12 words).',
    'Only match when the entry clearly is what they asked for. If nothing on the list fits, or you are unsure, put their words in unmapped instead. Never guess a quantity they did not write.',
    "language: ISO 639-1 code of the customer's e-mail.",
    'Output a single JSON object with exactly these keys: lines, unmapped, language.',
  ].join('\n');
  return {
    system,
    parts: [
      { kind: 'untrusted_email', text: input.emailBlock },
      { kind: 'kb_context', text: `PRICE LIST\n${list}` },
    ],
  };
}

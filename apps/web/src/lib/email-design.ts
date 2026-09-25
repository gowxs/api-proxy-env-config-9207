/** The five e-mail designs (Settings → E-mail design); same ids as the API. */
export const EMAIL_DESIGNS = [
  {
    id: 'plain',
    title: 'Plain',
    line: 'Text only, signature as text. Best deliverability.',
  },
  {
    id: 'clean',
    title: 'Clean',
    line: 'Light HTML: a readable column, a thin divider and your signature. No images.',
  },
  {
    id: 'logo',
    title: 'Logo',
    line: 'Like Clean, with your logo above the text.',
  },
  {
    id: 'branded',
    title: 'Branded',
    line: 'A thin bar in your brand colour, your logo, a signature block with links, your address below.',
  },
  {
    id: 'card',
    title: 'Card',
    line: 'The reply on a white card, logo top left, links as buttons in your brand colour.',
  },
] as const;

export type EmailDesignId = (typeof EMAIL_DESIGNS)[number]['id'];

export const designInfo = (id: string) =>
  EMAIL_DESIGNS.find((d) => d.id === id) ?? EMAIL_DESIGNS[0];

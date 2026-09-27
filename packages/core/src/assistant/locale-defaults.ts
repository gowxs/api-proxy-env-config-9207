/**
 * Currency and standard VAT rate by the business's time zone: the defaults
 * for a new business (API POST /v1/tenants) and what the assistant proposes
 * during setup. Unknown zones: none (the owner chooses).
 */
export const LOCAL_DEFAULTS: Record<string, { currency: string; vatRate: number }> = {
  'Europe/London': { currency: 'GBP', vatRate: 20 },
  'Europe/Dublin': { currency: 'EUR', vatRate: 23 },
  'Europe/Berlin': { currency: 'EUR', vatRate: 19 },
  'Europe/Vienna': { currency: 'EUR', vatRate: 20 },
  'Europe/Paris': { currency: 'EUR', vatRate: 20 },
  'Europe/Amsterdam': { currency: 'EUR', vatRate: 21 },
  'Europe/Brussels': { currency: 'EUR', vatRate: 21 },
  'Europe/Madrid': { currency: 'EUR', vatRate: 21 },
  'Europe/Rome': { currency: 'EUR', vatRate: 22 },
  'Europe/Riga': { currency: 'EUR', vatRate: 21 },
  'Europe/Vilnius': { currency: 'EUR', vatRate: 21 },
  'Europe/Tallinn': { currency: 'EUR', vatRate: 24 },
  'Europe/Helsinki': { currency: 'EUR', vatRate: 25.5 },
};

export function localDefaults(timeZone: string): { currency: string; vatRate: number } | null {
  return LOCAL_DEFAULTS[timeZone] ?? null;
}

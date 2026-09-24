/**
 * Claim lexicons for the six supported languages (PLAN.md §11, Q14):
 * EN, DE, NL, FR, ES, LV. Patterns are regex sources matched case-
 * insensitively with Unicode-aware word boundaries (see wordRegex).
 * Every lexicon is applied to every reply, whatever language it claims to be.
 */

export const SUPPORTED_LANGUAGES = ['en', 'de', 'nl', 'fr', 'es', 'lv'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export function isSupportedLanguage(code: string | null | undefined): code is SupportedLanguage {
  return SUPPORTED_LANGUAGES.includes((code ?? '').toLowerCase() as SupportedLanguage);
}

/** Concepts whose mere mention is a commitment that must be backed by a cited source. */
export type ConceptGroup = 'discount' | 'free' | 'availability' | 'guarantee' | 'relative_time';

type Lexicon = Record<SupportedLanguage, string[]>;

export const CONCEPTS: Record<ConceptGroup, Lexicon> = {
  discount: {
    en: [
      'discount\\p{L}*',
      'coupons?',
      'promo(?:tion(?:al)?)?\\s?codes?',
      'vouchers?',
      'sale price',
      'reduced price',
      'special (?:offer|price)',
      '\\d+\\s?%\\s?off',
    ],
    de: [
      'rabatt\\p{L}*',
      'nachlass\\p{L}*',
      'preisnachlass\\p{L}*',
      'gutschein\\p{L}*',
      'sonderpreis\\p{L}*',
      'aktionspreis\\p{L}*',
      'skonto',
    ],
    nl: ['korting\\p{L}*', 'actieprijs\\p{L}*', 'aanbieding\\p{L}*', 'waardebon\\p{L}*'],
    fr: ['remises?', 'réductions?', 'rabais', 'codes? promo', 'prix spécial', 'bons? de réduction'],
    es: [
      'descuentos?',
      'rebajas?',
      'cupón',
      'cupones',
      'códigos? promocional(?:es)?',
      'precio especial',
    ],
    lv: [
      'atlaid\\p{L}*',
      'kupon\\p{L}*',
      'akcijas cen\\p{L}*',
      'īpaš\\p{L}* cen\\p{L}*',
      'dāvanu kart\\p{L}*',
    ],
  },
  free: {
    en: [
      '(?<!feel\\s)free(?!\\s+to)',
      'free of charge',
      'at no (?:extra |additional )?cost',
      'complimentary',
      'no charge',
    ],
    de: ['kostenlos\\p{L}*', 'gratis', 'umsonst', 'versandkostenfrei', 'gebührenfrei'],
    nl: ['gratis', 'kosteloos', 'kostenloos', 'zonder kosten'],
    fr: ['gratuit\\p{L}*', 'offerts?', 'offertes?', 'sans frais'],
    es: ['gratis', 'gratuit\\p{L}*', 'sin (?:coste|costo|cargo)'],
    lv: ['bezmaksas', 'bez maksas', 'par brīvu'],
  },
  availability: {
    en: [
      'in stock',
      'out of stock',
      'sold out',
      'back in stock',
      '(?:is|are)\\s+(?:currently\\s+|now\\s+|still\\s+)?available',
      'available (?:now|immediately|from|for (?:delivery|pickup|collection))',
      'ready to ship',
      'ships? (?:today|tomorrow|within)',
    ],
    de: ['auf lager', 'vorrätig', 'lieferbar', 'ausverkauft', 'verfügbar', 'versandbereit'],
    nl: ['op voorraad', 'leverbaar', 'uitverkocht', 'beschikbaar'],
    fr: ['en stock', 'disponibles?', 'épuisée?s?', 'rupture de stock'],
    es: ['en stock', 'disponibles?', 'agotad[oa]s?', 'en existencias?'],
    lv: ['noliktavā', 'pieejam\\p{L}*', 'izpārdot\\p{L}*', 'ir uz vietas'],
  },
  guarantee: {
    en: [
      'guarantee\\p{L}*',
      'warrant(?:y|ies|ied)',
      'promis\\p{L}*',
      'assur(?:e|ed|ance)',
      'money[- ]back',
      'refund\\p{L}*',
    ],
    de: [
      'garantie\\p{L}*',
      'garantier\\p{L}*',
      'versprech\\p{L}*',
      'versproch\\p{L}*',
      'zusicher\\p{L}*',
      'geld[- ]zurück',
      'rückerstatt\\p{L}*',
      'erstatt\\p{L}*',
    ],
    nl: [
      'garantie\\p{L}*',
      'garander\\p{L}*',
      'beloof\\p{L}*',
      'belooft',
      'beloven',
      'geld[- ]terug',
      'terugbetal\\p{L}*',
    ],
    fr: ['garanti\\p{L}*', 'promet\\p{L}*', 'promis\\p{L}*', 'rembours\\p{L}*'],
    es: [
      'garantí\\p{L}*',
      'garantiz\\p{L}*',
      'promet\\p{L}*',
      'reembols\\p{L}*',
      'devolución del dinero',
    ],
    lv: [
      'garantij\\p{L}*',
      'garantē\\p{L}*',
      'apsol\\p{L}*',
      'naudas atmaks\\p{L}*',
      'atmaksā\\p{L}*',
    ],
  },
  relative_time: {
    en: [
      '(?<!(?:contacting|writing|reaching out|messaging|emailing|calling)(?: to)?(?: us)?\\s)today',
      'tonight',
      'tomorrow',
      'next (?:week|month|business day|working day)',
      'this (?:week|afternoon|evening)',
      'same[- ]day',
      'next[- ]day',
      'overnight',
      'asap',
      'right away',
      'by (?:the )?end of (?:the )?(?:day|week|month)',
    ],
    de: [
      'heute',
      '(?<!(?:guten|goede|goeie)\\s)morgen',
      'übermorgen',
      'nächste[nr]? woche',
      'diese woche',
      'noch heute',
      'umgehend',
      'am selben tag',
      'bis ende der woche',
    ],
    nl: [
      'vandaag',
      '(?<!(?:guten|goede|goeie)\\s)morgen',
      'overmorgen',
      'volgende week',
      'deze week',
      'dezelfde dag',
      'vandaag nog',
    ],
    fr: [
      "aujourd['’]hui",
      'demain',
      'après-demain',
      'la semaine prochaine',
      'cette semaine',
      'le jour même',
      'dans la journée',
    ],
    es: [
      'hoy',
      '(?<!(?:la|por la|de la|esta)\\s)mañana',
      'pasado mañana',
      '(?:la )?próxima semana',
      'la semana que viene',
      'esta semana',
      'el mismo día',
    ],
    lv: [
      'šodien',
      'rīt',
      'parīt',
      'nākamnedēļ\\p{L}*',
      'nākamaj\\p{L}* nedēļ\\p{L}*',
      'šonedēļ',
      'tajā pašā dienā',
      'nekavējoties',
    ],
  },
};

export const CURRENCY_SOURCE = String.raw`€|\$|£|¥|eur|usd|gbp|chf|sek|nok|dkk|pln|euros?|eiro|dollars?|pounds?`;

export const PERCENT_SOURCE = String.raw`%|percent|per\s?cent|prozent|procent|pour\s?cent|por\s?ciento|procent\p{L}*`;

export const DURATION_UNIT_SOURCE = [
  // en
  String.raw`(?:business |working |calendar )?(?:days?|hours?|hrs?|weeks?|months?|minutes?|mins?)`,
  // de
  String.raw`(?:werk|arbeits|geschäfts|kalender)?tagen?|tage|stunden?|std\.?|wochen?|monaten?|monate|minuten?`,
  // nl
  String.raw`(?:werk)?dagen|dag|uur|uren|weken|week|maanden|maand|minuten`,
  // fr
  String.raw`jours?(?: ouvrés| ouvrables)?|heures?|semaines?|mois`,
  // es
  String.raw`días?(?: hábiles| laborables)?|horas?|semanas?|meses|mes|minutos?`,
  // lv
  String.raw`(?:darba )?dien\p{L}*|stund\p{L}*|nedēļ\p{L}*|mēne\p{L}*|minūt\p{L}*|h`,
].join('|');

/** Month names by index (1–12) across languages; month-name dates require an adjacent day number. */
export const MONTHS: string[][] = [
  ['january', 'jan', 'januar', 'jänner', 'januari', 'janvier', 'enero', 'janvār\\p{L}*'],
  ['february', 'feb', 'februar', 'februari', 'février', 'febrero', 'februār\\p{L}*'],
  ['march', 'mar', 'märz', 'maart', 'mars', 'marzo', 'mart\\p{L}*'],
  ['april', 'apr', 'avril', 'abril', 'aprīl\\p{L}*'],
  ['may', 'mai', 'mei', 'mayo', 'maij\\p{L}*'],
  ['june', 'jun', 'juni', 'juin', 'junio', 'jūnij\\p{L}*'],
  ['july', 'jul', 'juli', 'juillet', 'julio', 'jūlij\\p{L}*'],
  ['august', 'aug', 'augustus', 'août', 'agosto', 'august\\p{L}*'],
  ['september', 'sep', 'sept', 'septembre', 'septiembre', 'septembr\\p{L}*'],
  ['october', 'oct', 'oktober', 'octobre', 'octubre', 'oktobr\\p{L}*'],
  ['november', 'nov', 'novembre', 'noviembre', 'novembr\\p{L}*'],
  ['december', 'dec', 'dezember', 'décembre', 'diciembre', 'decembr\\p{L}*'],
];

/** Weekdays by index (1 = Monday … 7 = Sunday). */
export const WEEKDAYS: string[][] = [
  ['monday', 'montag', 'maandag', 'lundi', 'lunes', 'pirmdien\\p{L}*'],
  ['tuesday', 'dienstag', 'dinsdag', 'mardi', 'martes', 'otrdien\\p{L}*'],
  ['wednesday', 'mittwoch', 'woensdag', 'mercredi', 'mi[eé]rcoles', 'trešdien\\p{L}*'],
  ['thursday', 'donnerstag', 'donderdag', 'jeudi', 'jueves', 'ceturtdien\\p{L}*'],
  ['friday', 'freitag', 'vrijdag', 'vendredi', 'viernes', 'piektdien\\p{L}*'],
  ['saturday', 'samstag', 'sonnabend', 'zaterdag', 'samedi', 's[aá]bados?', 'sestdien\\p{L}*'],
  ['sunday', 'sonntag', 'zondag', 'dimanche', 'domingos?', 'svētdien\\p{L}*'],
];

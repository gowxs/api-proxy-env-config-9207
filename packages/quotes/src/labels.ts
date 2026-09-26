/**
 * Fixed labels for the quote PDF and the customer's accept page, in the
 * quote's language (the customer's). Unknown languages fall back to English.
 */
export const QUOTE_LANGUAGES = ['en', 'de', 'lv', 'nl', 'fr', 'es'] as const;
export type QuoteLanguage = (typeof QUOTE_LANGUAGES)[number];

export const quoteLang = (l: string | null | undefined): QuoteLanguage =>
  (QUOTE_LANGUAGES as readonly string[]).includes(l ?? '') ? (l as QuoteLanguage) : 'en';

const LOCALE: Record<QuoteLanguage, string> = {
  en: 'en-GB',
  de: 'de-DE',
  lv: 'lv-LV',
  nl: 'nl-NL',
  fr: 'fr-FR',
  es: 'es-ES',
};
export const quoteLocale = (l: string | null | undefined) => LOCALE[quoteLang(l)];

export interface QuoteLabels {
  quote: string;
  date: string;
  validUntil: string;
  from: string;
  for: string;
  item: string;
  qty: string;
  unitPrice: string;
  lineTotal: string;
  subtotal: string;
  total: string;
  /** Rate already formatted for the locale ("21", "5,5"). */
  vat: (rate: string) => string;
  ofWhichVat: (rate: string) => string;
  notes: string;
  acceptOnline: (date: string) => string;
  acceptButton: string;
  downloadPdf: string;
  /** Billing details asked before accepting (for the invoice). */
  billingHeading: string;
  billingIntro: string;
  billingName: string;
  billingAddress: string;
  billingRegNo: string;
  billingVatNo: string;
  optional: string;
  required: string;
  vatInvalid: string;
  fixBelow: string;
  accepted: string;
  expired: string;
  rejected: string;
  linkExpired: string;
  linkInvalid: string;
  notFound: string;
  askNew: string;
  replyToEmail: string;
}

export const QUOTE_LABELS: Record<QuoteLanguage, QuoteLabels> = {
  en: {
    quote: 'Quote',
    date: 'Date',
    validUntil: 'Valid until',
    from: 'FROM',
    for: 'FOR',
    item: 'ITEM',
    qty: 'QTY',
    unitPrice: 'UNIT PRICE',
    lineTotal: 'TOTAL',
    subtotal: 'Subtotal',
    total: 'Total',
    vat: (r) => `VAT ${r}%`,
    ofWhichVat: (r) => `of which VAT ${r}%`,
    notes: 'NOTES',
    acceptOnline: (d) => `Accept this quote online (valid until ${d}):`,
    acceptButton: 'Accept quote',
    billingHeading: 'Billing details',
    billingIntro: 'For the invoice. We use them only for this order.',
    billingName: 'Company or name',
    billingAddress: 'Billing address',
    billingRegNo: 'Registration number',
    billingVatNo: 'VAT number',
    optional: 'optional',
    required: 'Please fill this in.',
    vatInvalid: 'This VAT number looks wrong. Use the country prefix, e.g. LV40003123456.',
    fixBelow: 'Please check the details below.',
    downloadPdf: 'Download PDF',
    accepted: 'You accepted this quote. Thank you — we will be in touch.',
    expired: 'This quote has expired. Reply to our e-mail to ask for a new one.',
    rejected: 'This quote is no longer available. Reply to our e-mail if you have questions.',
    linkExpired: 'This link has expired',
    linkInvalid: 'Link not valid',
    notFound: 'Quote not found',
    askNew: 'Reply to the e-mail you received to ask for a new quote.',
    replyToEmail: 'Reply to the e-mail you received.',
  },
  de: {
    quote: 'Angebot',
    date: 'Datum',
    validUntil: 'Gültig bis',
    from: 'VON',
    for: 'FÜR',
    item: 'POSITION',
    qty: 'MENGE',
    unitPrice: 'EINZELPREIS',
    lineTotal: 'GESAMT',
    subtotal: 'Zwischensumme',
    total: 'Gesamt',
    vat: (r) => `MwSt. ${r} %`,
    ofWhichVat: (r) => `darin enthalten MwSt. ${r} %`,
    notes: 'HINWEISE',
    acceptOnline: (d) => `Nehmen Sie dieses Angebot online an (gültig bis ${d}):`,
    acceptButton: 'Angebot annehmen',
    billingHeading: 'Rechnungsdaten',
    billingIntro: 'Für die Rechnung. Wir verwenden sie nur für diesen Auftrag.',
    billingName: 'Firma oder Name',
    billingAddress: 'Rechnungsadresse',
    billingRegNo: 'Registernummer',
    billingVatNo: 'USt-IdNr.',
    optional: 'optional',
    required: 'Bitte ausfüllen.',
    vatInvalid: 'Diese USt-IdNr. scheint falsch. Bitte mit Länderkennung, z. B. DE123456789.',
    fixBelow: 'Bitte prüfen Sie die Angaben unten.',
    downloadPdf: 'PDF herunterladen',
    accepted: 'Sie haben dieses Angebot angenommen. Vielen Dank – wir melden uns bei Ihnen.',
    expired:
      'Dieses Angebot ist abgelaufen. Antworten Sie auf unsere E-Mail, um ein neues anzufordern.',
    rejected:
      'Dieses Angebot ist nicht mehr verfügbar. Antworten Sie auf unsere E-Mail, wenn Sie Fragen haben.',
    linkExpired: 'Dieser Link ist abgelaufen',
    linkInvalid: 'Link ungültig',
    notFound: 'Angebot nicht gefunden',
    askNew: 'Antworten Sie auf die erhaltene E-Mail, um ein neues Angebot anzufordern.',
    replyToEmail: 'Antworten Sie auf die erhaltene E-Mail.',
  },
  lv: {
    quote: 'Piedāvājums',
    date: 'Datums',
    validUntil: 'Derīgs līdz',
    from: 'NO',
    for: 'KAM',
    item: 'POZĪCIJA',
    qty: 'DAUDZ.',
    unitPrice: 'VIEN. CENA',
    lineTotal: 'SUMMA',
    subtotal: 'Starpsumma',
    total: 'Kopā',
    vat: (r) => `PVN ${r}%`,
    ofWhichVat: (r) => `t. sk. PVN ${r}%`,
    notes: 'PIEZĪMES',
    acceptOnline: (d) => `Apstipriniet šo piedāvājumu tiešsaistē (derīgs līdz ${d}):`,
    acceptButton: 'Apstiprināt piedāvājumu',
    billingHeading: 'Rēķina rekvizīti',
    billingIntro: 'Rēķinam. Tos izmantojam tikai šim pasūtījumam.',
    billingName: 'Uzņēmums vai vārds',
    billingAddress: 'Juridiskā adrese',
    billingRegNo: 'Reģistrācijas numurs',
    billingVatNo: 'PVN numurs',
    optional: 'nav obligāts',
    required: 'Lūdzu, aizpildiet.',
    vatInvalid: 'Šķiet, ka PVN numurs nav pareizs. Norādiet ar valsts kodu, piem., LV40003123456.',
    fixBelow: 'Lūdzu, pārbaudiet datus zemāk.',
    downloadPdf: 'Lejupielādēt PDF',
    accepted: 'Jūs apstiprinājāt šo piedāvājumu. Paldies — mēs ar jums sazināsimies.',
    expired:
      'Šī piedāvājuma derīguma termiņš ir beidzies. Atbildiet uz mūsu e-pastu, lai saņemtu jaunu.',
    rejected:
      'Šis piedāvājums vairs nav pieejams. Ja jums ir jautājumi, atbildiet uz mūsu e-pastu.',
    linkExpired: 'Šīs saites derīguma termiņš ir beidzies',
    linkInvalid: 'Saite nav derīga',
    notFound: 'Piedāvājums nav atrasts',
    askNew: 'Atbildiet uz saņemto e-pastu, lai pieprasītu jaunu piedāvājumu.',
    replyToEmail: 'Atbildiet uz saņemto e-pastu.',
  },
  nl: {
    quote: 'Offerte',
    date: 'Datum',
    validUntil: 'Geldig tot',
    from: 'VAN',
    for: 'VOOR',
    item: 'ARTIKEL',
    qty: 'AANTAL',
    unitPrice: 'STUKPRIJS',
    lineTotal: 'TOTAAL',
    subtotal: 'Subtotaal',
    total: 'Totaal',
    vat: (r) => `btw ${r}%`,
    ofWhichVat: (r) => `waarvan btw ${r}%`,
    notes: 'OPMERKINGEN',
    acceptOnline: (d) => `Accepteer deze offerte online (geldig tot ${d}):`,
    acceptButton: 'Offerte accepteren',
    billingHeading: 'Factuurgegevens',
    billingIntro: 'Voor de factuur. We gebruiken ze alleen voor deze bestelling.',
    billingName: 'Bedrijf of naam',
    billingAddress: 'Factuuradres',
    billingRegNo: 'KvK-nummer',
    billingVatNo: 'Btw-nummer',
    optional: 'optioneel',
    required: 'Vul dit in.',
    vatInvalid: 'Dit btw-nummer lijkt niet te kloppen. Gebruik de landcode, bijv. NL123456789B01.',
    fixBelow: 'Controleer de gegevens hieronder.',
    downloadPdf: 'PDF downloaden',
    accepted: 'U hebt deze offerte geaccepteerd. Dank u – we nemen contact met u op.',
    expired: 'Deze offerte is verlopen. Beantwoord onze e-mail om een nieuwe aan te vragen.',
    rejected: 'Deze offerte is niet meer beschikbaar. Beantwoord onze e-mail als u vragen hebt.',
    linkExpired: 'Deze link is verlopen',
    linkInvalid: 'Link ongeldig',
    notFound: 'Offerte niet gevonden',
    askNew: 'Beantwoord de e-mail die u hebt ontvangen om een nieuwe offerte aan te vragen.',
    replyToEmail: 'Beantwoord de e-mail die u hebt ontvangen.',
  },
  fr: {
    quote: 'Devis',
    date: 'Date',
    validUntil: 'Valable jusqu’au',
    from: 'DE',
    for: 'POUR',
    item: 'ARTICLE',
    qty: 'QTÉ',
    unitPrice: 'PRIX UNITAIRE',
    lineTotal: 'TOTAL',
    subtotal: 'Sous-total',
    total: 'Total',
    vat: (r) => `TVA ${r} %`,
    ofWhichVat: (r) => `dont TVA ${r} %`,
    notes: 'REMARQUES',
    acceptOnline: (d) => `Acceptez ce devis en ligne (valable jusqu’au ${d}) :`,
    acceptButton: 'Accepter le devis',
    billingHeading: 'Coordonnées de facturation',
    billingIntro: 'Pour la facture. Nous les utilisons uniquement pour cette commande.',
    billingName: 'Société ou nom',
    billingAddress: 'Adresse de facturation',
    billingRegNo: 'Numéro d’immatriculation',
    billingVatNo: 'Numéro de TVA',
    optional: 'facultatif',
    required: 'Veuillez remplir ce champ.',
    vatInvalid:
      'Ce numéro de TVA semble incorrect. Indiquez le préfixe du pays, par ex. FR12345678901.',
    fixBelow: 'Veuillez vérifier les informations ci-dessous.',
    downloadPdf: 'Télécharger le PDF',
    accepted: 'Vous avez accepté ce devis. Merci, nous reviendrons vers vous.',
    expired: 'Ce devis a expiré. Répondez à notre e-mail pour en demander un nouveau.',
    rejected: 'Ce devis n’est plus disponible. Répondez à notre e-mail si vous avez des questions.',
    linkExpired: 'Ce lien a expiré',
    linkInvalid: 'Lien non valide',
    notFound: 'Devis introuvable',
    askNew: 'Répondez à l’e-mail reçu pour demander un nouveau devis.',
    replyToEmail: 'Répondez à l’e-mail reçu.',
  },
  es: {
    quote: 'Presupuesto',
    date: 'Fecha',
    validUntil: 'Válido hasta el',
    from: 'DE',
    for: 'PARA',
    item: 'CONCEPTO',
    qty: 'CANT.',
    unitPrice: 'PRECIO UNIT.',
    lineTotal: 'TOTAL',
    subtotal: 'Subtotal',
    total: 'Total',
    vat: (r) => `IVA ${r} %`,
    ofWhichVat: (r) => `IVA incluido ${r} %`,
    notes: 'NOTAS',
    acceptOnline: (d) => `Acepte este presupuesto en línea (válido hasta el ${d}):`,
    acceptButton: 'Aceptar presupuesto',
    billingHeading: 'Datos de facturación',
    billingIntro: 'Para la factura. Solo los usamos para este pedido.',
    billingName: 'Empresa o nombre',
    billingAddress: 'Dirección de facturación',
    billingRegNo: 'Número de registro',
    billingVatNo: 'NIF-IVA',
    optional: 'opcional',
    required: 'Rellene este campo.',
    vatInvalid: 'Este NIF-IVA no parece correcto. Use el prefijo del país, p. ej. ESB12345678.',
    fixBelow: 'Revise los datos a continuación.',
    downloadPdf: 'Descargar PDF',
    accepted: 'Ha aceptado este presupuesto. Gracias, nos pondremos en contacto con usted.',
    expired: 'Este presupuesto ha caducado. Responda a nuestro correo para pedir uno nuevo.',
    rejected:
      'Este presupuesto ya no está disponible. Responda a nuestro correo si tiene preguntas.',
    linkExpired: 'Este enlace ha caducado',
    linkInvalid: 'Enlace no válido',
    notFound: 'Presupuesto no encontrado',
    askNew: 'Responda al correo que recibió para pedir un nuevo presupuesto.',
    replyToEmail: 'Responda al correo que recibió.',
  },
};

export const quoteLabels = (l: string | null | undefined): QuoteLabels =>
  QUOTE_LABELS[quoteLang(l)];

/** A VAT rate as written in the language: 21 → "21", 5.5 → "5,5" (de, lv, …). */
export const formatRate = (rate: number, l: string | null | undefined) =>
  new Intl.NumberFormat(quoteLocale(l), { maximumFractionDigits: 2 }).format(rate);

/**
 * For pages with no quote to read the language from (a bad or expired
 * link): the first supported language in the browser's Accept-Language.
 */
export function languageFromAcceptHeader(header: string | undefined): QuoteLanguage {
  for (const part of (header ?? '').split(',')) {
    const code = part.trim().slice(0, 2).toLowerCase();
    if ((QUOTE_LANGUAGES as readonly string[]).includes(code)) return code as QuoteLanguage;
  }
  return 'en';
}

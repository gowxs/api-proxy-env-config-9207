import { quoteLang, type QuoteLanguage } from '@noctiv/quotes';

/** Invoice and delivery-note labels in the customer's language (en, de, lv, nl, fr, es). */
export interface DocLabels {
  invoice: string;
  deliveryNote: string;
  date: string;
  dueDate: string;
  supplyDate: string;
  seller: string;
  buyer: string;
  supplier: string;
  receiver: string;
  regNo: string;
  vatNo: string;
  item: string;
  qty: string;
  unit: string;
  unitPrice: string;
  lineTotal: string;
  subtotal: string;
  total: string;
  vat: (rate: string) => string;
  ofWhichVat: (rate: string) => string;
  paymentDetails: string;
  bank: string;
  iban: string;
  bic: string;
  reference: string;
  payBy: (date: string) => string;
  reverseCharge: string;
  notes: string;
  loadingAddress: string;
  deliveryAddress: string;
  deliveryDate: string;
  vehicle: string;
  driver: string;
  issuedBy: string;
  receivedBy: string;
  name: string;
  signature: string;
}

export const DOC_LABELS: Record<QuoteLanguage, DocLabels> = {
  en: {
    invoice: 'Invoice',
    deliveryNote: 'Delivery note',
    date: 'Date',
    dueDate: 'Due date',
    supplyDate: 'Supply date',
    seller: 'SELLER',
    buyer: 'BUYER',
    supplier: 'SUPPLIER',
    receiver: 'RECEIVER',
    regNo: 'Reg. no.',
    vatNo: 'VAT no.',
    item: 'ITEM',
    qty: 'QTY',
    unit: 'UNIT',
    unitPrice: 'UNIT PRICE',
    lineTotal: 'TOTAL',
    subtotal: 'Subtotal',
    total: 'Total',
    vat: (r) => `VAT ${r}%`,
    ofWhichVat: (r) => `of which VAT ${r}%`,
    paymentDetails: 'PAYMENT DETAILS',
    bank: 'Bank',
    iban: 'IBAN',
    bic: 'BIC',
    reference: 'Payment reference',
    payBy: (d) => `Please pay by ${d}.`,
    reverseCharge:
      'Reverse charge: VAT to be accounted for by the recipient (Art. 196, Directive 2006/112/EC).',
    notes: 'NOTES',
    loadingAddress: 'Loading address',
    deliveryAddress: 'Delivery address',
    deliveryDate: 'Delivery date',
    vehicle: 'Vehicle',
    driver: 'Driver',
    issuedBy: 'ISSUED BY',
    receivedBy: 'RECEIVED BY',
    name: 'Name',
    signature: 'Signature',
  },
  de: {
    invoice: 'Rechnung',
    deliveryNote: 'Lieferschein',
    date: 'Datum',
    dueDate: 'Fällig am',
    supplyDate: 'Leistungsdatum',
    seller: 'VERKÄUFER',
    buyer: 'KÄUFER',
    supplier: 'LIEFERANT',
    receiver: 'EMPFÄNGER',
    regNo: 'Reg.-Nr.',
    vatNo: 'USt-IdNr.',
    item: 'POSITION',
    qty: 'MENGE',
    unit: 'EINHEIT',
    unitPrice: 'EINZELPREIS',
    lineTotal: 'GESAMT',
    subtotal: 'Zwischensumme',
    total: 'Gesamt',
    vat: (r) => `MwSt. ${r} %`,
    ofWhichVat: (r) => `darin enthalten MwSt. ${r} %`,
    paymentDetails: 'ZAHLUNGSDETAILS',
    bank: 'Bank',
    iban: 'IBAN',
    bic: 'BIC',
    reference: 'Verwendungszweck',
    payBy: (d) => `Bitte zahlen Sie bis ${d}.`,
    reverseCharge:
      'Steuerschuldnerschaft des Leistungsempfängers (Art. 196 MwSt-Systemrichtlinie 2006/112/EG).',
    notes: 'HINWEISE',
    loadingAddress: 'Ladeadresse',
    deliveryAddress: 'Lieferadresse',
    deliveryDate: 'Lieferdatum',
    vehicle: 'Fahrzeug',
    driver: 'Fahrer',
    issuedBy: 'AUSGEGEBEN VON',
    receivedBy: 'ERHALTEN VON',
    name: 'Name',
    signature: 'Unterschrift',
  },
  lv: {
    invoice: 'Rēķins',
    deliveryNote: 'Preču pavadzīme',
    date: 'Datums',
    dueDate: 'Apmaksas termiņš',
    supplyDate: 'Piegādes datums',
    seller: 'PĀRDEVĒJS',
    buyer: 'PIRCĒJS',
    supplier: 'PIEGĀDĀTĀJS',
    receiver: 'SAŅĒMĒJS',
    regNo: 'Reģ. Nr.',
    vatNo: 'PVN Nr.',
    item: 'POZĪCIJA',
    qty: 'DAUDZ.',
    unit: 'MĒRV.',
    unitPrice: 'VIEN. CENA',
    lineTotal: 'SUMMA',
    subtotal: 'Starpsumma',
    total: 'Kopā',
    vat: (r) => `PVN ${r}%`,
    ofWhichVat: (r) => `t. sk. PVN ${r}%`,
    paymentDetails: 'MAKSĀJUMA REKVIZĪTI',
    bank: 'Banka',
    iban: 'Konts (IBAN)',
    bic: 'BIC',
    reference: 'Maksājuma mērķis',
    payBy: (d) => `Lūdzam apmaksāt līdz ${d}.`,
    reverseCharge:
      'Nodokļa apgrieztā maksāšana: PVN maksā pakalpojuma saņēmējs (Direktīvas 2006/112/EK 196. pants).',
    notes: 'PIEZĪMES',
    loadingAddress: 'Iekraušanas adrese',
    deliveryAddress: 'Piegādes adrese',
    deliveryDate: 'Piegādes datums',
    vehicle: 'Transportlīdzeklis',
    driver: 'Vadītājs',
    issuedBy: 'IZSNIEDZA',
    receivedBy: 'SAŅĒMA',
    name: 'Vārds, uzvārds',
    signature: 'Paraksts',
  },
  nl: {
    invoice: 'Factuur',
    deliveryNote: 'Pakbon',
    date: 'Datum',
    dueDate: 'Vervaldatum',
    supplyDate: 'Leveringsdatum',
    seller: 'VERKOPER',
    buyer: 'KOPER',
    supplier: 'LEVERANCIER',
    receiver: 'ONTVANGER',
    regNo: 'Reg.nr.',
    vatNo: 'Btw-nr.',
    item: 'ARTIKEL',
    qty: 'AANTAL',
    unit: 'EENHEID',
    unitPrice: 'STUKPRIJS',
    lineTotal: 'TOTAAL',
    subtotal: 'Subtotaal',
    total: 'Totaal',
    vat: (r) => `btw ${r}%`,
    ofWhichVat: (r) => `waarvan btw ${r}%`,
    paymentDetails: 'BETAALGEGEVENS',
    bank: 'Bank',
    iban: 'IBAN',
    bic: 'BIC',
    reference: 'Betalingskenmerk',
    payBy: (d) => `Graag betalen vóór ${d}.`,
    reverseCharge: 'Btw verlegd naar de afnemer (art. 196 Btw-richtlijn 2006/112/EG).',
    notes: 'OPMERKINGEN',
    loadingAddress: 'Laadadres',
    deliveryAddress: 'Afleveradres',
    deliveryDate: 'Leveringsdatum',
    vehicle: 'Voertuig',
    driver: 'Chauffeur',
    issuedBy: 'AFGEGEVEN DOOR',
    receivedBy: 'ONTVANGEN DOOR',
    name: 'Naam',
    signature: 'Handtekening',
  },
  fr: {
    invoice: 'Facture',
    deliveryNote: 'Bon de livraison',
    date: 'Date',
    dueDate: 'Échéance',
    supplyDate: 'Date de livraison',
    seller: 'VENDEUR',
    buyer: 'ACHETEUR',
    supplier: 'FOURNISSEUR',
    receiver: 'DESTINATAIRE',
    regNo: 'N° d’enreg.',
    vatNo: 'N° TVA',
    item: 'ARTICLE',
    qty: 'QTÉ',
    unit: 'UNITÉ',
    unitPrice: 'PRIX UNITAIRE',
    lineTotal: 'TOTAL',
    subtotal: 'Sous-total',
    total: 'Total',
    vat: (r) => `TVA ${r} %`,
    ofWhichVat: (r) => `dont TVA ${r} %`,
    paymentDetails: 'COORDONNÉES BANCAIRES',
    bank: 'Banque',
    iban: 'IBAN',
    bic: 'BIC',
    reference: 'Référence de paiement',
    payBy: (d) => `Merci de régler avant le ${d}.`,
    reverseCharge:
      'Autoliquidation : TVA due par le preneur (art. 196 de la directive 2006/112/CE).',
    notes: 'REMARQUES',
    loadingAddress: 'Adresse de chargement',
    deliveryAddress: 'Adresse de livraison',
    deliveryDate: 'Date de livraison',
    vehicle: 'Véhicule',
    driver: 'Chauffeur',
    issuedBy: 'REMIS PAR',
    receivedBy: 'REÇU PAR',
    name: 'Nom',
    signature: 'Signature',
  },
  es: {
    invoice: 'Factura',
    deliveryNote: 'Albarán',
    date: 'Fecha',
    dueDate: 'Vencimiento',
    supplyDate: 'Fecha de operación',
    seller: 'VENDEDOR',
    buyer: 'COMPRADOR',
    supplier: 'PROVEEDOR',
    receiver: 'DESTINATARIO',
    regNo: 'N.º registro',
    vatNo: 'NIF-IVA',
    item: 'CONCEPTO',
    qty: 'CANT.',
    unit: 'UNIDAD',
    unitPrice: 'PRECIO UNIT.',
    lineTotal: 'TOTAL',
    subtotal: 'Subtotal',
    total: 'Total',
    vat: (r) => `IVA ${r} %`,
    ofWhichVat: (r) => `IVA incluido ${r} %`,
    paymentDetails: 'DATOS DE PAGO',
    bank: 'Banco',
    iban: 'IBAN',
    bic: 'BIC',
    reference: 'Referencia de pago',
    payBy: (d) => `Por favor, pague antes del ${d}.`,
    reverseCharge: 'Inversión del sujeto pasivo (art. 196 de la Directiva 2006/112/CE).',
    notes: 'NOTAS',
    loadingAddress: 'Dirección de carga',
    deliveryAddress: 'Dirección de entrega',
    deliveryDate: 'Fecha de entrega',
    vehicle: 'Vehículo',
    driver: 'Conductor',
    issuedBy: 'ENTREGADO POR',
    receivedBy: 'RECIBIDO POR',
    name: 'Nombre',
    signature: 'Firma',
  },
};

export const docLabels = (l: string | null | undefined): DocLabels => DOC_LABELS[quoteLang(l)];

/** CMR box labels: the standard English/French bilingual form. */
export const CMR_LABELS = {
  title: 'INTERNATIONAL CONSIGNMENT NOTE',
  titleFr: 'LETTRE DE VOITURE INTERNATIONALE',
  box: {
    1: ['Sender (name, address, country)', 'Expéditeur (nom, adresse, pays)'],
    2: ['Consignee (name, address, country)', 'Destinataire (nom, adresse, pays)'],
    3: [
      'Place of delivery of the goods (place, country)',
      'Lieu prévu pour la livraison de la marchandise (lieu, pays)',
    ],
    4: [
      'Place and date of taking over the goods (place, country, date)',
      'Lieu et date de la prise en charge de la marchandise (lieu, pays, date)',
    ],
    5: ['Documents attached', 'Documents annexés'],
    6: ['Marks and Nos', 'Marques et numéros'],
    7: ['Number of packages', 'Nombre des colis'],
    8: ['Method of packing', 'Mode d’emballage'],
    9: ['Nature of the goods', 'Nature de la marchandise'],
    10: ['Statistical number', 'No statistique'],
    11: ['Gross weight in kg', 'Poids brut, kg'],
    12: ['Volume in m³', 'Cubage m³'],
    13: ['Sender’s instructions', 'Instructions de l’expéditeur'],
    14: ['Instructions as to payment for carriage', 'Prescriptions d’affranchissement'],
    15: ['Cash on delivery', 'Remboursement'],
    16: ['Carrier (name, address, country)', 'Transporteur (nom, adresse, pays)'],
    17: ['Successive carriers', 'Transporteurs successifs'],
    18: ['Carrier’s reservations and observations', 'Réserves et observations du transporteur'],
    19: ['Special agreements', 'Conventions particulières'],
    20: ['To be paid by', 'À payer par'],
    21: ['Established in … on …', 'Établie à … le …'],
    22: ['Signature and stamp of the sender', 'Signature et timbre de l’expéditeur'],
    23: ['Signature and stamp of the carrier', 'Signature et timbre du transporteur'],
    24: [
      'Goods received: signature and stamp of the consignee',
      'Marchandises reçues : signature et timbre du destinataire',
    ],
  } as Record<number, [string, string]>,
  paid: 'Carriage paid / Franco',
  forward: 'Carriage forward / Non franco',
  vehicle: 'Vehicle registration / Immatriculation',
  tractor: 'Tractor / Tracteur',
  trailer: 'Trailer / Remorque',
  placeDate: 'Place / Lieu, date',
  clause:
    'This carriage is subject, notwithstanding any clause to the contrary, to the Convention on the Contract for the International Carriage of Goods by Road (CMR).',
  clauseFr:
    'Ce transport est soumis, nonobstant toute clause contraire, à la Convention relative au contrat de transport international de marchandises par route (CMR).',
  copies: [
    { n: 1, en: 'Copy for sender', fr: 'Exemplaire de l’expéditeur', color: '#C62828' },
    { n: 2, en: 'Copy for consignee', fr: 'Exemplaire du destinataire', color: '#1565C0' },
    { n: 3, en: 'Copy for carrier', fr: 'Exemplaire du transporteur', color: '#2E7D32' },
    { n: 4, en: 'Extra copy', fr: 'Exemplaire supplémentaire', color: '#1F2430' },
  ],
} as const;

/**
 * Units are the owner's free text ("box", "Stunde", "pcs"). Common ones get
 * their plural for any quantity other than 1 (QA #25: "2 box", "4 Stunde");
 * anything unknown is printed as written.
 */
const PLURALS: Record<string, Record<string, string>> = {
  en: {
    box: 'boxes',
    piece: 'pieces',
    item: 'items',
    unit: 'units',
    hour: 'hours',
    day: 'days',
    week: 'weeks',
    month: 'months',
    year: 'years',
    page: 'pages',
    set: 'sets',
    pack: 'packs',
    packet: 'packets',
    bag: 'bags',
    bottle: 'bottles',
    jar: 'jars',
    roll: 'rolls',
    pair: 'pairs',
    case: 'cases',
    crate: 'crates',
    pallet: 'pallets',
    sheet: 'sheets',
    session: 'sessions',
    visit: 'visits',
    night: 'nights',
    person: 'people',
    ticket: 'tickets',
    licence: 'licences',
    license: 'licenses',
    seat: 'seats',
    candle: 'candles',
  },
  de: {
    stunde: 'Stunden',
    tag: 'Tage',
    woche: 'Wochen',
    monat: 'Monate',
    jahr: 'Jahre',
    seite: 'Seiten',
    karton: 'Kartons',
    packung: 'Packungen',
    box: 'Boxen',
    flasche: 'Flaschen',
    rolle: 'Rollen',
    palette: 'Paletten',
    kiste: 'Kisten',
    person: 'Personen',
    nacht: 'Nächte',
    lizenz: 'Lizenzen',
    einheit: 'Einheiten',
    set: 'Sets',
    tüte: 'Tüten',
    dose: 'Dosen',
  },
  lv: {
    stunda: 'stundas',
    diena: 'dienas',
    nedēļa: 'nedēļas',
    kaste: 'kastes',
    pudele: 'pudeles',
    palete: 'paletes',
    lapa: 'lapas',
    vienība: 'vienības',
    nakts: 'naktis',
  },
  nl: {
    dag: 'dagen',
    week: 'weken',
    maand: 'maanden',
    doos: 'dozen',
    stuk: 'stuks',
    fles: 'flessen',
    pagina: "pagina's",
    doosje: 'doosjes',
    pallet: 'pallets',
    nacht: 'nachten',
  },
  fr: {
    heure: 'heures',
    jour: 'jours',
    semaine: 'semaines',
    boîte: 'boîtes',
    pièce: 'pièces',
    bouteille: 'bouteilles',
    page: 'pages',
    carton: 'cartons',
    palette: 'palettes',
    nuit: 'nuits',
    unité: 'unités',
    personne: 'personnes',
  },
  es: {
    hora: 'horas',
    día: 'días',
    semana: 'semanas',
    mes: 'meses',
    caja: 'cajas',
    pieza: 'piezas',
    unidad: 'unidades',
    botella: 'botellas',
    página: 'páginas',
    noche: 'noches',
    persona: 'personas',
  },
};

/** The unit as printed after a quantity: "2 boxes", "1 box", "4 Stunden", "3 pcs". */
export function unitFor(unit: string, qty: number | null, language: string | null): string {
  if (qty === null || qty === 1) return unit;
  const lang = (language ?? 'en').slice(0, 2).toLowerCase();
  const key = unit.trim().toLowerCase();
  const plural = PLURALS[lang]?.[key] ?? (lang === 'en' ? undefined : PLURALS.en![key]);
  if (!plural) return unit;
  const first = unit.trim()[0]!;
  // Keep the owner's capitalisation ("Box" → "Boxes"); German nouns are capitalised anyway.
  return first !== first.toLowerCase() ? plural[0]!.toUpperCase() + plural.slice(1) : plural;
}

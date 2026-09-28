import {
  bookingLang,
  formatDay,
  formatTime,
  formatWhen,
  zoneName,
  type BookingLanguage as Lang,
} from './labels.ts';
import type { LocationKind } from './settings.ts';
import type { Slot } from './slots.ts';

/**
 * Fixed texts for Bookings (PLAN.md §29.5, §29.6): the reply that offers
 * times and the e-mails to the customer. Code fills in every name, time and
 * link; the model writes none of it. The business's signature and e-mail
 * design are added when the e-mail is sent.
 */
const T: Record<
  Lang,
  {
    hello: (name: string | null) => string;
    offerIntro: string;
    offerTimes: (zone: string) => string;
    offerLink: (url: string) => string;
    offerNone: string;
    bookedSubject: (when: string) => string;
    booked: (when: string) => string;
    movedSubject: (when: string) => string;
    moved: (when: string) => string;
    cancelledSubject: (when: string) => string;
    cancelledByCustomer: (when: string) => string;
    cancelledByOwner: (when: string) => string;
    bookAgain: (url: string) => string;
    where: Record<LocationKind, (text: string) => string>;
    manage: (url: string) => string;
    ics: string;
  }
> = {
  en: {
    hello: (n) => (n ? `Hello ${n},` : 'Hello,'),
    offerIntro: 'Thank you for your message. Happy to find a time.',
    offerTimes: (z) => `The next free times are (${z}):`,
    offerLink: (u) => `Book one here: ${u}`,
    offerNone: "If none of them suits you, just reply with a time that works and we'll check.",
    bookedSubject: (w) => `Booked: ${w}`,
    booked: (w) => `thank you for booking. Your appointment is confirmed for ${w}.`,
    movedSubject: (w) => `Moved to ${w}`,
    moved: (w) => `your appointment has been moved to ${w}.`,
    cancelledSubject: (w) => `Cancelled: ${w}`,
    cancelledByCustomer: (w) => `your appointment on ${w} has been cancelled, as you asked.`,
    cancelledByOwner: (w) =>
      `unfortunately we have to cancel your appointment on ${w}. We are sorry for the inconvenience.`,
    bookAgain: (u) => `You can choose a new time here: ${u}`,
    where: {
      in_person: (t) => `Where: ${t}`,
      phone: () => 'We will call you on the number you gave us.',
      online_link: (t) => `Join online: ${t}`,
      google_meet: (t) => `Join online (Google Meet): ${t}`,
    },
    manage: (u) => `To change or cancel: ${u}`,
    ics: 'The calendar entry is attached.',
  },
  de: {
    hello: (n) => (n ? `Hallo ${n},` : 'Hallo,'),
    offerIntro: 'vielen Dank für Ihre Nachricht. Gerne finden wir einen Termin.',
    offerTimes: (z) => `Die nächsten freien Zeiten (${z}):`,
    offerLink: (u) => `Hier können Sie einen Termin buchen: ${u}`,
    offerNone: 'Wenn keine davon passt, antworten Sie einfach mit einer Zeit, die Ihnen passt.',
    bookedSubject: (w) => `Gebucht: ${w}`,
    booked: (w) => `vielen Dank für Ihre Buchung. Ihr Termin am ${w} ist bestätigt.`,
    movedSubject: (w) => `Verschoben auf ${w}`,
    moved: (w) => `Ihr Termin wurde auf ${w} verschoben.`,
    cancelledSubject: (w) => `Abgesagt: ${w}`,
    cancelledByCustomer: (w) => `Ihr Termin am ${w} wurde wie gewünscht abgesagt.`,
    cancelledByOwner: (w) =>
      `leider müssen wir Ihren Termin am ${w} absagen. Bitte entschuldigen Sie die Unannehmlichkeiten.`,
    bookAgain: (u) => `Hier können Sie einen neuen Termin wählen: ${u}`,
    where: {
      in_person: (t) => `Ort: ${t}`,
      phone: () => 'Wir rufen Sie unter der angegebenen Nummer an.',
      online_link: (t) => `Online teilnehmen: ${t}`,
      google_meet: (t) => `Online teilnehmen (Google Meet): ${t}`,
    },
    manage: (u) => `Termin ändern oder absagen: ${u}`,
    ics: 'Der Kalendereintrag ist angehängt.',
  },
  lv: {
    hello: (n) => (n ? `Labdien, ${n}!` : 'Labdien!'),
    offerIntro: 'Paldies par ziņu. Labprāt atradīsim piemērotu laiku.',
    offerTimes: (z) => `Tuvākie brīvie laiki (${z}):`,
    offerLink: (u) => `Pierakstīties var šeit: ${u}`,
    offerNone: 'Ja neviens no tiem neder, vienkārši atbildiet ar sev ērtu laiku.',
    bookedSubject: (w) => `Pieraksts: ${w}`,
    booked: (w) => `Paldies par pierakstu! Jūsu laiks ir apstiprināts: ${w}.`,
    movedSubject: (w) => `Pārcelts uz ${w}`,
    moved: (w) => `Jūsu pieraksts ir pārcelts uz ${w}.`,
    cancelledSubject: (w) => `Atcelts: ${w}`,
    cancelledByCustomer: (w) => `Jūsu pieraksts (${w}) ir atcelts, kā lūdzāt.`,
    cancelledByOwner: (w) =>
      `Diemžēl mums jāatceļ jūsu pieraksts (${w}). Atvainojamies par sagādātajām neērtībām.`,
    bookAgain: (u) => `Jaunu laiku varat izvēlēties šeit: ${u}`,
    where: {
      in_person: (t) => `Vieta: ${t}`,
      phone: () => 'Mēs jums piezvanīsim uz norādīto numuru.',
      online_link: (t) => `Pievienoties tiešsaistē: ${t}`,
      google_meet: (t) => `Pievienoties tiešsaistē (Google Meet): ${t}`,
    },
    manage: (u) => `Lai mainītu vai atceltu: ${u}`,
    ics: 'Kalendāra ieraksts ir pielikumā.',
  },
  nl: {
    hello: (n) => (n ? `Hallo ${n},` : 'Hallo,'),
    offerIntro: 'Dank u voor uw bericht. We plannen graag een afspraak.',
    offerTimes: (z) => `De eerstvolgende vrije tijden (${z}):`,
    offerLink: (u) => `Boek er hier een: ${u}`,
    offerNone: 'Past geen van deze tijden? Antwoord dan met een tijd die u uitkomt.',
    bookedSubject: (w) => `Geboekt: ${w}`,
    booked: (w) => `dank u voor uw boeking. Uw afspraak op ${w} is bevestigd.`,
    movedSubject: (w) => `Verzet naar ${w}`,
    moved: (w) => `uw afspraak is verzet naar ${w}.`,
    cancelledSubject: (w) => `Geannuleerd: ${w}`,
    cancelledByCustomer: (w) => `uw afspraak op ${w} is geannuleerd, zoals u vroeg.`,
    cancelledByOwner: (w) =>
      `helaas moeten we uw afspraak op ${w} annuleren. Excuses voor het ongemak.`,
    bookAgain: (u) => `U kunt hier een nieuwe tijd kiezen: ${u}`,
    where: {
      in_person: (t) => `Waar: ${t}`,
      phone: () => 'We bellen u op het nummer dat u hebt opgegeven.',
      online_link: (t) => `Online deelnemen: ${t}`,
      google_meet: (t) => `Online deelnemen (Google Meet): ${t}`,
    },
    manage: (u) => `Wijzigen of annuleren: ${u}`,
    ics: 'De agenda-afspraak zit in de bijlage.',
  },
  fr: {
    hello: (n) => (n ? `Bonjour ${n},` : 'Bonjour,'),
    offerIntro: 'Merci pour votre message. Trouvons un moment.',
    offerTimes: (z) => `Les prochains créneaux libres (${z}) :`,
    offerLink: (u) => `Réservez-en un ici : ${u}`,
    offerNone: 'Si aucun ne vous convient, répondez simplement avec un horaire qui vous arrange.',
    bookedSubject: (w) => `Réservé : ${w}`,
    booked: (w) => `merci pour votre réservation. Votre rendez-vous du ${w} est confirmé.`,
    movedSubject: (w) => `Déplacé au ${w}`,
    moved: (w) => `votre rendez-vous a été déplacé au ${w}.`,
    cancelledSubject: (w) => `Annulé : ${w}`,
    cancelledByCustomer: (w) => `votre rendez-vous du ${w} a été annulé, comme demandé.`,
    cancelledByOwner: (w) =>
      `nous devons malheureusement annuler votre rendez-vous du ${w}. Veuillez nous en excuser.`,
    bookAgain: (u) => `Vous pouvez choisir un nouvel horaire ici : ${u}`,
    where: {
      in_person: (t) => `Lieu : ${t}`,
      phone: () => 'Nous vous appellerons au numéro indiqué.',
      online_link: (t) => `Rejoindre en ligne : ${t}`,
      google_meet: (t) => `Rejoindre en ligne (Google Meet) : ${t}`,
    },
    manage: (u) => `Pour modifier ou annuler : ${u}`,
    ics: "L'invitation de calendrier est jointe.",
  },
  es: {
    hello: (n) => (n ? `Hola, ${n}:` : 'Hola:'),
    offerIntro: 'Gracias por su mensaje. Con gusto buscamos una hora.',
    offerTimes: (z) => `Las próximas horas libres (${z}):`,
    offerLink: (u) => `Reserve una aquí: ${u}`,
    offerNone: 'Si ninguna le viene bien, responda con una hora que le convenga.',
    bookedSubject: (w) => `Reservado: ${w}`,
    booked: (w) => `gracias por su reserva. Su cita del ${w} está confirmada.`,
    movedSubject: (w) => `Cambiada al ${w}`,
    moved: (w) => `su cita se ha cambiado al ${w}.`,
    cancelledSubject: (w) => `Cancelada: ${w}`,
    cancelledByCustomer: (w) => `su cita del ${w} se ha cancelado, como pidió.`,
    cancelledByOwner: (w) =>
      `lamentablemente tenemos que cancelar su cita del ${w}. Disculpe las molestias.`,
    bookAgain: (u) => `Puede elegir una nueva hora aquí: ${u}`,
    where: {
      in_person: (t) => `Dónde: ${t}`,
      phone: () => 'Le llamaremos al número que nos indicó.',
      online_link: (t) => `Unirse en línea: ${t}`,
      google_meet: (t) => `Unirse en línea (Google Meet): ${t}`,
    },
    manage: (u) => `Para cambiar o cancelar: ${u}`,
    ics: 'La cita de calendario va adjunta.',
  },
};

/**
 * German and Dutch letters continue in lower case after "Hallo …,"; the other
 * languages start the next line with a capital.
 */
const capitalise = (lang: Lang, s: string) =>
  lang === 'de' || lang === 'nl' ? s : s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The times block of a reply: stored on the draft (drafts.booking_offer) so
 * the worker can refresh it at send time when a time has gone.
 */
export function offerBlock(i: {
  language: string | null;
  timeZone: string;
  slots: Slot[];
  bookingUrl: string;
}): string {
  const lang = bookingLang(i.language);
  const t = T[lang];
  return [
    t.offerTimes(zoneName(lang, i.timeZone, i.slots[0]?.start)),
    ...i.slots.map(
      (s) => `• ${formatDay(s.start, lang, i.timeZone)}, ${formatTime(s.start, lang, i.timeZone)}`,
    ),
    '',
    t.offerLink(i.bookingUrl),
  ].join('\n');
}

/** The reply that offers times (the grounded answer, if any, goes below it). */
export function offerText(i: {
  language: string | null;
  customerName: string | null;
  block: string;
}): string {
  const lang = bookingLang(i.language);
  const t = T[lang];
  return [
    t.hello(i.customerName),
    '',
    capitalise(lang, t.offerIntro),
    '',
    i.block,
    '',
    t.offerNone,
  ].join('\n');
}

export type BookingEmailKind = 'booked' | 'moved' | 'cancelled_by_customer' | 'cancelled_by_owner';

export interface BookingEmailInput {
  kind: BookingEmailKind;
  language: string | null;
  customerName: string | null;
  start: Date;
  end: Date;
  timeZone: string;
  locationKind: LocationKind;
  /** Address, meeting URL or Meet link; empty for phone. */
  locationText: string;
  manageUrl: string | null;
  bookingUrl: string | null;
}

/** Subject and text of an e-mail to the customer (an .ics is attached, except for cancellations by the owner). */
export function bookingEmail(i: BookingEmailInput): { subject: string; text: string } {
  const lang = bookingLang(i.language);
  const t = T[lang];
  const zone = zoneName(lang, i.timeZone, i.start);
  const when = `${formatWhen(i.start, i.end, lang, i.timeZone)} (${zone})`;
  const shortWhen = `${formatDay(i.start, lang, i.timeZone)}, ${formatTime(i.start, lang, i.timeZone)}`;
  const lines = [t.hello(i.customerName), ''];
  const cancelled = i.kind === 'cancelled_by_customer' || i.kind === 'cancelled_by_owner';
  const main =
    i.kind === 'booked'
      ? t.booked(when)
      : i.kind === 'moved'
        ? t.moved(when)
        : i.kind === 'cancelled_by_customer'
          ? t.cancelledByCustomer(when)
          : t.cancelledByOwner(when);
  lines.push(capitalise(lang, main));
  if (!cancelled) {
    const where = t.where[i.locationKind](i.locationText);
    if (i.locationKind === 'phone' || i.locationText) lines.push('', where);
    if (i.manageUrl) lines.push('', t.manage(i.manageUrl));
    lines.push('', t.ics);
  } else if (i.bookingUrl) {
    lines.push('', t.bookAgain(i.bookingUrl));
  }
  const subject =
    i.kind === 'booked'
      ? t.bookedSubject(shortWhen)
      : i.kind === 'moved'
        ? t.movedSubject(shortWhen)
        : t.cancelledSubject(shortWhen);
  return { subject, text: lines.join('\n') };
}

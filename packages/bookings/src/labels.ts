/**
 * Labels for the public booking and form pages (PLAN.md §29.4, §29.7), in the
 * customer's language. Unknown languages fall back to English. The owner's own
 * words (form labels, intro, meeting title) are shown as written.
 */
export const BOOKING_LANGUAGES = ['en', 'de', 'lv', 'nl', 'fr', 'es'] as const;
export type BookingLanguage = (typeof BOOKING_LANGUAGES)[number];

export const bookingLang = (l: string | null | undefined): BookingLanguage =>
  (BOOKING_LANGUAGES as readonly string[]).includes(l ?? '') ? (l as BookingLanguage) : 'en';

const LOCALE: Record<BookingLanguage, string> = {
  en: 'en-GB',
  de: 'de-DE',
  lv: 'lv-LV',
  nl: 'nl-NL',
  fr: 'fr-FR',
  es: 'es-ES',
};
export const bookingLocale = (l: string | null | undefined) => LOCALE[bookingLang(l)];

/** First supported language in an Accept-Language header, else English. */
export function languageFromAccept(header: string | undefined): BookingLanguage {
  for (const part of (header ?? '').split(',')) {
    const code = part.trim().slice(0, 2).toLowerCase();
    if ((BOOKING_LANGUAGES as readonly string[]).includes(code)) return code as BookingLanguage;
  }
  return 'en';
}

export interface BookingLabels {
  heading: (business: string) => string;
  intro: string;
  timesIn: (zone: string) => string;
  minutes: (n: number) => string;
  noTimes: string;
  laterDates: string;
  earlierDates: string;
  yourTime: string;
  yourDetails: string;
  name: string;
  email: string;
  phone: string;
  note: string;
  notePlaceholder: string;
  optional: string;
  book: string;
  send: string;
  chooseAnother: string;
  moveHere: string;
  newTime: string;
  choose: string;
  yes: string;
  no: string;
  errors: {
    required: string;
    email: string;
    phone: string;
    number: string;
    date: string;
    choice: string;
    long: string;
  };
  fixBelow: string;
  where: {
    in_person: string;
    phone: string;
    online_link: string;
    google_meet: string;
  };
  meetLater: string;
  bookedTitle: string;
  bookedBody: (email: string) => string;
  addToCalendar: string;
  manageHint: string;
  takenTitle: string;
  takenBody: string;
  waitingTitle: string;
  waitingBody: string;
  manageTitle: string;
  cancel: string;
  cancelQuestion: string;
  cancelYes: string;
  keep: string;
  cancelledTitle: string;
  cancelledBody: string;
  movedTitle: string;
  pastBooking: string;
  closed: string;
  linkExpired: string;
  linkInvalid: string;
  notFound: string;
  writeTo: (email: string) => string;
  formSent: string;
  formSentBody: string;
}

export const BOOKING_LABELS: Record<BookingLanguage, BookingLabels> = {
  en: {
    heading: (b) => `Book a time with ${b}`,
    intro: 'Choose a time that suits you.',
    timesIn: (z) => `Times are shown in ${z}.`,
    minutes: (n) => `${n} minutes`,
    noTimes: 'There are no free times in these days.',
    laterDates: 'Later dates',
    earlierDates: 'Earlier dates',
    yourTime: 'Your time',
    yourDetails: 'Your details',
    name: 'Name',
    email: 'E-mail',
    phone: 'Phone',
    note: 'Anything we should know?',
    notePlaceholder: '',
    optional: 'optional',
    book: 'Book',
    send: 'Send',
    chooseAnother: 'Choose another time',
    moveHere: 'Move my booking',
    newTime: 'New time',
    choose: 'Choose…',
    yes: 'Yes',
    no: 'No',
    errors: {
      required: 'Please fill this in.',
      email: 'Please enter a valid e-mail address.',
      phone: 'Please enter a valid phone number.',
      number: 'Please enter a number.',
      date: 'Please enter a valid date.',
      choice: 'Please choose one of the options.',
      long: 'This is too long.',
    },
    fixBelow: 'Please check the fields marked below.',
    where: {
      in_person: 'Where',
      phone: 'By phone',
      online_link: 'Online',
      google_meet: 'Online (Google Meet)',
    },
    meetLater: 'The link is in your confirmation e-mail.',
    bookedTitle: "You're booked",
    bookedBody: (e) => `We've sent a confirmation to ${e}.`,
    addToCalendar: 'Add to calendar',
    manageHint: 'The e-mail has a link to change or cancel.',
    takenTitle: 'That time was just taken',
    takenBody: 'Please choose another one.',
    waitingTitle: 'Almost done',
    waitingBody: "We're confirming your booking. You'll get an e-mail in a minute.",
    manageTitle: 'Your booking',
    cancel: 'Cancel booking',
    cancelQuestion: 'Cancel this booking?',
    cancelYes: 'Yes, cancel',
    keep: 'Keep it',
    cancelledTitle: 'Your booking is cancelled',
    cancelledBody: "We've sent you a confirmation by e-mail.",
    movedTitle: 'Your booking has been moved',
    pastBooking: 'This meeting has already taken place.',
    closed: 'Online booking is not available at the moment.',
    linkExpired: 'This link has expired.',
    linkInvalid: 'This link is not valid.',
    notFound: 'Page not found.',
    writeTo: (e) => `You can write to us at ${e}.`,
    formSent: 'Thank you!',
    formSentBody: 'Your answers have been sent.',
  },
  de: {
    heading: (b) => `Termin bei ${b} buchen`,
    intro: 'Wählen Sie eine passende Zeit.',
    timesIn: (z) => `Zeitzone: ${z}.`,
    minutes: (n) => `${n} Minuten`,
    noTimes: 'In diesen Tagen sind keine Zeiten frei.',
    laterDates: 'Spätere Termine',
    earlierDates: 'Frühere Termine',
    yourTime: 'Ihr Termin',
    yourDetails: 'Ihre Angaben',
    name: 'Name',
    email: 'E-Mail',
    phone: 'Telefon',
    note: 'Möchten Sie uns vorab etwas mitteilen?',
    notePlaceholder: '',
    optional: 'optional',
    book: 'Buchen',
    send: 'Senden',
    chooseAnother: 'Andere Zeit wählen',
    moveHere: 'Termin verschieben',
    newTime: 'Neuer Termin',
    choose: 'Bitte wählen…',
    yes: 'Ja',
    no: 'Nein',
    errors: {
      required: 'Bitte ausfüllen.',
      email: 'Bitte geben Sie eine gültige E-Mail-Adresse ein.',
      phone: 'Bitte geben Sie eine gültige Telefonnummer ein.',
      number: 'Bitte geben Sie eine Zahl ein.',
      date: 'Bitte geben Sie ein gültiges Datum ein.',
      choice: 'Bitte wählen Sie eine der Möglichkeiten.',
      long: 'Das ist zu lang.',
    },
    fixBelow: 'Bitte prüfen Sie die markierten Felder.',
    where: {
      in_person: 'Ort',
      phone: 'Telefonisch',
      online_link: 'Online',
      google_meet: 'Online (Google Meet)',
    },
    meetLater: 'Den Link finden Sie in der Bestätigungs-E-Mail.',
    bookedTitle: 'Ihr Termin ist gebucht',
    bookedBody: (e) => `Wir haben eine Bestätigung an ${e} geschickt.`,
    addToCalendar: 'In den Kalender eintragen',
    manageHint: 'In der E-Mail finden Sie einen Link zum Ändern oder Absagen.',
    takenTitle: 'Diese Zeit wurde gerade vergeben',
    takenBody: 'Bitte wählen Sie eine andere.',
    waitingTitle: 'Fast geschafft',
    waitingBody: 'Wir bestätigen Ihren Termin. Sie erhalten gleich eine E-Mail.',
    manageTitle: 'Ihr Termin',
    cancel: 'Termin absagen',
    cancelQuestion: 'Diesen Termin absagen?',
    cancelYes: 'Ja, absagen',
    keep: 'Termin behalten',
    cancelledTitle: 'Ihr Termin ist abgesagt',
    cancelledBody: 'Wir haben Ihnen eine Bestätigung per E-Mail geschickt.',
    movedTitle: 'Ihr Termin wurde verschoben',
    pastBooking: 'Dieser Termin hat bereits stattgefunden.',
    closed: 'Die Online-Buchung ist im Moment nicht verfügbar.',
    linkExpired: 'Dieser Link ist abgelaufen.',
    linkInvalid: 'Dieser Link ist ungültig.',
    notFound: 'Seite nicht gefunden.',
    writeTo: (e) => `Sie erreichen uns unter ${e}.`,
    formSent: 'Vielen Dank!',
    formSentBody: 'Ihre Antworten wurden gesendet.',
  },
  lv: {
    heading: (b) => `Pierakstīties pie ${b}`,
    intro: 'Izvēlieties sev ērtu laiku.',
    timesIn: (z) => `Laika josla: ${z}.`,
    minutes: (n) => `${n} min`,
    noTimes: 'Šajās dienās brīvu laiku nav.',
    laterDates: 'Vēlāki datumi',
    earlierDates: 'Agrāki datumi',
    yourTime: 'Jūsu laiks',
    yourDetails: 'Jūsu dati',
    name: 'Vārds',
    email: 'E-pasts',
    phone: 'Tālrunis',
    note: 'Vai vēlaties mums ko pastāstīt iepriekš?',
    notePlaceholder: '',
    optional: 'nav obligāti',
    book: 'Pierakstīties',
    send: 'Nosūtīt',
    chooseAnother: 'Izvēlēties citu laiku',
    moveHere: 'Pārcelt pierakstu',
    newTime: 'Jaunais laiks',
    choose: 'Izvēlieties…',
    yes: 'Jā',
    no: 'Nē',
    errors: {
      required: 'Lūdzu, aizpildiet.',
      email: 'Lūdzu, ievadiet derīgu e-pasta adresi.',
      phone: 'Lūdzu, ievadiet derīgu tālruņa numuru.',
      number: 'Lūdzu, ievadiet skaitli.',
      date: 'Lūdzu, ievadiet derīgu datumu.',
      choice: 'Lūdzu, izvēlieties kādu no iespējām.',
      long: 'Teksts ir pārāk garš.',
    },
    fixBelow: 'Lūdzu, pārbaudiet atzīmētos laukus.',
    where: {
      in_person: 'Vieta',
      phone: 'Pa tālruni',
      online_link: 'Tiešsaistē',
      google_meet: 'Tiešsaistē (Google Meet)',
    },
    meetLater: 'Saite ir apstiprinājuma e-pastā.',
    bookedTitle: 'Jūs esat pierakstīts',
    bookedBody: (e) => `Apstiprinājumu nosūtījām uz ${e}.`,
    addToCalendar: 'Pievienot kalendāram',
    manageHint: 'E-pastā ir saite, lai laiku mainītu vai atceltu.',
    takenTitle: 'Šo laiku tikko aizņēma',
    takenBody: 'Lūdzu, izvēlieties citu.',
    waitingTitle: 'Gandrīz gatavs',
    waitingBody: 'Apstiprinām jūsu pierakstu. Pēc brīža saņemsiet e-pastu.',
    manageTitle: 'Jūsu pieraksts',
    cancel: 'Atcelt pierakstu',
    cancelQuestion: 'Atcelt šo pierakstu?',
    cancelYes: 'Jā, atcelt',
    keep: 'Paturēt',
    cancelledTitle: 'Jūsu pieraksts ir atcelts',
    cancelledBody: 'Apstiprinājumu nosūtījām pa e-pastu.',
    movedTitle: 'Jūsu pieraksts ir pārcelts',
    pastBooking: 'Šī tikšanās jau ir notikusi.',
    closed: 'Pierakstīšanās tiešsaistē pašlaik nav pieejama.',
    linkExpired: 'Šīs saites derīguma termiņš ir beidzies.',
    linkInvalid: 'Šī saite nav derīga.',
    notFound: 'Lapa nav atrasta.',
    writeTo: (e) => `Varat mums rakstīt uz ${e}.`,
    formSent: 'Paldies!',
    formSentBody: 'Jūsu atbildes ir nosūtītas.',
  },
  nl: {
    heading: (b) => `Afspraak maken met ${b}`,
    intro: 'Kies een tijd die u uitkomt.',
    timesIn: (z) => `Tijdzone: ${z}.`,
    minutes: (n) => `${n} minuten`,
    noTimes: 'Er zijn geen vrije tijden in deze dagen.',
    laterDates: 'Latere data',
    earlierDates: 'Eerdere data',
    yourTime: 'Uw tijd',
    yourDetails: 'Uw gegevens',
    name: 'Naam',
    email: 'E-mail',
    phone: 'Telefoon',
    note: 'Wilt u ons vooraf iets laten weten?',
    notePlaceholder: '',
    optional: 'optioneel',
    book: 'Boeken',
    send: 'Versturen',
    chooseAnother: 'Andere tijd kiezen',
    moveHere: 'Afspraak verzetten',
    newTime: 'Nieuwe tijd',
    choose: 'Kies…',
    yes: 'Ja',
    no: 'Nee',
    errors: {
      required: 'Vul dit in.',
      email: 'Vul een geldig e-mailadres in.',
      phone: 'Vul een geldig telefoonnummer in.',
      number: 'Vul een getal in.',
      date: 'Vul een geldige datum in.',
      choice: 'Kies een van de mogelijkheden.',
      long: 'Dit is te lang.',
    },
    fixBelow: 'Controleer de gemarkeerde velden.',
    where: {
      in_person: 'Waar',
      phone: 'Telefonisch',
      online_link: 'Online',
      google_meet: 'Online (Google Meet)',
    },
    meetLater: 'De link staat in uw bevestigingsmail.',
    bookedTitle: 'Uw afspraak staat',
    bookedBody: (e) => `We hebben een bevestiging gestuurd naar ${e}.`,
    addToCalendar: 'Aan agenda toevoegen',
    manageHint: 'In de e-mail staat een link om te wijzigen of te annuleren.',
    takenTitle: 'Deze tijd is net vergeven',
    takenBody: 'Kies een andere tijd.',
    waitingTitle: 'Bijna klaar',
    waitingBody: 'We bevestigen uw afspraak. U krijgt zo een e-mail.',
    manageTitle: 'Uw afspraak',
    cancel: 'Afspraak annuleren',
    cancelQuestion: 'Deze afspraak annuleren?',
    cancelYes: 'Ja, annuleren',
    keep: 'Behouden',
    cancelledTitle: 'Uw afspraak is geannuleerd',
    cancelledBody: 'We hebben u een bevestiging per e-mail gestuurd.',
    movedTitle: 'Uw afspraak is verzet',
    pastBooking: 'Deze afspraak heeft al plaatsgevonden.',
    closed: 'Online boeken is op dit moment niet mogelijk.',
    linkExpired: 'Deze link is verlopen.',
    linkInvalid: 'Deze link is ongeldig.',
    notFound: 'Pagina niet gevonden.',
    writeTo: (e) => `U kunt ons mailen op ${e}.`,
    formSent: 'Dank u wel!',
    formSentBody: 'Uw antwoorden zijn verstuurd.',
  },
  fr: {
    heading: (b) => `Prendre rendez-vous avec ${b}`,
    intro: 'Choisissez un horaire qui vous convient.',
    timesIn: (z) => `Fuseau horaire : ${z}.`,
    minutes: (n) => `${n} minutes`,
    noTimes: "Il n'y a pas de créneau libre sur ces jours.",
    laterDates: 'Dates suivantes',
    earlierDates: 'Dates précédentes',
    yourTime: 'Votre créneau',
    yourDetails: 'Vos coordonnées',
    name: 'Nom',
    email: 'E-mail',
    phone: 'Téléphone',
    note: 'Souhaitez-vous nous préciser quelque chose ?',
    notePlaceholder: '',
    optional: 'facultatif',
    book: 'Réserver',
    send: 'Envoyer',
    chooseAnother: 'Choisir un autre horaire',
    moveHere: 'Déplacer mon rendez-vous',
    newTime: 'Nouvel horaire',
    choose: 'Choisir…',
    yes: 'Oui',
    no: 'Non',
    errors: {
      required: 'Veuillez remplir ce champ.',
      email: 'Veuillez saisir une adresse e-mail valide.',
      phone: 'Veuillez saisir un numéro de téléphone valide.',
      number: 'Veuillez saisir un nombre.',
      date: 'Veuillez saisir une date valide.',
      choice: "Veuillez choisir l'une des options.",
      long: 'Ce texte est trop long.',
    },
    fixBelow: 'Veuillez vérifier les champs indiqués.',
    where: {
      in_person: 'Lieu',
      phone: 'Par téléphone',
      online_link: 'En ligne',
      google_meet: 'En ligne (Google Meet)',
    },
    meetLater: "Le lien figure dans l'e-mail de confirmation.",
    bookedTitle: 'Votre rendez-vous est réservé',
    bookedBody: (e) => `Nous avons envoyé une confirmation à ${e}.`,
    addToCalendar: 'Ajouter au calendrier',
    manageHint: "L'e-mail contient un lien pour modifier ou annuler.",
    takenTitle: 'Ce créneau vient d’être pris',
    takenBody: 'Veuillez en choisir un autre.',
    waitingTitle: 'Presque terminé',
    waitingBody: 'Nous confirmons votre rendez-vous. Vous recevrez un e-mail dans un instant.',
    manageTitle: 'Votre rendez-vous',
    cancel: 'Annuler le rendez-vous',
    cancelQuestion: 'Annuler ce rendez-vous ?',
    cancelYes: 'Oui, annuler',
    keep: 'Le garder',
    cancelledTitle: 'Votre rendez-vous est annulé',
    cancelledBody: 'Nous vous avons envoyé une confirmation par e-mail.',
    movedTitle: 'Votre rendez-vous a été déplacé',
    pastBooking: 'Ce rendez-vous a déjà eu lieu.',
    closed: "La réservation en ligne n'est pas disponible pour le moment.",
    linkExpired: 'Ce lien a expiré.',
    linkInvalid: "Ce lien n'est pas valide.",
    notFound: 'Page introuvable.',
    writeTo: (e) => `Vous pouvez nous écrire à ${e}.`,
    formSent: 'Merci !',
    formSentBody: 'Vos réponses ont été envoyées.',
  },
  es: {
    heading: (b) => `Reservar una cita con ${b}`,
    intro: 'Elija la hora que mejor le venga.',
    timesIn: (z) => `Zona horaria: ${z}.`,
    minutes: (n) => `${n} minutos`,
    noTimes: 'No hay horas libres en estos días.',
    laterDates: 'Fechas posteriores',
    earlierDates: 'Fechas anteriores',
    yourTime: 'Su cita',
    yourDetails: 'Sus datos',
    name: 'Nombre',
    email: 'Correo electrónico',
    phone: 'Teléfono',
    note: '¿Quiere contarnos algo antes?',
    notePlaceholder: '',
    optional: 'opcional',
    book: 'Reservar',
    send: 'Enviar',
    chooseAnother: 'Elegir otra hora',
    moveHere: 'Cambiar mi cita',
    newTime: 'Nueva hora',
    choose: 'Elija…',
    yes: 'Sí',
    no: 'No',
    errors: {
      required: 'Rellene este campo.',
      email: 'Introduzca un correo electrónico válido.',
      phone: 'Introduzca un teléfono válido.',
      number: 'Introduzca un número.',
      date: 'Introduzca una fecha válida.',
      choice: 'Elija una de las opciones.',
      long: 'El texto es demasiado largo.',
    },
    fixBelow: 'Revise los campos marcados.',
    where: {
      in_person: 'Dónde',
      phone: 'Por teléfono',
      online_link: 'En línea',
      google_meet: 'En línea (Google Meet)',
    },
    meetLater: 'El enlace está en el correo de confirmación.',
    bookedTitle: 'Su cita está reservada',
    bookedBody: (e) => `Hemos enviado una confirmación a ${e}.`,
    addToCalendar: 'Añadir al calendario',
    manageHint: 'En el correo hay un enlace para cambiar o cancelar.',
    takenTitle: 'Esa hora se acaba de reservar',
    takenBody: 'Elija otra, por favor.',
    waitingTitle: 'Casi listo',
    waitingBody: 'Estamos confirmando su cita. Recibirá un correo en un momento.',
    manageTitle: 'Su cita',
    cancel: 'Cancelar la cita',
    cancelQuestion: '¿Cancelar esta cita?',
    cancelYes: 'Sí, cancelar',
    keep: 'Mantenerla',
    cancelledTitle: 'Su cita está cancelada',
    cancelledBody: 'Le hemos enviado una confirmación por correo.',
    movedTitle: 'Su cita se ha cambiado',
    pastBooking: 'Esta cita ya ha tenido lugar.',
    closed: 'La reserva en línea no está disponible en este momento.',
    linkExpired: 'Este enlace ha caducado.',
    linkInvalid: 'Este enlace no es válido.',
    notFound: 'Página no encontrada.',
    writeTo: (e) => `Puede escribirnos a ${e}.`,
    formSent: '¡Gracias!',
    formSentBody: 'Sus respuestas se han enviado.',
  },
};

export const bookingLabels = (l: string | null | undefined) => BOOKING_LABELS[bookingLang(l)];

// ------------------------------------------------------------ formatting

/** "Tuesday 7 October" in the customer's language, in the business's zone. */
export function formatDay(d: Date, lang: string | null | undefined, timeZone: string): string {
  return new Intl.DateTimeFormat(bookingLocale(lang), {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(d);
}

/** "10:00" (24-hour in every supported language, as their locales write it). */
export function formatTime(d: Date, lang: string | null | undefined, timeZone: string): string {
  return new Intl.DateTimeFormat(bookingLocale(lang), {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
}

/** "Tuesday 7 October 2026, 10:00–10:30". */
export function formatWhen(
  start: Date,
  end: Date,
  lang: string | null | undefined,
  timeZone: string,
): string {
  const date = new Intl.DateTimeFormat(bookingLocale(lang), {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(start);
  return `${date}, ${formatTime(start, lang, timeZone)}–${formatTime(end, lang, timeZone)}`;
}

/** The zone's name for customers: "Eastern European Time", "Mitteleuropäische Zeit". */
export function zoneName(
  lang: string | null | undefined,
  timeZone: string,
  at = new Date(),
): string {
  const part = new Intl.DateTimeFormat(bookingLocale(lang), {
    timeZone,
    timeZoneName: 'longGeneric',
  })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? timeZone.replace(/_/g, ' ');
}

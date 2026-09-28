/** Noctiv Assistant (beta), PLAN.md §27: API types and the panel's own words in six languages. */

export type AssistantLocale = 'en' | 'de' | 'lv' | 'nl' | 'fr' | 'es';
/** Number and money formatting for each chat language. */
export const INTL_LOCALE: Record<AssistantLocale, string> = {
  en: 'en-GB',
  de: 'de-DE',
  lv: 'lv-LV',
  nl: 'nl-NL',
  fr: 'fr-FR',
  es: 'es-ES',
};

export const ASSISTANT_LOCALES: AssistantLocale[] = ['en', 'de', 'lv', 'nl', 'fr', 'es'];

export interface AssistantProposal {
  id: string;
  type:
    'settings' | 'knowledge_note' | 'price_items' | 'create_document' | 'send_email' | 'mark_paid';
  title: string;
  payload: {
    /** settings: the fields for PATCH /v1/tenants/:id, and readable lines for the card. */
    changes?: Record<string, unknown>;
    lines?: [label: string, value: string][];
    /** knowledge_note */
    title?: string;
    text?: string;
    /** price_items */
    items?: { name: string; unit: string; unitPriceCents: number; currency: string }[];
    /** create_document */
    docType?: 'invoice' | 'delivery_note';
    buyer?: { name: string; email: string; address: string };
    /** create_document lines are objects (DocLine); settings lines are label/value pairs. */
    dueDate?: string | null;
    currency?: string;
    vatRate?: number;
    vatMode?: 'none' | 'exclusive' | 'inclusive';
    totals?: { subtotalCents: number; vatCents: number; totalCents: number } | null;
    /** send_email */
    to?: string;
    attachProposalId?: string | null;
    name?: string;
    subject?: string;
    body?: string;
    attachLabels?: string[];
    /** mark_paid */
    number?: string;
    customer?: string | null;
    totalCents?: number;
    automation?: boolean;
  };
  /** What confirming it made: the document, or the e-mail's conversation. */
  result?: { documentId?: string; number?: string | null; threadId?: string } | null;
  requires_confirmation: boolean;
  status: 'proposed' | 'applied' | 'dismissed' | 'failed';
  error: string | null;
}

export interface DocLine {
  name: string;
  unit: string;
  qty: number;
  unitPriceCents: number | null;
}

export interface AssistantMessage {
  id: string;
  role: 'owner' | 'assistant';
  text: string;
  suggestions: string[];
  created_at: string;
  proposals: AssistantProposal[];
}

export interface AssistantThread {
  conversation: { id: string; locale: AssistantLocale; purpose: 'app' | 'onboarding' } | null;
  messages: AssistantMessage[];
}

/** The browser's language when it is one of the six, else English. */
export function browserLocale(): AssistantLocale {
  try {
    for (const l of navigator.languages ?? [navigator.language]) {
      const two = l.slice(0, 2).toLowerCase() as AssistantLocale;
      if (ASSISTANT_LOCALES.includes(two)) return two;
    }
  } catch {
    // Server rendering or no navigator.
  }
  return 'en';
}

interface Words {
  title: string;
  beta: string;
  placeholder: string;
  send: string;
  newChat: string;
  close: string;
  thinking: string;
  confirm: string;
  dismiss: string;
  applied: string;
  dismissed: string;
  failed: string;
  intro: string;
  onboardingIntro: string;
  suggestions: string[];
  onboardingSuggestions: string[];
  proposedChange: string;
  sendingTitle: string;
  sendingBody: string;
  sendingCheck: string;
  cancel: string;
  noteCard: string;
  priceCard: string;
  cannot: string;
  errors: { free_tier_refused: string; budget_halted: string; model_error: string };
  actions: {
    invoice: string;
    deliveryNote: string;
    email: string;
    paid: string;
    send: string;
    sendTitle: string;
    sendBody: string;
    sendCheck: string;
    paidTitle: string;
    paidBody: string;
    ready: string;
    sent: string;
    markedPaid: string;
    open: string;
    confirmFirst: string;
    nothingToAttach: string;
  };
}

export const WORDS: Record<AssistantLocale, Words> = {
  en: {
    title: 'Noctiv Assistant',
    beta: 'beta',
    placeholder: 'Ask a question…',
    send: 'Send',
    newChat: 'New chat',
    close: 'Close',
    thinking: 'Thinking…',
    confirm: 'Confirm',
    dismiss: 'Dismiss',
    applied: 'Done',
    dismissed: 'Dismissed',
    failed: 'Could not apply',
    intro:
      'Hi! I can answer questions about your account, explain how Noctiv works and propose settings changes for you to confirm.',
    onboardingIntro:
      "Hi! Let's set up Noctiv together. First: what does your business sell, and to whom?",
    suggestions: ['How did last week go?', 'Which quotes are open?', 'Explain the reply modes'],
    onboardingSuggestions: ['We sell handmade candles online', 'We are a web design agency'],
    proposedChange: 'Proposed change',
    sendingTitle: 'This changes what Noctiv sends on its own',
    sendingBody: 'Please check the change before it takes effect:',
    sendingCheck: 'I understand what will be sent automatically.',
    cancel: 'Cancel',
    noteCard: 'Add to your knowledge base',
    priceCard: 'Add to your price list',
    cannot:
      'Nothing is created or sent until you confirm. I can’t approve drafts or change billing.',
    errors: {
      free_tier_refused:
        'The assistant is not available on the current AI plan yet. Everything else works as usual; set up manually for now.',
      budget_halted: 'Today’s AI budget is used up. The assistant is back tomorrow.',
      model_error: 'The assistant could not answer right now. Try again in a moment.',
    },
    actions: {
      invoice: 'New invoice',
      deliveryNote: 'New delivery note',
      email: 'E-mail to send',
      paid: 'Mark as paid',
      send: 'Send',
      sendTitle: 'Send this e-mail now?',
      sendBody: 'It goes out from your mailbox as soon as you press Send:',
      sendCheck: 'I have read the e-mail and want it sent.',
      paidTitle: 'Mark as paid?',
      paidBody:
        '“Delivery note after payment” is on: Noctiv may then create and send a delivery note.',
      ready: 'Ready',
      sent: 'Sent to the outbox',
      markedPaid: 'Marked as paid',
      open: 'Open',
      confirmFirst: 'Confirm the invoice card above first; then you can send it.',
      nothingToAttach: 'The document card above was not created, so there is nothing to attach.',
    },
  },
  de: {
    title: 'Noctiv Assistent',
    beta: 'Beta',
    placeholder: 'Ihre Frage…',
    send: 'Senden',
    newChat: 'Neuer Chat',
    close: 'Schließen',
    thinking: 'Denkt nach…',
    confirm: 'Bestätigen',
    dismiss: 'Verwerfen',
    applied: 'Erledigt',
    dismissed: 'Verworfen',
    failed: 'Nicht übernommen',
    intro:
      'Hallo! Ich beantworte Fragen zu Ihrem Konto, erkläre Noctiv und schlage Einstellungen vor, die Sie bestätigen.',
    onboardingIntro:
      'Hallo! Richten wir Noctiv gemeinsam ein. Zuerst: Was verkauft Ihr Unternehmen, und an wen?',
    suggestions: [
      'Wie lief die letzte Woche?',
      'Welche Angebote sind offen?',
      'Erklär mir die Antwortmodi',
    ],
    onboardingSuggestions: ['Wir verkaufen Kerzen online', 'Wir sind eine Webagentur'],
    proposedChange: 'Vorgeschlagene Änderung',
    sendingTitle: 'Das ändert, was Noctiv selbständig sendet',
    sendingBody: 'Bitte prüfen Sie die Änderung, bevor sie wirkt:',
    sendingCheck: 'Ich verstehe, was automatisch gesendet wird.',
    cancel: 'Abbrechen',
    noteCard: 'Zur Wissensbasis hinzufügen',
    priceCard: 'Zur Preisliste hinzufügen',
    cannot:
      'Nichts wird erstellt oder gesendet, bevor Sie bestätigen. Entwürfe freigeben oder die Abrechnung ändern kann ich nicht.',
    errors: {
      free_tier_refused:
        'Der Assistent ist im aktuellen KI-Tarif noch nicht verfügbar. Alles andere funktioniert wie gewohnt; richten Sie Noctiv vorerst manuell ein.',
      budget_halted: 'Das heutige KI-Budget ist aufgebraucht. Der Assistent ist morgen wieder da.',
      model_error:
        'Der Assistent konnte gerade nicht antworten. Versuchen Sie es gleich noch einmal.',
    },
    actions: {
      invoice: 'Neue Rechnung',
      deliveryNote: 'Neuer Lieferschein',
      email: 'E-Mail zum Senden',
      paid: 'Als bezahlt markieren',
      send: 'Senden',
      sendTitle: 'Diese E-Mail jetzt senden?',
      sendBody: 'Sie geht aus Ihrem Postfach hinaus, sobald Sie auf Senden drücken:',
      sendCheck: 'Ich habe die E-Mail gelesen und möchte sie senden.',
      paidTitle: 'Als bezahlt markieren?',
      paidBody:
        '„Lieferschein nach Zahlung“ ist an: Noctiv erstellt und sendet dann eventuell einen Lieferschein.',
      ready: 'Bereit',
      sent: 'In den Postausgang gelegt',
      markedPaid: 'Als bezahlt markiert',
      open: 'Öffnen',
      confirmFirst: 'Bestätigen Sie zuerst die Karte oben; dann können Sie senden.',
      nothingToAttach: 'Die Dokumentkarte oben wurde nicht erstellt; es gibt nichts anzuhängen.',
    },
  },
  lv: {
    title: 'Noctiv asistents',
    beta: 'beta',
    placeholder: 'Jūsu jautājums…',
    send: 'Sūtīt',
    newChat: 'Jauna saruna',
    close: 'Aizvērt',
    thinking: 'Domā…',
    confirm: 'Apstiprināt',
    dismiss: 'Noraidīt',
    applied: 'Izdarīts',
    dismissed: 'Noraidīts',
    failed: 'Neizdevās',
    intro:
      'Sveiki! Es atbildu uz jautājumiem par jūsu kontu, izskaidroju Noctiv un piedāvāju iestatījumu izmaiņas, ko jūs apstiprināt.',
    onboardingIntro: 'Sveiki! Iestatīsim Noctiv kopā. Vispirms: ko jūsu uzņēmums pārdod un kam?',
    suggestions: [
      'Kā gāja pagājušajā nedēļā?',
      'Kuri piedāvājumi ir atvērti?',
      'Izskaidro režīmus',
    ],
    onboardingSuggestions: ['Mēs tirgojam sveces internetā', 'Mēs esam tīmekļa aģentūra'],
    proposedChange: 'Ierosinātā izmaiņa',
    sendingTitle: 'Tas maina, ko Noctiv sūta pats',
    sendingBody: 'Lūdzu, pārbaudiet izmaiņu, pirms tā stājas spēkā:',
    sendingCheck: 'Es saprotu, kas tiks sūtīts automātiski.',
    cancel: 'Atcelt',
    noteCard: 'Pievienot zināšanu bāzei',
    priceCard: 'Pievienot cenrādim',
    cannot:
      'Nekas netiek izveidots vai nosūtīts, kamēr neapstiprināsiet. Es nevaru apstiprināt melnrakstus vai mainīt norēķinus.',
    errors: {
      free_tier_refused:
        'Asistents pašreizējā MI plānā vēl nav pieejams. Viss pārējais darbojas kā parasti; pagaidām iestatiet Noctiv manuāli.',
      budget_halted: 'Šodienas MI budžets ir izlietots. Asistents atgriezīsies rīt.',
      model_error: 'Asistents šobrīd nevarēja atbildēt. Mēģiniet vēlreiz pēc brīža.',
    },
    actions: {
      invoice: 'Jauns rēķins',
      deliveryNote: 'Jauna pavadzīme',
      email: 'E-pasts nosūtīšanai',
      paid: 'Atzīmēt kā apmaksātu',
      send: 'Sūtīt',
      sendTitle: 'Sūtīt šo e-pastu tagad?',
      sendBody: 'Tas tiks nosūtīts no jūsu pastkastes, tiklīdz nospiedīsiet Sūtīt:',
      sendCheck: 'Esmu izlasījis e-pastu un vēlos to nosūtīt.',
      paidTitle: 'Atzīmēt kā apmaksātu?',
      paidBody: 'Ieslēgts “Pavadzīme pēc apmaksas”: Noctiv var izveidot un nosūtīt pavadzīmi.',
      ready: 'Gatavs',
      sent: 'Ievietots izsūtāmajos',
      markedPaid: 'Atzīmēts kā apmaksāts',
      open: 'Atvērt',
      confirmFirst: 'Vispirms apstipriniet kartīti augstāk; tad varēsiet sūtīt.',
      nothingToAttach: 'Dokumenta kartīte augstāk netika izveidota, tāpēc nav ko pievienot.',
    },
  },
  nl: {
    title: 'Noctiv Assistent',
    beta: 'bèta',
    placeholder: 'Stel een vraag…',
    send: 'Versturen',
    newChat: 'Nieuw gesprek',
    close: 'Sluiten',
    thinking: 'Even denken…',
    confirm: 'Bevestigen',
    dismiss: 'Negeren',
    applied: 'Klaar',
    dismissed: 'Genegeerd',
    failed: 'Niet gelukt',
    intro:
      'Hoi! Ik beantwoord vragen over je account, leg Noctiv uit en stel wijzigingen voor die jij bevestigt.',
    onboardingIntro:
      'Hoi! Laten we Noctiv samen instellen. Eerst: wat verkoopt je bedrijf, en aan wie?',
    suggestions: ['Hoe ging vorige week?', 'Welke offertes staan open?', 'Leg de antwoordmodi uit'],
    onboardingSuggestions: ['We verkopen kaarsen online', 'We zijn een webbureau'],
    proposedChange: 'Voorgestelde wijziging',
    sendingTitle: 'Dit verandert wat Noctiv zelf verstuurt',
    sendingBody: 'Controleer de wijziging voordat die ingaat:',
    sendingCheck: 'Ik begrijp wat er automatisch verstuurd wordt.',
    cancel: 'Annuleren',
    noteCard: 'Toevoegen aan je kennisbank',
    priceCard: 'Toevoegen aan je prijslijst',
    cannot:
      'Er wordt niets gemaakt of verstuurd voordat je bevestigt. Concepten goedkeuren of de facturering wijzigen kan ik niet.',
    errors: {
      free_tier_refused:
        'De assistent is nog niet beschikbaar in het huidige AI-abonnement. Al het andere werkt gewoon; stel Noctiv voorlopig handmatig in.',
      budget_halted: 'Het AI-budget van vandaag is op. De assistent is morgen terug.',
      model_error: 'De assistent kon nu niet antwoorden. Probeer het zo opnieuw.',
    },
    actions: {
      invoice: 'Nieuwe factuur',
      deliveryNote: 'Nieuwe pakbon',
      email: 'E-mail om te versturen',
      paid: 'Markeren als betaald',
      send: 'Versturen',
      sendTitle: 'Deze e-mail nu versturen?',
      sendBody: 'Hij gaat vanuit je mailbox de deur uit zodra je op Versturen drukt:',
      sendCheck: 'Ik heb de e-mail gelezen en wil hem versturen.',
      paidTitle: 'Markeren als betaald?',
      paidBody: '“Pakbon na betaling” staat aan: Noctiv kan dan een pakbon maken en versturen.',
      ready: 'Klaar',
      sent: 'In de outbox gezet',
      markedPaid: 'Gemarkeerd als betaald',
      open: 'Openen',
      confirmFirst: 'Bevestig eerst de kaart hierboven; dan kun je versturen.',
      nothingToAttach:
        'De documentkaart hierboven is niet aangemaakt; er is niets om bij te voegen.',
    },
  },
  fr: {
    title: 'Assistant Noctiv',
    beta: 'bêta',
    placeholder: 'Votre question…',
    send: 'Envoyer',
    newChat: 'Nouvelle discussion',
    close: 'Fermer',
    thinking: 'Réflexion…',
    confirm: 'Confirmer',
    dismiss: 'Ignorer',
    applied: 'Fait',
    dismissed: 'Ignoré',
    failed: 'Échec',
    intro:
      'Bonjour ! Je réponds aux questions sur votre compte, j’explique Noctiv et je propose des réglages que vous confirmez.',
    onboardingIntro:
      'Bonjour ! Configurons Noctiv ensemble. D’abord : que vend votre entreprise, et à qui ?',
    suggestions: [
      'Comment s’est passée la semaine dernière ?',
      'Quels devis sont ouverts ?',
      'Explique les modes de réponse',
    ],
    onboardingSuggestions: ['Nous vendons des bougies en ligne', 'Nous sommes une agence web'],
    proposedChange: 'Changement proposé',
    sendingTitle: 'Cela modifie ce que Noctiv envoie seul',
    sendingBody: 'Vérifiez le changement avant qu’il ne s’applique :',
    sendingCheck: 'Je comprends ce qui sera envoyé automatiquement.',
    cancel: 'Annuler',
    noteCard: 'Ajouter à votre base de connaissances',
    priceCard: 'Ajouter à votre liste de prix',
    cannot:
      'Rien n’est créé ni envoyé avant votre confirmation. Je ne peux pas approuver de brouillons ni modifier la facturation.',
    errors: {
      free_tier_refused:
        'L’assistant n’est pas encore disponible avec l’offre IA actuelle. Tout le reste fonctionne normalement ; configurez Noctiv manuellement pour l’instant.',
      budget_halted: 'Le budget IA du jour est épuisé. L’assistant revient demain.',
      model_error: 'L’assistant n’a pas pu répondre pour le moment. Réessayez dans un instant.',
    },
    actions: {
      invoice: 'Nouvelle facture',
      deliveryNote: 'Nouveau bon de livraison',
      email: 'E-mail à envoyer',
      paid: 'Marquer comme payée',
      send: 'Envoyer',
      sendTitle: 'Envoyer cet e-mail maintenant ?',
      sendBody: 'Il part de votre boîte mail dès que vous appuyez sur Envoyer :',
      sendCheck: 'J’ai lu l’e-mail et je veux l’envoyer.',
      paidTitle: 'Marquer comme payée ?',
      paidBody:
        '« Bon de livraison après paiement » est activé : Noctiv peut alors créer et envoyer un bon de livraison.',
      ready: 'Prête',
      sent: 'Placé dans la boîte d’envoi',
      markedPaid: 'Marquée comme payée',
      open: 'Ouvrir',
      confirmFirst: 'Confirmez d’abord la carte ci-dessus ; vous pourrez ensuite envoyer.',
      nothingToAttach: 'La carte du document ci-dessus n’a pas été créée : rien à joindre.',
    },
  },
  es: {
    title: 'Asistente Noctiv',
    beta: 'beta',
    placeholder: 'Tu pregunta…',
    send: 'Enviar',
    newChat: 'Nueva conversación',
    close: 'Cerrar',
    thinking: 'Pensando…',
    confirm: 'Confirmar',
    dismiss: 'Descartar',
    applied: 'Hecho',
    dismissed: 'Descartado',
    failed: 'No se pudo aplicar',
    intro:
      '¡Hola! Respondo preguntas sobre tu cuenta, explico Noctiv y propongo cambios de configuración que tú confirmas.',
    onboardingIntro: '¡Hola! Configuremos Noctiv juntos. Primero: ¿qué vende tu negocio y a quién?',
    suggestions: [
      '¿Qué tal fue la semana pasada?',
      '¿Qué presupuestos están abiertos?',
      'Explica los modos de respuesta',
    ],
    onboardingSuggestions: ['Vendemos velas en línea', 'Somos una agencia web'],
    proposedChange: 'Cambio propuesto',
    sendingTitle: 'Esto cambia lo que Noctiv envía por sí solo',
    sendingBody: 'Revisa el cambio antes de que se aplique:',
    sendingCheck: 'Entiendo lo que se enviará automáticamente.',
    cancel: 'Cancelar',
    noteCard: 'Añadir a tu base de conocimiento',
    priceCard: 'Añadir a tu lista de precios',
    cannot:
      'No se crea ni se envía nada hasta que confirmes. No puedo aprobar borradores ni cambiar la facturación.',
    errors: {
      free_tier_refused:
        'El asistente aún no está disponible con el plan de IA actual. Todo lo demás funciona con normalidad; por ahora, configura Noctiv manualmente.',
      budget_halted: 'El presupuesto de IA de hoy se ha agotado. El asistente vuelve mañana.',
      model_error: 'El asistente no ha podido responder ahora. Inténtalo de nuevo en un momento.',
    },
    actions: {
      invoice: 'Nueva factura',
      deliveryNote: 'Nuevo albarán',
      email: 'Correo para enviar',
      paid: 'Marcar como pagada',
      send: 'Enviar',
      sendTitle: '¿Enviar este correo ahora?',
      sendBody: 'Sale de tu buzón en cuanto pulses Enviar:',
      sendCheck: 'He leído el correo y quiero enviarlo.',
      paidTitle: '¿Marcar como pagada?',
      paidBody: '«Albarán tras el pago» está activado: Noctiv puede crear y enviar un albarán.',
      ready: 'Lista',
      sent: 'En la bandeja de salida',
      markedPaid: 'Marcada como pagada',
      open: 'Abrir',
      confirmFirst: 'Confirma primero la tarjeta de arriba; después podrás enviarlo.',
      nothingToAttach: 'La tarjeta del documento de arriba no se creó: no hay nada que adjuntar.',
    },
  },
};

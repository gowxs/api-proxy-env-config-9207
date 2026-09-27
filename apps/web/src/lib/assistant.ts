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
  type: 'settings' | 'knowledge_note' | 'price_items';
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
  };
  requires_confirmation: boolean;
  status: 'proposed' | 'applied' | 'dismissed' | 'failed';
  error: string | null;
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
    cannot: 'I can’t send e-mails, approve drafts, create documents or change billing.',
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
      'Ich kann keine E-Mails senden, keine Entwürfe freigeben, keine Dokumente erstellen und die Abrechnung nicht ändern.',
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
      'Es nevaru sūtīt e-pastus, apstiprināt melnrakstus, veidot dokumentus vai mainīt norēķinus.',
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
      'Ik kan geen e-mails versturen, concepten goedkeuren, documenten maken of de facturering wijzigen.',
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
      'Je ne peux pas envoyer d’e-mails, approuver des brouillons, créer des documents ni modifier la facturation.',
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
      'No puedo enviar correos, aprobar borradores, crear documentos ni cambiar la facturación.',
  },
};

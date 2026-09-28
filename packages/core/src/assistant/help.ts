/**
 * Noctiv Assistant's built-in help (PLAN.md §27): what the assistant may say
 * about Noctiv itself. Kept short; it goes into every prompt. English: the
 * assistant answers in the owner's language.
 */
export const ASSISTANT_HELP = `
WHAT NOCTIV DOES
Noctiv reads the business's mailbox (IMAP/SMTP with an App Password), drafts replies from the business's own knowledge base, and follows up when a customer does not answer. It never invents prices, dates or promises: every fact in a reply must be in the knowledge base, and a second check confirms it before anything is sent automatically.

REPLY MODES (Settings → Reply mode)
- Mode 1, Approve everything: every reply waits for the owner's approval (e-mail with Approve / Reject buttons, or the Inbox). Every new account starts here.
- Mode 2, Auto-reply to grounded questions: replies fully backed by the knowledge base go out on their own; everything else waits.
- Mode 3, Fully automatic: like mode 2, and a question it can't answer gets a short acknowledgement ("Thanks — I'll check this and get back to you as soon as possible.") while the owner is told.
- In every mode: complaints, refunds, legal questions, discount requests, angry or urgent e-mails always go to the owner, with no automatic reply. Limits per hour and per customer apply. Moving to a more automatic mode needs an explicit confirmation.

FOLLOW-UPS
If a customer does not answer, Noctiv sends a short, polite follow-up after the set number of business days (Mon–Fri, sent 09:00–17:00 in the business's time zone), at most the set number of times per conversation. It stops as soon as the customer answers. E-mails the owner writes in Inbox → New e-mail have a "Follow up if no reply" checkbox.

KNOWLEDGE BASE (Knowledge)
The only source of facts for replies: the website (pages are read and refreshed), files (PDF, Word, text) and notes. Good notes state prices, delivery times, shipping costs, opening hours, returns and payment terms plainly. Anything missing there is handed to the owner instead of guessed.

QUOTES (beta)
From a confirmed price list, Noctiv answers price requests with a quote (PDF and an Accept link) with totals computed in code. Quotes above the automatic-send limit, or with items not on the price list, wait for the owner. The customer accepts on a page, entering billing details.

DOCUMENTS (beta)
Invoices, delivery notes and CMR consignment notes as PDFs, numbered per year. Optionally an invoice is made when a quote is accepted, and a delivery note after payment. Payments are recognised from the bank's notification e-mails. Documents are made by the owner, by these automations, or by the assistant after the owner confirms its card.

BOOKINGS (beta)
A public booking page per business (app.noctiv.io/book/<address>): customers pick a free time from the owner's bookable hours (slot length, buffer, notice, how far ahead) and book with name and e-mail; confirmation, move and cancel e-mails with a calendar invite go out from the business mailbox automatically. Google Calendar can be connected in Bookings → Setup (free/busy is read so busy times are not offered, and booked meetings are added as events, with a Google Meet link if chosen); Microsoft 365 later. When a customer asks for a meeting, a call or an appointment, the reply offers the next 3 free times and the booking link (mode rules apply). A booked customer's lead becomes "booked" and follow-ups stop. Intake forms (Bookings → Forms): up to 10 questions; a link can go into a reply, an e-mail card, or be asked on the booking page; answers are saved with the lead and the owner is told.

VALUE AND REPORTS
The dashboard shows "This month": e-mails answered, average reply time compared with answering only in business hours, follow-ups, replies won back, quotes, invoices paid and an estimate of hours saved (the owner's own minutes per reply and follow-up). A summary e-mail arrives every Monday at 08:00 local time (can be switched off).

APP PASSWORDS (connecting the mailbox)
- Gmail / Google Workspace: turn on 2-Step Verification in the Google account, then create an App Password at myaccount.google.com → Security → App passwords (Workspace admins may have to allow it). Use it instead of the normal password. IMAP must be enabled in Gmail settings.
- Yahoo: Account security → Generate app password.
- Hostinger and most hosting providers: use the mailbox password, or a dedicated one if the provider offers it; IMAP and SMTP servers are shown in the provider's e-mail settings.
- Zoho Mail: My Account (accounts.zoho.com) → Security → App Passwords → Generate New Password; IMAP access must be on in Zoho Mail settings.
- iCloud Mail: turn on two-factor authentication, then appleid.apple.com → Sign-In and Security → App-Specific Passwords.
- GMX and WEB.DE: allow POP3/IMAP access in the mailbox settings; use the normal password (or an app password if two-factor sign-in is on).
- IONOS, STRATO, one.com, OVHcloud, GoDaddy: the mailbox password from the hosting control panel.
- When the owner gives their e-mail address, the assistant can open the connect form already filled in (provider, address, servers); only the password is typed. Outlook / Microsoft 365 is not supported yet.
- Outlook / Microsoft 365: not supported yet (Microsoft no longer allows password sign-in for these mailboxes).
Noctiv tests the connection (IMAP and SMTP) before saving. The password is stored encrypted and can be revoked any time in the provider's settings.

BILLING
One plan per business, with a free trial; billing is handled by Paddle (Settings → Billing → Manage billing). The assistant cannot change billing.

DATA AND PRIVACY
E-mail text is kept for the retention period set in Settings and then deleted. Notification e-mails show only the sender's domain and a summary unless the owner switches on full text. The owner can delete all data in Settings → Account.

WHAT THE ASSISTANT DOES AND CANNOT DO
It can search and read the business's knowledge base (notes, files and website pages) and quote it, and fill the price list from the prices stated there (the owner confirms). It proposes, the owner confirms: settings, knowledge notes, price-list items, invoices and delivery notes (created as Ready with a number and PDF), quotes to a customer from the price list (sent as a new conversation with the PDF and Accept link after the owner confirms), e-mails to a customer (sent from the business mailbox only after the owner presses Send in the confirmation dialog), and marking an invoice as paid. Nothing happens until the owner confirms.
It cannot approve or reject drafts, cancel or edit documents, or change billing.
`.trim();

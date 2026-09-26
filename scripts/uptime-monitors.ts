/**
 * External uptime checks (PLAN.md §25) on UptimeRobot's free plan: three
 * HTTP monitors every 5 minutes, alerting the admin e-mail. Idempotent:
 * existing monitors (matched by URL) are updated, missing ones created.
 *   node --env-file=.env scripts/uptime-monitors.ts   (UPTIMEROBOT_API_KEY, ADMIN_EMAIL)
 * UPTIMEROBOT_API_KEY is the account's "Main API Key" (Integrations & API → API).
 */
const apiKey = process.env.UPTIMEROBOT_API_KEY;
const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
if (!apiKey || !adminEmail) throw new Error('UPTIMEROBOT_API_KEY and ADMIN_EMAIL are required');

const MONITORS = [
  { name: 'Noctiv site', url: 'https://noctiv.io' },
  { name: 'Noctiv app login', url: 'https://app.noctiv.io/login' },
  { name: 'Noctiv worker health', url: 'https://app.noctiv.io/api/healthz/worker' },
];
const INTERVAL_S = 300;

async function call<T>(method: string, params: Record<string, string | number> = {}): Promise<T> {
  const body = new URLSearchParams({ api_key: apiKey!, format: 'json' });
  for (const [k, v] of Object.entries(params)) body.set(k, String(v));
  const res = await fetch(`https://api.uptimerobot.com/v2/${method}`, { method: 'POST', body });
  const json = (await res.json()) as { stat: string; error?: { message?: string } } & T;
  if (json.stat !== 'ok') throw new Error(`${method}: ${json.error?.message ?? res.status}`);
  return json;
}

interface Contact {
  id: string;
  type: number;
  value: string;
  status: number;
}
const { alert_contacts: contacts } = await call<{ alert_contacts: Contact[] }>('getAlertContacts');
// Type 2 = e-mail. The account's sign-up address is already a contact.
let contact = contacts.find((c) => c.type === 2 && c.value.toLowerCase() === adminEmail);
if (!contact) {
  const r = await call<{ alertcontact: { id: string } }>('newAlertContact', {
    type: 2,
    value: adminEmail,
    friendly_name: 'Noctiv admin',
  });
  contact = { id: String(r.alertcontact.id), type: 2, value: adminEmail, status: 0 };
  console.log(
    `Alert contact added for ${adminEmail}: confirm it from the e-mail UptimeRobot sends.`,
  );
}
// Notify on every down/up change (threshold 0, recurrence 0).
const alerts = `${contact.id}_0_0`;

const { monitors } = await call<{ monitors: { id: number; url: string; interval: number }[] }>(
  'getMonitors',
);
for (const m of MONITORS) {
  const existing = monitors.find((x) => x.url.replace(/\/$/, '') === m.url);
  if (existing) {
    await call('editMonitor', {
      id: existing.id,
      friendly_name: m.name,
      interval: INTERVAL_S,
      alert_contacts: alerts,
    });
    console.log(`updated: ${m.name} (${m.url})`);
  } else {
    await call('newMonitor', {
      type: 1, // HTTP(s): down on a non-2xx/3xx status or a timeout
      friendly_name: m.name,
      url: m.url,
      interval: INTERVAL_S,
      alert_contacts: alerts,
    });
    console.log(`created: ${m.name} (${m.url})`);
  }
}

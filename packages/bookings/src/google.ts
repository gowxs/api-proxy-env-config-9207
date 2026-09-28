import { calendarCredentialsAssociatedData, open, seal, sealingKeyId } from '@noctiv/core';
import type { Interval } from './slots.ts';

/**
 * Google Calendar for Bookings (PLAN.md §29.2): OAuth (authorisation code,
 * offline access), free/busy of the primary calendar, and the events Noctiv
 * books. Plain HTTPS calls to Google's fixed endpoints, no SDK. The API uses
 * the OAuth part; everything that needs the refresh token runs in the worker,
 * the only process that can open it.
 */
export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events.freebusy',
  'https://www.googleapis.com/auth/calendar.events.owned',
] as const;
/** Both calendar scopes are needed; openid/email only name the account. */
export const REQUIRED_CALENDAR_SCOPES = GOOGLE_SCOPES.slice(2);

export interface NewEvent {
  start: Date;
  end: Date;
  timeZone: string;
  summary: string;
  description: string;
  location: string;
  attendee: { name: string; email: string };
  /** Ask Google for a Meet link (conferenceDataVersion=1). */
  meet: boolean;
  /** Idempotency: Google refuses a second event with the same id (lowercase base32hex). */
  eventId: string;
}

export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

export interface GoogleCalendarApi {
  readonly fake: boolean;
  authUrl(state: string, redirectUri: string): string;
  exchangeCode(
    code: string,
    redirectUri: string,
  ): Promise<{ refreshToken: string; email: string; scopes: string[] }>;
  /** Throws GoogleAuthError when the refresh token is revoked or invalid. */
  accessToken(refreshToken: string): Promise<string>;
  freeBusy(accessToken: string, from: Date, to: Date): Promise<Interval[]>;
  createEvent(accessToken: string, ev: NewEvent): Promise<{ id: string; meetUrl: string | null }>;
  moveEvent(
    accessToken: string,
    id: string,
    start: Date,
    end: Date,
    timeZone: string,
  ): Promise<void>;
  /** Already gone (404/410) counts as deleted. */
  deleteEvent(accessToken: string, id: string): Promise<void>;
  revoke(refreshToken: string): Promise<void>;
}

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
const CAL = 'https://www.googleapis.com/calendar/v3';
const TIMEOUT_MS = 10_000;

/** Google event ids: 5–1024 characters of a–v and 0–9. From a UUID: hex digits only. */
export const googleEventId = (bookingId: string) => `nb${bookingId.replace(/-/g, '')}`;

function jwtEmail(idToken: string | undefined): string | null {
  const payload = idToken?.split('.')[1];
  if (!payload) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: unknown;
      email_verified?: unknown;
    };
    return typeof p.email === 'string' && p.email_verified !== false ? p.email : null;
  } catch {
    return null;
  }
}

export function createGoogleCalendar(opts: {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}): GoogleCalendarApi {
  const f = opts.fetch ?? fetch;
  const call = async (url: string, init: RequestInit & { accessToken?: string }) => {
    const res = await f(url, {
      ...init,
      headers: {
        ...(init.accessToken ? { authorization: `Bearer ${init.accessToken}` } : {}),
        ...(init.body && typeof init.body === 'string' && init.body.startsWith('{')
          ? { 'content-type': 'application/json' }
          : {}),
        ...((init.headers as Record<string, string>) ?? {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res;
  };
  const token = async (params: Record<string, string>) => {
    const res = await call(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        ...params,
      }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = typeof body.error === 'string' ? body.error : `http_${res.status}`;
      if (err === 'invalid_grant' || err === 'unauthorized_client') throw new GoogleAuthError(err);
      throw new Error(`google token endpoint: ${err}`);
    }
    return body;
  };
  const check = async (res: Response, what: string) => {
    if (res.status === 401) throw new GoogleAuthError(`${what}: unauthorized`);
    if (!res.ok) throw new Error(`google ${what}: http_${res.status}`);
  };
  return {
    fake: false,
    authUrl: (state, redirectUri) =>
      `${AUTH}?${new URLSearchParams({
        client_id: opts.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GOOGLE_SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'false',
        state,
      })}`,
    async exchangeCode(code, redirectUri) {
      const b = await token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
      const refreshToken = typeof b.refresh_token === 'string' ? b.refresh_token : null;
      // The ID token comes straight from Google's token endpoint over TLS
      // (OpenID Connect Core 3.1.3.7), so its e-mail claim is only read here.
      const email = jwtEmail(typeof b.id_token === 'string' ? b.id_token : undefined);
      if (!refreshToken || !email) throw new Error('google token endpoint: incomplete response');
      const scopes = typeof b.scope === 'string' ? b.scope.split(' ') : [];
      return { refreshToken, email, scopes };
    },
    async accessToken(refreshToken) {
      const b = await token({ grant_type: 'refresh_token', refresh_token: refreshToken });
      if (typeof b.access_token !== 'string')
        throw new Error('google token endpoint: no access token');
      return b.access_token;
    },
    async freeBusy(accessToken, from, to) {
      const res = await call(`${CAL}/freeBusy`, {
        method: 'POST',
        accessToken,
        body: JSON.stringify({
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          items: [{ id: 'primary' }],
        }),
      });
      await check(res, 'freeBusy');
      const b = (await res.json()) as {
        calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }>;
      };
      const cal = b.calendars?.primary;
      if (!cal || cal.errors?.length) throw new Error('google freeBusy: calendar error');
      return (cal.busy ?? [])
        .map((x) => ({ start: new Date(x.start), end: new Date(x.end) }))
        .filter((x) => !Number.isNaN(x.start.getTime()) && x.end > x.start);
    },
    async createEvent(accessToken, ev) {
      const res = await call(
        `${CAL}/calendars/primary/events?sendUpdates=none&conferenceDataVersion=${ev.meet ? 1 : 0}`,
        {
          method: 'POST',
          accessToken,
          body: JSON.stringify({
            id: ev.eventId,
            summary: ev.summary,
            description: ev.description,
            ...(ev.location ? { location: ev.location } : {}),
            start: { dateTime: ev.start.toISOString(), timeZone: ev.timeZone },
            end: { dateTime: ev.end.toISOString(), timeZone: ev.timeZone },
            attendees: [{ email: ev.attendee.email, displayName: ev.attendee.name }],
            ...(ev.meet
              ? {
                  conferenceData: {
                    createRequest: {
                      requestId: ev.eventId,
                      conferenceSolutionKey: { type: 'hangoutsMeet' },
                    },
                  },
                }
              : {}),
          }),
        },
      );
      if (res.status === 409) {
        // Created by an earlier attempt of the same job: use it.
        const got = await call(`${CAL}/calendars/primary/events/${ev.eventId}`, { accessToken });
        await check(got, 'events.get');
        const g = (await got.json()) as { id: string; hangoutLink?: string };
        return { id: g.id, meetUrl: g.hangoutLink ?? null };
      }
      await check(res, 'events.insert');
      const b = (await res.json()) as { id: string; hangoutLink?: string };
      return { id: b.id, meetUrl: b.hangoutLink ?? null };
    },
    async moveEvent(accessToken, id, start, end, timeZone) {
      const res = await call(
        `${CAL}/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=none`,
        {
          method: 'PATCH',
          accessToken,
          body: JSON.stringify({
            start: { dateTime: start.toISOString(), timeZone },
            end: { dateTime: end.toISOString(), timeZone },
          }),
        },
      );
      await check(res, 'events.patch');
    },
    async deleteEvent(accessToken, id) {
      const res = await call(
        `${CAL}/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=none`,
        { method: 'DELETE', accessToken },
      );
      if (res.status === 404 || res.status === 410) return;
      await check(res, 'events.delete');
    },
    async revoke(refreshToken) {
      await call(REVOKE, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshToken }).toString(),
      }).catch(() => undefined);
    },
  };
}

/**
 * Development and tests only (CALENDAR_FAKE=1; refused in production): no
 * network. "Connect" returns straight to the callback; the calendar is busy
 * 12:00–13:00 UTC every day, plus whatever a test adds.
 */
export function createFakeGoogleCalendar(opts: { busy?: Interval[] } = {}): GoogleCalendarApi & {
  events: Map<string, { start: Date; end: Date; summary: string; attendee: string }>;
  busy: Interval[];
  failAuth: boolean;
} {
  const events = new Map<string, { start: Date; end: Date; summary: string; attendee: string }>();
  const api = {
    fake: true as const,
    events,
    busy: opts.busy ?? [],
    failAuth: false,
    authUrl: (state: string, redirectUri: string) =>
      `${redirectUri}?${new URLSearchParams({ code: 'fake-code', state, scope: GOOGLE_SCOPES.join(' ') })}`,
    async exchangeCode(code: string) {
      if (code !== 'fake-code') throw new Error('google token endpoint: invalid_grant');
      return {
        refreshToken: 'fake-refresh-token',
        email: 'calendar@example.com',
        scopes: [...GOOGLE_SCOPES],
      };
    },
    async accessToken(refreshToken: string) {
      if (api.failAuth || !refreshToken) throw new GoogleAuthError('invalid_grant');
      return 'fake-access-token';
    },
    async freeBusy(_a: string, from: Date, to: Date) {
      const out: Interval[] = [];
      for (
        let d = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
        d < to.getTime();
        d += 86_400_000
      )
        out.push({ start: new Date(d + 12 * 3_600_000), end: new Date(d + 13 * 3_600_000) });
      for (const e of events.values()) out.push({ start: e.start, end: e.end });
      return [...out, ...api.busy].filter((b) => b.end > from && b.start < to);
    },
    async createEvent(_a: string, ev: NewEvent) {
      events.set(ev.eventId, {
        start: ev.start,
        end: ev.end,
        summary: ev.summary,
        attendee: ev.attendee.email,
      });
      return {
        id: ev.eventId,
        meetUrl: ev.meet ? `https://meet.google.com/fak-e${ev.eventId.slice(2, 5)}-demo` : null,
      };
    },
    async moveEvent(_a: string, id: string, start: Date, end: Date) {
      const e = events.get(id);
      if (e) events.set(id, { ...e, start, end });
    },
    async deleteEvent(_a: string, id: string) {
      events.delete(id);
    },
    async revoke() {},
  };
  return api;
}

// ------------------------------------------------------------- sealing

/** The API seals the refresh token with the worker's public key; only the worker can open it. */
export function sealCalendarToken(
  refreshToken: string,
  publicKey: string,
  tenantId: string,
  connectionId: string,
): { ciphertext: Buffer; keyId: string } {
  return {
    ciphertext: seal(
      Buffer.from(refreshToken, 'utf8'),
      publicKey,
      calendarCredentialsAssociatedData(tenantId, connectionId),
    ),
    keyId: sealingKeyId(publicKey),
  };
}

export function openCalendarToken(
  ciphertext: Uint8Array,
  keys: { publicKey: string; privateKey: string },
  tenantId: string,
  connectionId: string,
): string {
  const plain = open(
    Buffer.from(ciphertext),
    keys.privateKey,
    keys.publicKey,
    calendarCredentialsAssociatedData(tenantId, connectionId),
  );
  const token = plain.toString('utf8');
  plain.fill(0);
  return token;
}

/** Bookings (beta), PLAN.md §29: types and formatting for the app. */

export type LocationKind = 'in_person' | 'phone' | 'online_link' | 'google_meet';
export type Day = '1' | '2' | '3' | '4' | '5' | '6' | '7';
export type WeeklyHours = Partial<Record<Day, { from: string; to: string }[]>>;

export interface BookingSettings {
  hours: WeeklyHours;
  slotMinutes: number;
  bufferMinutes: number;
  noticeHours: number;
  horizonDays: number;
  locationKind: LocationKind;
  locationText: string;
  meetingTitle: string;
  formId: string | null;
}

export interface BookingSetup {
  enabled: boolean;
  slug: string | null;
  pageUrl: string | null;
  timezone: string;
  settings: BookingSettings;
  problems: string[];
  calendar: {
    provider: string;
    email: string;
    status: 'connected' | 'error' | 'revoking';
    lastError: string | null;
    syncedAt: string | null;
  } | null;
  googleConfigured: boolean;
  forms: { id: string; name: string }[];
}

export interface Booking {
  id: string;
  lead_id: string | null;
  thread_id: string | null;
  name: string;
  email: string;
  phone: string | null;
  note: string | null;
  answers: { label: string; value: string }[];
  starts_at: string;
  ends_at: string;
  language: string;
  status: 'pending' | 'confirmed' | 'taken' | 'cancelled' | 'rescheduled';
  cancelled_by: 'customer' | 'owner' | null;
  source: 'page' | 'reply' | 'assistant';
  meet_url: string | null;
}

export type FieldType =
  'text' | 'long_text' | 'email' | 'phone' | 'number' | 'date' | 'choice' | 'yes_no';

export interface FormField {
  key?: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[];
}

export interface IntakeForm {
  id: string;
  name: string;
  intro: string;
  fields: FormField[];
  submissions: number;
}

export interface Submission {
  id: string;
  form_name: string;
  name: string;
  email: string;
  answers: { label: string; value: string }[];
  created_at: string;
}

export const FIELD_TYPES: { id: FieldType; label: string }[] = [
  { id: 'text', label: 'Short text' },
  { id: 'long_text', label: 'Long text' },
  { id: 'email', label: 'E-mail' },
  { id: 'phone', label: 'Phone' },
  { id: 'number', label: 'Number' },
  { id: 'date', label: 'Date' },
  { id: 'choice', label: 'Choice' },
  { id: 'yes_no', label: 'Yes / no' },
];

export const DAYS: { id: Day; short: string; long: string }[] = [
  { id: '1', short: 'Mon', long: 'Monday' },
  { id: '2', short: 'Tue', long: 'Tuesday' },
  { id: '3', short: 'Wed', long: 'Wednesday' },
  { id: '4', short: 'Thu', long: 'Thursday' },
  { id: '5', short: 'Fri', long: 'Friday' },
  { id: '6', short: 'Sat', long: 'Saturday' },
  { id: '7', short: 'Sun', long: 'Sunday' },
];

export const LOCATIONS: { id: LocationKind; label: string; hint: string }[] = [
  { id: 'online_link', label: 'Online, my meeting link', hint: 'Zoom, Teams or any https link' },
  {
    id: 'google_meet',
    label: 'Google Meet',
    hint: 'A new link for each booking (needs Google Calendar)',
  },
  { id: 'phone', label: 'Phone call', hint: 'The customer gives a number; you call' },
  { id: 'in_person', label: 'In person', hint: 'Your address' },
];

export const PROBLEMS: Record<string, string> = {
  no_hours: 'Add at least one bookable time window.',
  online_link_missing: 'Add your meeting link (https://…), or choose another place.',
  address_missing: 'Add the address customers come to.',
  no_mailbox: 'Connect a mailbox: confirmations go out from your own address.',
};

/** "Tue 7 Oct" and "10:00", in the business's time zone. */
export function dayLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(iso));
}
export function timeLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}
export function localDateKey(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

import { z } from 'zod';

/**
 * Intake forms (PLAN.md §29.7): up to 10 fields the owner defines. Name and
 * e-mail are always asked by the page itself, so they are not fields here.
 */
export const FIELD_TYPES = [
  'text',
  'long_text',
  'email',
  'phone',
  'number',
  'date',
  'choice',
  'yes_no',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const MAX_FIELDS = 10;
export const MAX_OPTIONS = 20;

export const formFieldSchema = z
  .object({
    /** Stable key for the answer ("f1" … ); set by the API when missing. */
    key: z.string().regex(/^f\d{1,3}$/),
    label: z.string().trim().min(1).max(100),
    type: z.enum(FIELD_TYPES),
    required: z.boolean(),
    options: z.array(z.string().trim().min(1).max(80)).max(MAX_OPTIONS).optional(),
  })
  .strict()
  .refine((f) => f.type !== 'choice' || (f.options?.length ?? 0) >= 2, {
    message: 'a choice needs at least two options',
  });
export type FormField = z.infer<typeof formFieldSchema>;

export const formSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    intro: z.string().trim().max(1000),
    fields: z
      .array(formFieldSchema)
      .max(MAX_FIELDS)
      .refine((fs) => new Set(fs.map((f) => f.key)).size === fs.length, {
        message: 'duplicate field keys',
      }),
  })
  .strict();
export type FormDefinition = z.infer<typeof formSchema>;

/** Gives fields without a key the next free "fN" key. */
export function withKeys<T extends object>(
  fields: (T & { key?: string })[],
): (T & { key: string })[] {
  const used = new Set(fields.map((f) => f.key).filter(Boolean));
  let n = 1;
  return fields.map((f) => {
    if (f.key) return f as T & { key: string };
    while (used.has(`f${n}`)) n++;
    used.add(`f${n}`);
    return { ...f, key: `f${n}` };
  });
}

export interface Answer {
  key: string;
  label: string;
  type: FieldType;
  value: string;
}
export type FieldError = 'required' | 'email' | 'phone' | 'number' | 'date' | 'choice' | 'long';

export const EMAIL = /^[^\s@<>()",;]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const PHONE = /^\+?[0-9 ()./-]{6,25}$/;
const LIMIT: Record<FieldType, number> = {
  text: 200,
  long_text: 2000,
  email: 200,
  phone: 25,
  number: 30,
  date: 10,
  choice: 80,
  yes_no: 3,
};

const clean = (v: string | undefined) =>
  (v ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\P{Cc}\n\t]/gu, '')
    .trim();

/**
 * Checks the submitted values (form posts give strings). Returns the answers
 * with labels copied, or the errors per field key. Empty optional fields are
 * left out.
 */
export function readAnswers(
  fields: FormField[],
  raw: Record<string, string | undefined>,
): { answers: Answer[]; errors: Record<string, FieldError> } {
  const answers: Answer[] = [];
  const errors: Record<string, FieldError> = {};
  for (const f of fields) {
    let v = clean(raw[f.key]);
    if (f.type !== 'long_text') v = v.replace(/\s+/g, ' ');
    if (f.type === 'yes_no') v = v === 'yes' ? 'yes' : v === 'no' ? 'no' : '';
    if (!v) {
      if (f.required) errors[f.key] = 'required';
      continue;
    }
    if (v.length > LIMIT[f.type]) errors[f.key] = 'long';
    else if (f.type === 'email' && !EMAIL.test(v)) errors[f.key] = 'email';
    else if (f.type === 'phone' && !PHONE.test(v)) errors[f.key] = 'phone';
    else if (f.type === 'number' && !/^-?\d+(?:[.,]\d+)?$/.test(v)) errors[f.key] = 'number';
    else if (f.type === 'date' && !validDate(v)) errors[f.key] = 'date';
    else if (f.type === 'choice' && !(f.options ?? []).includes(v)) errors[f.key] = 'choice';
    else answers.push({ key: f.key, label: f.label, type: f.type, value: v });
  }
  return { answers, errors };
}

function validDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** The fixed contact fields every booking and form page asks. */
export interface Contact {
  name: string;
  email: string;
  phone: string;
  note: string;
}
export function readContact(
  raw: Record<string, string | undefined>,
  opts: { note: boolean; phone: boolean },
): { contact: Contact; errors: Record<string, FieldError> } {
  const errors: Record<string, FieldError> = {};
  const name = clean(raw.name).replace(/\s+/g, ' ');
  const email = clean(raw.email).replace(/\s+/g, '');
  const phone = opts.phone ? clean(raw.phone).replace(/\s+/g, ' ') : '';
  const note = opts.note ? clean(raw.note) : '';
  if (!name) errors.name = 'required';
  else if (name.length > 200) errors.name = 'long';
  if (!email) errors.email = 'required';
  else if (email.length > 200 || !EMAIL.test(email)) errors.email = 'email';
  if (phone && !PHONE.test(phone)) errors.phone = 'phone';
  if (note.length > 1000) errors.note = 'long';
  return { contact: { name, email: email.toLowerCase(), phone, note }, errors };
}

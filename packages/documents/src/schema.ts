import { z } from 'zod';

/**
 * The fields of each document type. The same schema is used while drafting
 * (every field may be empty) and before issuing, where checks.ts decides
 * what is still missing. Unknown keys are rejected; lengths are capped.
 */
export const DOC_TYPES = ['invoice', 'delivery_note', 'cmr'] as const;
export type DocType = (typeof DOC_TYPES)[number];
export const DOC_STATUSES = ['draft', 'issued', 'sent', 'paid', 'delivered', 'cancelled'] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

const text = (max: number) => z.string().max(max).default('');
const isoDate = z.iso.date().nullable().default(null);
const qty = z.number().positive().max(10_000_000).nullable().default(null);

const party = {
  name: text(200),
  address: text(500),
  regNo: text(40),
  vatNo: text(30),
};

export const InvoiceSchema = z.strictObject({
  buyer: z.strictObject({ ...party, email: text(200) }).default({
    name: '',
    address: '',
    regNo: '',
    vatNo: '',
    email: '',
  }),
  supplyDate: isoDate,
  dueDate: isoDate,
  paymentReference: text(100),
  reverseCharge: z.boolean().default(false),
  lines: z
    .array(
      z.strictObject({
        name: text(200),
        unit: text(30),
        qty,
        unitPriceCents: z.number().int().min(0).max(1_000_000_000).nullable().default(null),
      }),
    )
    .max(100)
    .default([]),
  notes: text(2000),
});
export type InvoiceData = z.output<typeof InvoiceSchema>;

export const DeliveryNoteSchema = z.strictObject({
  receiver: z.strictObject(party).default({ name: '', address: '', regNo: '', vatNo: '' }),
  loadingAddress: text(500),
  deliveryAddress: text(500),
  deliveryDate: isoDate,
  lines: z
    .array(z.strictObject({ name: text(200), unit: text(30), qty }))
    .max(100)
    .default([]),
  vehicle: text(40),
  driver: text(100),
  notes: text(2000),
});
export type DeliveryNoteData = z.output<typeof DeliveryNoteSchema>;

const place = z
  .strictObject({ name: text(200), address: text(500), country: text(60) })
  .default({ name: '', address: '', country: '' });

export const CmrGoodsSchema = z.strictObject({
  marks: text(200),
  packages: z.number().int().positive().max(1_000_000).nullable().default(null),
  packing: text(100),
  nature: text(200),
  statNo: text(40),
  grossKg: z.number().positive().max(1_000_000).nullable().default(null),
  volumeM3: z.number().positive().max(100_000).nullable().default(null),
});
export type CmrGoods = z.output<typeof CmrGoodsSchema>;

export const CmrSchema = z.strictObject({
  sender: place,
  consignee: place,
  deliveryPlace: z
    .strictObject({ place: text(200), country: text(60) })
    .default({ place: '', country: '' }),
  takingOver: z
    .strictObject({ place: text(200), country: text(60), date: isoDate })
    .default({ place: '', country: '', date: null }),
  documentsAttached: text(300),
  goods: z.array(CmrGoodsSchema).max(10).default([]),
  senderInstructions: text(600),
  carriagePayment: z.enum(['paid', 'forward']).nullable().default(null),
  cashOnDelivery: text(100),
  carrier: place,
  successiveCarriers: text(300),
  carrierReservations: text(600),
  specialAgreements: text(600),
  toBePaidBy: text(200),
  establishedIn: text(100),
  establishedOn: isoDate,
  vehicleTractor: text(20),
  vehicleTrailer: text(20),
});
export type CmrData = z.output<typeof CmrSchema>;

export type DocData = InvoiceData | DeliveryNoteData | CmrData;
export const SCHEMAS = {
  invoice: InvoiceSchema,
  delivery_note: DeliveryNoteSchema,
  cmr: CmrSchema,
} as const;

/** Parses (and fills defaults into) a document's fields; throws a ZodError when invalid. */
export function parseData(type: 'invoice', data: unknown): InvoiceData;
export function parseData(type: 'delivery_note', data: unknown): DeliveryNoteData;
export function parseData(type: 'cmr', data: unknown): CmrData;
export function parseData(type: DocType, data: unknown): DocData;
export function parseData(type: DocType, data: unknown): DocData {
  return SCHEMAS[type].parse(data ?? {});
}

/** An empty document of a type, with one empty line where the type has lines. */
export function emptyData(type: DocType): DocData {
  const d = parseData(type, {});
  if (type === 'invoice')
    return {
      ...(d as InvoiceData),
      lines: [{ name: '', unit: 'pcs', qty: 1, unitPriceCents: null }],
    };
  if (type === 'delivery_note')
    return { ...(d as DeliveryNoteData), lines: [{ name: '', unit: 'pcs', qty: 1 }] };
  return {
    ...(d as CmrData),
    goods: [
      {
        marks: '',
        packages: null,
        packing: '',
        nature: '',
        statNo: '',
        grossKg: null,
        volumeM3: null,
      },
    ],
  };
}

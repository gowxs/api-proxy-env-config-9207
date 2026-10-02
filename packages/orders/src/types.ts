/**
 * What an order looks like once a shop platform's own statuses are translated
 * (Shopify today, WooCommerce later). Read, decided on, never stored.
 */
export type Payment =
  | 'paid'
  | 'pending'
  | 'authorized'
  | 'partially_paid'
  | 'refunded'
  | 'partially_refunded'
  | 'voided'
  | 'other';

export interface OrderShipment {
  createdAt: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  estimatedDeliveryAt: string | null;
  deliveredAt: string | null;
  inTransitAt: string | null;
  items: { name: string; quantity: number }[];
}

export interface OrderRecord {
  /** The number as the shop shows it, e.g. "#1002". */
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  /** Checkout / contact e-mail and the linked customer's e-mail: used only for the identity check. */
  email: string | null;
  customerEmail: string | null;
  payment: Payment;
  fulfillment: 'shipped' | 'not_shipped' | 'other';
  /** The platform's own status when fulfilment is neither shipped nor not shipped (partly shipped, on hold, …). */
  fulfillmentDetail: string | null;
  shipments: OrderShipment[];
}

export type OrderLookupErrorCode =
  /** The saved connection no longer works (token revoked, app uninstalled): the owner must reconnect. */
  | 'AUTH'
  /** The connection lacks a permission it needs. */
  | 'SCOPE'
  | 'UNAVAILABLE';

export class OrderLookupError extends Error {
  readonly code: OrderLookupErrorCode;
  constructor(code: OrderLookupErrorCode) {
    super(`order lookup: ${code}`);
    this.name = 'OrderLookupError';
    this.code = code;
  }
}

/** One shop platform's read-only way to find orders. Everything else (parsing, identity, decisions) is shared. */
export interface OrderProvider {
  readonly platform: 'shopify' | 'woocommerce';
  /** Orders whose number is exactly this (digits only). May return several (prefixes, exchanges). */
  findByNumber(number: string): Promise<OrderRecord[]>;
  /** Most recent orders placed with this e-mail address. */
  findByEmail(email: string): Promise<OrderRecord[]>;
}

'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

export type BillingStatus =
  'trial' | 'trialing' | 'active' | 'past_due' | 'paused' | 'canceled' | 'comped';

export interface Billing {
  status: BillingStatus;
  /** In the free trial or subscribed: Noctiv reads and answers mail. */
  entitled: boolean;
  trialEndsAt: string;
  /** The business's time zone (Settings). */
  timezone: string;
  trialDaysLeft: number | null;
  periodEndsAt: string | null;
  cancelsAt: string | null;
  hasSubscription: boolean;
  portalAvailable: boolean;
  checkout: {
    env: 'sandbox' | 'production';
    clientToken: string;
    priceId: string;
    email: string | null;
  } | null;
}

interface BillingValue {
  billing: Billing | null;
  reload: () => Promise<Billing | null>;
}
const BillingContext = createContext<BillingValue>({ billing: null, reload: async () => null });

export const useBilling = () => useContext(BillingContext);

/** Loads the tenant's subscription state once per page; shared by the banner and cards. */
export function BillingProvider({
  tenantId,
  children,
}: {
  tenantId: string | null;
  children: ReactNode;
}) {
  const [billing, setBilling] = useState<Billing | null>(null);
  const reload = useCallback(async () => {
    if (!tenantId) return null;
    try {
      const b = await api<Billing>(`/v1/tenants/${tenantId}/billing`);
      setBilling(b);
      return b;
    } catch {
      return null; // The banner is optional; pages show their own errors.
    }
  }, [tenantId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return <BillingContext.Provider value={{ billing, reload }}>{children}</BillingContext.Provider>;
}

// ------------------------------------------------------------------ Paddle.js
interface PaddleEvent {
  name?: string;
}
interface PaddleJs {
  Environment: { set: (env: string) => void };
  Initialize: (opts: { token: string; eventCallback?: (e: PaddleEvent) => void }) => void;
  Checkout: {
    open: (opts: {
      items: { priceId: string; quantity: number }[];
      customer?: { email: string };
      customData?: Record<string, string>;
      settings?: {
        displayMode?: 'overlay';
        theme?: 'light';
        locale?: string;
        allowLogout?: boolean;
      };
    }) => void;
  };
}
declare global {
  interface Window {
    Paddle?: PaddleJs;
  }
}

const PADDLE_JS = 'https://cdn.paddle.com/paddle/v2/paddle.js';
let paddleReady: Promise<PaddleJs> | null = null;
let onCompleted: (() => void) | null = null;

function loadPaddle(checkout: NonNullable<Billing['checkout']>): Promise<PaddleJs> {
  paddleReady ??= new Promise<PaddleJs>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PADDLE_JS;
    s.async = true;
    s.onload = () => {
      const P = window.Paddle;
      if (!P) return reject(new Error('Paddle did not load.'));
      if (checkout.env === 'sandbox') P.Environment.set('sandbox');
      P.Initialize({
        token: checkout.clientToken,
        eventCallback: (e) => {
          if (e.name === 'checkout.completed') onCompleted?.();
        },
      });
      resolve(P);
    };
    s.onerror = () => {
      paddleReady = null;
      reject(
        new Error('The payment window could not be loaded. Check your connection and try again.'),
      );
    };
    document.head.appendChild(s);
  });
  return paddleReady;
}

/**
 * Opens Paddle Checkout as an overlay. The tenant id travels in custom data,
 * so the subscription webhook can find the business. Paddle adds VAT or sales
 * tax by the buyer's country and handles B2B reverse charge.
 */
export async function openCheckout(
  checkout: NonNullable<Billing['checkout']>,
  tenantId: string,
  completed: () => void,
): Promise<void> {
  const P = await loadPaddle(checkout);
  onCompleted = completed;
  P.Checkout.open({
    items: [{ priceId: checkout.priceId, quantity: 1 }],
    ...(checkout.email ? { customer: { email: checkout.email } } : {}),
    customData: { tenant_id: tenantId },
    settings: { displayMode: 'overlay', theme: 'light', locale: 'en' },
  });
}

/** After checkout the webhook usually lands within seconds; poll until it has. */
export async function waitForSubscription(
  reload: () => Promise<Billing | null>,
  tries = 30,
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const b = await reload();
    if (b?.hasSubscription && b.entitled) return true;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

/** "Thursday, 8 October 2026 at 15:30 (Europe/Riga)" in the business's time zone. */
export function fmtEnd(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const fmt = (tz: string) =>
    `${d.toLocaleDateString('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} at ${d.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })} (${tz})`;
  try {
    return fmt(timeZone || 'UTC');
  } catch {
    return fmt('UTC');
  }
}

export const daysLeftText = (n: number) => (n === 1 ? '1 day left' : `${n} days left`);

export const fmtDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : '—';

import { withTenant } from '@noctiv/db';
import { seedTenant, type SeededTenant } from '@noctiv/db/testing';
import { FakeProvider } from '@noctiv/llm';
import { createShopifyClient, sealTokens, type StoredTokens } from '@noctiv/shopify';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  iso,
  startMockShopify,
  type MockOrder,
} from '../../../packages/shopify/test/mock-shopify.ts';
import { storeInbound } from '../src/ingest/store.ts';
import { processMessage } from '../src/pipeline/process.ts';
import { shopifyOrders } from '../src/shopify/connection.ts';
import { keys } from './helpers.ts';
import { cls, inbound, kindOf, model } from './wismo-helpers.ts';
import { inject } from 'vitest';

const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const worker = postgres(inject('workerDatabaseUrl'), { max: 6, onnotice: () => {} });
const DAY = 86_400_000;
const SHOP = 'noctiv-nvojutjr.myshopify.com';
const GVIDO = 'gowxs612@gmail.com';
const APP = { clientId: 'cid-wismo', clientSecret: 'shpss_wismo_secret_0000' };

let mock: Awaited<ReturnType<typeof startMockShopify>>;
beforeAll(async () => {
  mock = await startMockShopify({ clientId: APP.clientId, clientSecret: APP.clientSecret });
  const extra = (name: string, over: Partial<MockOrder>): MockOrder => ({
    ...mock.orders.find((o) => o.name === '#1002')!,
    name,
    ...over,
  });
  mock.orders.push(
    // shipped long ago, no update
    extra('#1005', {
      email: GVIDO,
      customerEmail: GVIDO,
      fulfillments: [
        { ...mock.orders[1]!.fulfillments[0]!, createdAt: iso(30 * DAY), inTransitAt: null },
      ],
    }),
    extra('#1006', { email: GVIDO, customerEmail: GVIDO, fulfillments: [] }), // fulfilled, no shipment record
    extra('#1007', {
      email: GVIDO,
      customerEmail: GVIDO,
      displayFulfillmentStatus: 'PARTIALLY_FULFILLED',
    }),
    extra('#1008', { email: GVIDO, customerEmail: GVIDO, displayFinancialStatus: 'PENDING' }),
    // a customer with exactly one order, found by e-mail address alone
    extra('#2001', { email: 'solo@example.com', customerEmail: 'solo@example.com' }),
  );
});
afterAll(async () => {
  await mock.close();
  await Promise.all([owner.end(), worker.end()]);
});

interface Ctx {
  T: SeededTenant;
  llm: FakeProvider;
  ask(o: {
    from?: string;
    subject?: string;
    text: string;
  }): Promise<{ id: string; outcome: Awaited<ReturnType<typeof processMessage>> }>;
}
let n = 0;
async function setup(
  mode: 'draft_only' | 'auto_send' | 'full_auto',
  opts: { connect?: boolean; tokens?: Partial<StoredTokens>; classify?: string } = {},
): Promise<Ctx> {
  const T = await seedTenant(owner, `wismo-${n++}`, { embeddingAxis: 230 + n });
  await owner`update public.tenants set mode = ${mode}, name = 'Nordlicht Candles' where id = ${T.tenantId}`;
  // The shared fixture seeds a connection per tenant; these tests bring their own.
  await owner`delete from public.shopify_connections where tenant_id = ${T.tenantId}`;
  await owner`delete from public.woocommerce_connections where tenant_id = ${T.tenantId}`;
  if (opts.connect !== false) {
    const tokens: StoredTokens = {
      accessToken: [...mock.validTokens][0]!,
      refreshToken: 'shprt_seed',
      accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      refreshExpiresAt: new Date(Date.now() + 80 * DAY).toISOString(),
      ...opts.tokens,
    };
    const shop = `wismo${n}-${SHOP}`;
    const sealed = sealTokens(tokens, keys.publicKey, shop);
    await owner`insert into public.shopify_connections (tenant_id, shop_domain, credentials_ciphertext, credentials_key_id, scopes)
                values (${T.tenantId}, ${shop}, ${sealed.ciphertext}, ${sealed.keyId}, ${['read_orders']})`;
  }
  const llm = model(opts.classify ?? cls());
  const orders = shopifyOrders({
    sql: worker,
    keys,
    shopify: createShopifyClient({ baseUrl: mock.baseUrl }),
    app: APP,
  });
  return {
    T,
    llm,
    async ask(o) {
      const msg = inbound({
        ...(o.from ? { from: o.from } : {}),
        subject: o.subject ?? 'Where is my order?',
        text: o.text,
      });
      const id = (await withTenant(worker, T.tenantId, (tx) =>
        storeInbound(tx, { tenantId: T.tenantId, connectionId: T.connectionId, uid: 1, msg }),
      ))!;
      const outcome = await processMessage(
        { sql: worker, llm, embeddings: new FakeProvider(), orders },
        T.tenantId,
        id,
      );
      return { id, outcome };
    },
  };
}

const rows = async (c: Ctx, id: string) => {
  const drafts = await owner<{ kind: string; status: string; body: string | null }[]>`
    select kind, status, body from public.drafts where tenant_id = ${c.T.tenantId} and source_message_id = ${id} order by created_at`;
  const [esc] = await owner<{ category: string; reason: string }[]>`
    select category, reason from public.escalations where message_id = ${id}`;
  const [p] = await owner<
    {
      status: string;
      final_action: string;
      order_lookup: Record<string, unknown> | null;
      downgrade_reasons: string[];
    }[]
  >`
    select status, final_action, order_lookup, downgrade_reasons from public.message_processing where message_id = ${id}`;
  return { drafts, esc, p: p! };
};
const generations = (c: Ctx) => c.llm.calls.filter((r) => kindOf(r) === 'generate');
const graphqlCalls = () => mock.requests.filter((r) => r.path.includes('graphql')).length;

describe('found and shipped (#1002)', () => {
  it('auto mode: a verified, simple case is answered with the facts and sent', async () => {
    const c = await setup('auto_send');
    const { id, outcome } = await c.ask({ text: 'Hi, where is my order #1002? Thanks, Gvido' });
    expect(outcome).toEqual({ status: 'auto_send', reasons: [] });
    const { drafts, p } = await rows(c, id);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ kind: 'reply', status: 'approved' });
    expect(drafts[0]!.body).toContain('has shipped');
    expect(drafts[0]!.body).toContain('LV987654321');
    expect(drafts[0]!.body).toContain('https://tracking.example-carrier.test/LV987654321');
    expect(p.order_lookup).toMatchObject({
      platform: 'shopify',
      result: 'found',
      orderName: '#1002',
      payment: 'paid',
      fulfillment: 'shipped',
      carrier: 'Latvijas Pasts',
      trackingNumber: 'LV987654321',
    });
    const [job] =
      await owner`select 1 from public.jobs where tenant_id = ${c.T.tenantId} and queue = 'mail.send'`;
    expect(job).toBeTruthy();
    // The model got the facts as structured input: the order number, status and tracking, nothing about the customer.
    const prompt = JSON.stringify(generations(c)[0]!.parts) + generations(c)[0]!.system;
    expect(prompt).toContain('tracking number: LV987654321');
    expect(prompt).not.toMatch(/gowxs612@gmail\.com\b.*Order #1002/s);
  });
  it('approve-everything mode: the same answer is a draft, never sent', async () => {
    const c = await setup('draft_only');
    const { id, outcome } = await c.ask({ text: 'Where is order #1002?' });
    expect(outcome).toEqual({ status: 'drafted', reasons: ['tenant_draft_only'] });
    const { drafts } = await rows(c, id);
    expect(drafts[0]).toMatchObject({ status: 'pending_approval' });
    expect(
      await owner`select 1 from public.jobs where tenant_id = ${c.T.tenantId} and queue = 'mail.send'`,
    ).toHaveLength(0);
  });
  it('finds the order from the sender address when no number is given', async () => {
    const c = await setup('auto_send');
    const { id, outcome } = await c.ask({
      from: 'solo@example.com',
      text: 'Hello, where is my parcel?',
    });
    expect(outcome.status).toBe('auto_send');
    expect((await rows(c, id)).p.order_lookup).toMatchObject({
      orderName: '#2001',
      result: 'found',
    });
  });
  it('a bare number in the e-mail is enough', async () => {
    const c = await setup('auto_send');
    const { outcome } = await c.ask({ text: 'Hi, any news on 1002?' });
    expect(outcome.status).toBe('auto_send');
  });
  it('an order question the classifier called "support" is still answered when it names the order', async () => {
    const c = await setup('auto_send', { classify: cls({ category: 'support' }) });
    const { outcome } = await c.ask({ text: 'My order #1002 has not arrived' });
    expect(outcome.status).toBe('auto_send');
  });
});

describe('found, not shipped (#1003)', () => {
  it('says it has not shipped yet', async () => {
    const c = await setup('auto_send');
    const { id, outcome } = await c.ask({ text: 'Has order #1003 shipped?' });
    expect(outcome.status).toBe('auto_send');
    const { drafts, p } = await rows(c, id);
    expect(drafts[0]!.body).toContain('has not shipped yet');
    expect(drafts[0]!.body).not.toMatch(/tracking/i);
    expect(p.order_lookup).toMatchObject({ orderName: '#1003', fulfillment: 'not_shipped' });
  });
});

describe('escalations: the owner decides, nothing is guessed', () => {
  const escalated = async (c: Ctx, text: string, from?: string) => {
    const { id, outcome } = await c.ask({ text, ...(from ? { from } : {}) });
    return { id, outcome, ...(await rows(c, id)) };
  };

  it.each([
    ['cancelled and refunded (#1004)', 'Where is order #1004?', 'order_cancelled_or_refunded'],
    ['no shipping update for 30 days (#1005)', 'Where is order #1005?', 'order_shipment_stale'],
    ['fulfilled but no tracking (#1006)', 'Where is order #1006?', 'order_fulfilled_no_tracking'],
    ['partly fulfilled (#1007)', 'Where is order #1007?', 'order_partially_fulfilled'],
    ['several orders for the address, no number', 'Where is my order?', 'order_ambiguous'],
    ['several numbers named', 'Where are orders #1002 and #1003?', 'order_ambiguous'],
    ['order not found', 'Where is order #9999?', 'order_not_found'],
  ])('%s', async (_name, text, reason) => {
    const c = await setup('auto_send');
    const r = await escalated(c, text);
    expect(r.outcome.status).toBe('escalated');
    expect(r.esc!.reason).toContain(reason);
    expect(r.p.order_lookup).toMatchObject({ result: 'escalated', reason });
    // The model never wrote an answer about an order that needs a person.
    expect(generations(c).every((g) => g.system.includes('could not be matched'))).toBe(true);
    // Never an automatic reply about the order.
    expect(r.drafts.filter((d) => d.status === 'approved')).toHaveLength(0);
  });

  it('a payment still pending is answered but only as a draft (not auto)', async () => {
    const c = await setup('auto_send');
    const r = await escalated(c, 'Where is order #1008?');
    expect(r.outcome.status).toBe('drafted');
    expect(r.p.downgrade_reasons).toEqual(
      expect.arrayContaining(['order_needs_check', 'order_payment_not_paid']),
    );
    expect(r.drafts[0]!.status).toBe('pending_approval');
  });

  it.each([
    [
      'asks for a refund or return',
      'I want to return the candles from order #1002, please refund me',
      'order_change_request',
    ],
    [
      'asks to change the address',
      'Please change the delivery address of order #1003',
      'order_change_request',
    ],
    [
      'threatens a chargeback',
      'Where is order #1002? Otherwise I start a chargeback with my bank',
      'order_chargeback',
    ],
  ])('%s: a person answers, Shopify is not even asked', async (_n, text, reason) => {
    const c = await setup('auto_send');
    const before = graphqlCalls();
    const r = await escalated(c, text);
    expect(r.outcome.status).toBe('escalated');
    expect(r.esc).toMatchObject({ category: 'hard_list' });
    expect(r.esc!.reason).toContain(reason);
    expect(graphqlCalls()).toBe(before);
    expect(generations(c)).toHaveLength(0);
    expect(r.drafts).toHaveLength(0);
  });

  it('an angry customer goes through the hard list before any lookup', async () => {
    const c = await setup('auto_send', { classify: cls({ sentiment: 'angry' }) });
    const before = graphqlCalls();
    const r = await escalated(c, 'Where is my order #1002?! This is unacceptable');
    expect(r.outcome.status).toBe('escalated');
    expect(graphqlCalls()).toBe(before);
  });
});

describe("identity: another person's order reveals nothing", () => {
  const SECRETS = ['Russell', 'russel.winfield', 'RW555000111', 'Secret gift box', 'DHL'];
  it("a mail from the Gvido address about #1001 (Russell's order) is escalated and nothing leaks", async () => {
    const c = await setup('auto_send');
    const { id, outcome } = await c.ask({ text: 'Hi, where is my order #1001?' });
    expect(outcome.status).toBe('escalated');
    const { drafts, esc, p } = await rows(c, id);
    expect(esc!.reason).toContain('order_identity_mismatch');
    // What the customer could get: at most a request for the order number and checkout e-mail (an unsent suggestion for the owner).
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ status: 'suggestion' });
    expect(drafts[0]!.body).toMatch(/order number/i);
    expect(p.order_lookup).toEqual({
      result: 'escalated',
      reason: 'order_identity_mismatch',
      orderName: '#1001',
      checkedAt: expect.any(String),
    });

    const everything = JSON.stringify({
      prompts: c.llm.calls.map((r) => [r.system, r.parts]),
      drafts,
      lookup: p.order_lookup,
      notifications:
        await owner`select payload from public.notifications where tenant_id = ${c.T.tenantId}`,
      escalations: await owner`select * from public.escalations where tenant_id = ${c.T.tenantId}`,
      processing: await owner`select * from public.message_processing where message_id = ${id}`,
    });
    for (const s of SECRETS) expect(everything).not.toContain(s);
  });
  it('mode 3: the acknowledgement for such an e-mail contains no order data either', async () => {
    const c = await setup('full_auto');
    const { id } = await c.ask({ text: 'Hi, where is my order #1001?' });
    const { drafts } = await rows(c, id);
    const ack = drafts.find((d) => d.kind === 'acknowledgement');
    expect(ack).toBeTruthy();
    for (const s of SECRETS) expect(JSON.stringify(drafts)).not.toContain(s);
  });
  it('the reverse is fine: Russell asking about #1001 gets his answer', async () => {
    const c = await setup('auto_send');
    const { outcome } = await c.ask({
      from: 'russel.winfield@example.com',
      text: 'Where is order #1001?',
    });
    expect(outcome.status).toBe('auto_send');
  });
  it('a similar address (plus-tag, other case folded) is judged exactly: +tag does not match', async () => {
    const c = await setup('auto_send');
    const { outcome } = await c.ask({
      from: 'gowxs612+shop@gmail.com',
      text: 'Where is order #1002?',
    });
    expect(outcome.status).toBe('escalated');
    const upper = await c.ask({ from: 'GOWXS612@GMAIL.COM', text: 'Where is order #1002?' });
    expect(upper.outcome.status).toBe('auto_send');
  });
});

describe('the connection', () => {
  it('without a connection an order e-mail is handled like any other and Shopify is never called', async () => {
    const c = await setup('auto_send', { connect: false });
    const before = mock.requests.length;
    const { id } = await c.ask({ text: 'Where is order #1002?' });
    expect(mock.requests.length).toBe(before);
    expect((await rows(c, id)).p.order_lookup).toBeNull();
  });
  it('Shopify being down hands the e-mail to the owner and keeps the connection', async () => {
    const c = await setup('auto_send');
    mock.failNext(500, 2);
    const { id, outcome } = await c.ask({ text: 'Where is order #1002?' });
    expect(outcome.status).toBe('escalated');
    expect((await rows(c, id)).esc!.reason).toContain('order_lookup_unavailable');
    const [conn] =
      await owner`select status from public.shopify_connections where tenant_id = ${c.T.tenantId}`;
    expect(conn!.status).toBe('connected');
  });
  it('a revoked token is an escalation and marks the connection as needing attention', async () => {
    const c = await setup('auto_send');
    const saved = new Set(mock.validTokens);
    mock.revokeAll();
    try {
      const { outcome } = await c.ask({ text: 'Where is order #1002?' });
      expect(outcome.status).toBe('escalated');
    } finally {
      saved.forEach((t) => mock.validTokens.add(t));
    }
    const [conn] =
      await owner`select status, last_error_code from public.shopify_connections where tenant_id = ${c.T.tenantId}`;
    expect(conn).toMatchObject({ status: 'error', last_error_code: 'AUTH' });
    // Once broken, order e-mails get normal replies (no repeated failing lookups).
    const before = mock.requests.length;
    const again = await c.ask({ text: 'Where is order #1002?' });
    expect(mock.requests.length).toBe(before);
    expect((await rows(c, again.id)).p.order_lookup).toBeNull();
  });
  it('an expired access token is renewed once, under a lock, and the new tokens are saved sealed', async () => {
    const refresh = 'shprt_renew_test';
    mock.refreshTokens.add(refresh);
    const c = await setup('auto_send', {
      tokens: {
        accessToken: 'shpat_expired',
        refreshToken: refresh,
        accessExpiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    });
    const [before] = await owner<
      { credentials_ciphertext: Buffer }[]
    >`select credentials_ciphertext from public.shopify_connections where tenant_id = ${c.T.tenantId}`;
    const exchanges = () =>
      mock.requests.filter((r) => r.path === '/admin/oauth/access_token').length;
    const x0 = exchanges();
    const [a, b] = await Promise.all([
      c.ask({ text: 'Where is order #1002?' }),
      c.ask({ text: 'Where is order #1003?' }),
    ]);
    expect([a.outcome.status, b.outcome.status]).toEqual(['auto_send', 'auto_send']);
    expect(exchanges() - x0).toBe(1);
    const [after] = await owner<
      { credentials_ciphertext: Buffer; tokens_renewed_at: Date }[]
    >`select credentials_ciphertext, tokens_renewed_at from public.shopify_connections where tenant_id = ${c.T.tenantId}`;
    expect(Buffer.compare(after!.credentials_ciphertext, before!.credentials_ciphertext)).not.toBe(
      0,
    );
    expect(after!.credentials_ciphertext.toString('latin1')).not.toContain('shpat_minted');
  });
});

describe('tokens are never logged or stored in the clear', () => {
  it('nothing the pipeline prints or stores contains a token', async () => {
    const out: string[] = [];
    const so = process.stdout.write.bind(process.stdout);
    const se = process.stderr.write.bind(process.stderr);
    const cap = (w: typeof so) =>
      ((chunk: string | Uint8Array, ...rest: never[]) => (
        out.push(String(chunk)),
        w(chunk as never, ...rest)
      )) as typeof so;
    process.stdout.write = cap(so);
    process.stderr.write = cap(se);
    const token = [...mock.validTokens][0]!;
    try {
      const c = await setup('auto_send');
      mock.failNext(500, 2);
      await c.ask({ text: 'Where is order #1002?' });
      await c.ask({ text: 'Where is order #1002?' });
      await c.ask({ text: 'Where is order #1001?' });
      const stored = JSON.stringify([
        await owner`select * from public.shopify_connections where tenant_id = ${c.T.tenantId}`,
        await owner`select * from public.audit_log where tenant_id = ${c.T.tenantId}`,
        await owner`select payload from public.notifications where tenant_id = ${c.T.tenantId}`,
        await owner`select * from public.message_processing where tenant_id = ${c.T.tenantId}`,
        c.llm.calls.map((r) => [r.system, r.parts]),
      ]);
      expect(stored).not.toContain(token);
      expect(stored).not.toContain('shprt_seed');
    } finally {
      process.stdout.write = so;
      process.stderr.write = se;
    }
    expect(out.join('')).not.toContain(token);
    expect(out.join('')).not.toContain('shprt_seed');
  });
});

describe('access log for customer data', () => {
  it('every order lookup is logged with its outcome and no personal data', async () => {
    const c = await setup('auto_send');
    await c.ask({ text: 'Where is order #1002?' });
    await c.ask({ text: 'Where is order #1001?' }); // another person's order was read to check identity: logged too
    await c.ask({ text: 'Where is order #1002? chargeback' }); // never looked up: not logged
    const log = await owner<{ metadata: Record<string, unknown> }[]>`
      select metadata from public.audit_log where tenant_id = ${c.T.tenantId} and action = 'shopify.order_lookup' order by created_at`;
    expect(log.map((r) => r.metadata)).toEqual([
      { by: 'number', matches: 1, outcome: 'answered' },
      { by: 'number', matches: 1, outcome: 'order_identity_mismatch' },
    ]);
    expect(JSON.stringify(log)).not.toMatch(/russel|gowxs|@/i);
  });
});

describe('retention', () => {
  it('the order summary is deleted with the message content', async () => {
    const c = await setup('auto_send');
    const { id } = await c.ask({ text: 'Where is order #1002?' });
    expect((await rows(c, id)).p.order_lookup).not.toBeNull();
    await owner`update public.messages set received_at = now() - interval '200 days' where id = ${id}`;
    await worker`select * from app.purge_expired_content()`;
    expect((await rows(c, id)).p.order_lookup).toBeNull();
  });
});

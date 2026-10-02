import { withTenant } from '@noctiv/db';
import { seedTenant, type SeededTenant } from '@noctiv/db/testing';
import { FakeProvider } from '@noctiv/llm';
import { createShopifyClient } from '@noctiv/shopify';
import { createWooClient, sealCredentials } from '@noctiv/woocommerce';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startMockWoo, type MockWoo } from '../../../packages/woocommerce/test/mock-woocommerce.ts';
import { storeInbound } from '../src/ingest/store.ts';
import { combineOrders } from '../src/orders/deps.ts';
import { processMessage } from '../src/pipeline/process.ts';
import { shopifyOrders } from '../src/shopify/connection.ts';
import { wooOrders } from '../src/woocommerce/connection.ts';
import { keys } from './helpers.ts';
import { cls, GVIDO, inbound, kindOf, model } from './wismo-helpers.ts';

const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const worker = postgres(inject('workerDatabaseUrl'), { max: 6, onnotice: () => {} });
const KEY = 'ck_' + 'a1'.repeat(20);
const SECRET = 'cs_' + 'b2'.repeat(20);

let mock: MockWoo;
beforeAll(async () => {
  mock = await startMockWoo({ consumerKey: KEY, consumerSecret: SECRET });
});
afterAll(async () => {
  await mock.close();
  await Promise.all([owner.end(), worker.end()]);
});

let n = 0;
async function setup(
  mode: 'draft_only' | 'auto_send' | 'full_auto',
  opts: { connect?: boolean; secret?: string; classify?: string } = {},
) {
  const T: SeededTenant = await seedTenant(owner, `woo-wismo-${n++}`, { embeddingAxis: 200 + n });
  await owner`update public.tenants set mode = ${mode}, name = 'Nordlicht Candles' where id = ${T.tenantId}`;
  await owner`delete from public.shopify_connections where tenant_id = ${T.tenantId}`;
  await owner`delete from public.woocommerce_connections where tenant_id = ${T.tenantId}`;
  const store = `https://woo${n}.example.com`;
  if (opts.connect !== false) {
    const sealed = sealCredentials(
      { consumerKey: KEY, consumerSecret: opts.secret ?? SECRET },
      keys.publicKey,
      store,
    );
    await owner`insert into public.woocommerce_connections (tenant_id, store_url, credentials_ciphertext, credentials_key_id)
                values (${T.tenantId}, ${store}, ${sealed.ciphertext}, ${sealed.keyId})`;
  }
  const llm = model(opts.classify ?? cls());
  const orders = combineOrders([
    {
      platform: 'shopify',
      deps: shopifyOrders({ sql: worker, keys, shopify: createShopifyClient(), app: null }),
    },
    {
      platform: 'woocommerce',
      deps: wooOrders({
        sql: worker,
        keys,
        woo: createWooClient({ get: mock.get, rewrite: mock.rewrite }),
      }),
    },
  ]);
  return {
    T,
    llm,
    async ask(o: { from?: string; subject?: string; text: string }) {
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
type Ctx = Awaited<ReturnType<typeof setup>>;

const rows = async (c: Ctx, id: string) => {
  const drafts = await owner<{ kind: string; status: string; body: string | null }[]>`
    select kind, status, body from public.drafts where tenant_id = ${c.T.tenantId} and source_message_id = ${id} order by created_at`;
  const [esc] = await owner<{ category: string; reason: string }[]>`
    select category, reason from public.escalations where message_id = ${id}`;
  const [p] = await owner<
    { status: string; order_lookup: Record<string, unknown> | null }[]
  >`select status, order_lookup from public.message_processing where message_id = ${id}`;
  return { drafts, esc, p: p! };
};
const generations = (c: Ctx) => c.llm.calls.filter((r) => kindOf(r) === 'generate');
const orderCalls = () => mock.requests.filter((r) => r.path.includes('/orders')).length;

describe('found and shipped (#1002): tracking from the Shipment Tracking plugin', () => {
  it('auto mode: a verified, simple case is answered with the facts and sent', async () => {
    const c = await setup('auto_send');
    const { id, outcome } = await c.ask({ text: 'Hi, where is my order #1002? Thanks, Gvido' });
    expect(outcome).toEqual({ status: 'auto_send', reasons: [] });
    const { drafts, p } = await rows(c, id);
    expect(drafts[0]).toMatchObject({ kind: 'reply', status: 'approved' });
    expect(drafts[0]!.body).toContain('has shipped');
    expect(drafts[0]!.body).toContain('LV987654321');
    expect(drafts[0]!.body).toContain('https://tracking.example-carrier.test/LV987654321');
    expect(p.order_lookup).toMatchObject({
      platform: 'woocommerce',
      result: 'found',
      orderName: '#1002',
      payment: 'paid',
      fulfillment: 'shipped',
      carrier: 'Latvijas Pasts',
      trackingNumber: 'LV987654321',
    });
    // Only facts reach the model: no address, phone, payment method or key.
    const prompt = JSON.stringify(generations(c)[0]!.parts) + generations(c)[0]!.system;
    expect(prompt).toContain('tracking number: LV987654321');
    for (const s of ['Private Street', '20000000', 'stripe', KEY, SECRET])
      expect(prompt).not.toContain(s);
  });
  it('approve-everything mode: the same answer is a draft, never sent', async () => {
    const c = await setup('draft_only');
    const { id, outcome } = await c.ask({ text: 'Where is order #1002?' });
    expect(outcome).toEqual({ status: 'drafted', reasons: ['tenant_draft_only'] });
    expect((await rows(c, id)).drafts[0]).toMatchObject({ status: 'pending_approval' });
    expect(
      await owner`select 1 from public.jobs where tenant_id = ${c.T.tenantId} and queue = 'mail.send'`,
    ).toHaveLength(0);
  });
  it('finds the order from the sender address when no number is given', async () => {
    const c = await setup('auto_send');
    const { id, outcome } = await c.ask({ from: 'solo@example.com', text: 'Where is my parcel?' });
    expect(outcome.status).toBe('auto_send');
    expect((await rows(c, id)).p.order_lookup).toMatchObject({ orderName: '#2001' });
  });
  it('tracking only in a customer note ("Tracking number: …") is used, and only when explicit', async () => {
    const c = await setup('auto_send');
    const { id } = await c.ask({ text: 'Where is order #1006?' });
    expect((await rows(c, id)).drafts[0]!.body).toContain('LV555123456');
  });
  it('tracking from the plugin REST endpoint is used', async () => {
    const c = await setup('auto_send');
    const { id } = await c.ask({ text: 'Where is order #1007?' });
    expect((await rows(c, id)).drafts[0]!.body).toContain('DPD777000');
  });
  it('writes an access-log row without personal data', async () => {
    const c = await setup('auto_send');
    const { id } = await c.ask({ text: 'Where is order #1002?' });
    const log = await owner<{ action: string; metadata: Record<string, unknown> }[]>`
      select action, metadata from public.audit_log where tenant_id = ${c.T.tenantId} and target_id = ${id}`;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      action: 'woocommerce.order_lookup',
      metadata: { by: 'number', matches: expect.any(Number), outcome: 'answered' },
    });
    const text = JSON.stringify(log);
    for (const s of [GVIDO, '1002', 'LV987654321', 'Latvijas']) expect(text).not.toContain(s);
  });
});

describe('not shipped (#1003)', () => {
  it('is answered as not shipped yet', async () => {
    const c = await setup('auto_send');
    const { id } = await c.ask({ text: 'Where is my order #1003?' });
    const { drafts, p } = await rows(c, id);
    expect(drafts[0]!.body).toContain('has not shipped yet');
    expect(p.order_lookup).toMatchObject({ fulfillment: 'not_shipped' });
  });
});

describe('every escalation: a person answers, nothing is guessed', () => {
  it.each([
    ['cancelled (#1004)', 'Where is my order #1004?', 'order_cancelled_or_refunded'],
    ['refunded (#1012)', 'Where is my order #1012?', 'order_cancelled_or_refunded'],
    ['partly refunded (#1010)', 'Where is my order #1010?', 'order_cancelled_or_refunded'],
    ['on hold (#1008)', 'Where is my order #1008?', 'order_partially_fulfilled'],
    ['a status from a plugin (#1011)', 'Where is my order #1011?', 'order_partially_fulfilled'],
    [
      'shipped but no tracking anywhere (#1005)',
      'Where is my order #1005?',
      'order_fulfilled_no_tracking',
    ],
    ['no shipping update for a month (#1009)', 'Where is my order #1009?', 'order_shipment_stale'],
    ['unknown order', 'Where is my order #424242?', 'order_not_found'],
    ['two orders named', 'Where are orders #1002 and #1003?', 'order_ambiguous'],
  ])('%s', async (_n, text, reason) => {
    const c = await setup('auto_send');
    const { id, outcome } = await c.ask({ text });
    expect(outcome.status).toBe('escalated');
    const { esc, drafts } = await rows(c, id);
    expect(esc!.reason).toContain(reason);
    expect(drafts.filter((d) => d.status !== 'suggestion')).toHaveLength(0);
  });
  it('a shipped order without tracking says so to the owner and nothing to the customer', async () => {
    const c = await setup('auto_send');
    const { id } = await c.ask({ text: 'Where is my order #1005?' });
    const { p, drafts } = await rows(c, id);
    expect(p.order_lookup).toMatchObject({
      result: 'escalated',
      reason: 'order_fulfilled_no_tracking',
    });
    expect(drafts.some((d) => d.status === 'approved')).toBe(false);
  });
  it.each([
    ['refund', 'I want a refund for order #1002', 'order_change_request'],
    [
      'return',
      'I want to return the candles from order #1002, please refund me',
      'order_change_request',
    ],
    ['address change', 'Please change the delivery address of order #1003', 'order_change_request'],
    ['chargeback', 'Where is order #1002? Otherwise I start a chargeback', 'order_chargeback'],
  ])('%s is handed over before the store is even asked', async (_n, text, reason) => {
    const c = await setup('auto_send');
    const before = orderCalls();
    const { id, outcome } = await c.ask({ text });
    expect(outcome.status).toBe('escalated');
    expect((await rows(c, id)).esc!.reason).toContain(reason);
    expect(orderCalls()).toBe(before);
    expect(generations(c)).toHaveLength(0);
  });
  it('the stale-days setting applies', async () => {
    const c = await setup('auto_send');
    // #1009 was shipped 30 days ago: past the default 14 days, but within 90.
    await owner`update public.tenants set shopify_stale_days = 90 where id = ${c.T.tenantId}`;
    const r = await c.ask({ text: 'Where is my order #1009?' });
    expect(r.outcome.status).not.toBe('escalated');
  });
});

describe("identity: another person's order reveals nothing", () => {
  const SECRETS = ['Russell', 'russel.winfield', 'RW555000111', 'Secret gift box', 'DHL'];
  it('a mail from the Gvido address about #1001 is escalated and nothing leaks', async () => {
    const c = await setup('auto_send');
    const { id, outcome } = await c.ask({ text: 'Hi, where is my order #1001?' });
    expect(outcome.status).toBe('escalated');
    const { drafts, esc, p } = await rows(c, id);
    expect(esc!.reason).toContain('order_identity_mismatch');
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
      audit: await owner`select * from public.audit_log where tenant_id = ${c.T.tenantId}`,
    });
    for (const s of SECRETS) expect(everything).not.toContain(s);
  });
  it('mode 3: the acknowledgement for such an e-mail contains no order data either', async () => {
    const c = await setup('full_auto');
    const { id } = await c.ask({ text: 'Hi, where is my order #1001?' });
    const { drafts } = await rows(c, id);
    expect(drafts.find((d) => d.kind === 'acknowledgement')).toBeTruthy();
    for (const s of SECRETS) expect(JSON.stringify(drafts)).not.toContain(s);
  });
  it('the owner of the order gets the answer; the billing e-mail match is case-insensitive', async () => {
    const c = await setup('auto_send');
    const { outcome } = await c.ask({
      from: 'Russel.Winfield@Example.com',
      text: 'Where is order #1001?',
    });
    expect(outcome.status).toBe('auto_send');
  });
});

describe('the connection', () => {
  it('without a connection an order e-mail is handled like any other and the store is never called', async () => {
    const c = await setup('auto_send', { connect: false });
    const before = orderCalls();
    const { id } = await c.ask({ text: 'Where is my order #1002?' });
    expect((await rows(c, id)).p.order_lookup).toBeNull();
    expect(orderCalls()).toBe(before);
  });
  it('the store being down hands the e-mail to the owner and keeps the connection', async () => {
    const c = await setup('auto_send');
    mock.failNext(503, 1);
    const { id, outcome } = await c.ask({ text: 'Where is my order #1002?' });
    expect(outcome.status).toBe('escalated');
    expect((await rows(c, id)).esc!.reason).toContain('order_lookup_unavailable');
    const [conn] =
      await owner`select status from public.woocommerce_connections where tenant_id = ${c.T.tenantId}`;
    expect(conn!.status).toBe('connected');
  });
  it('a key the store no longer accepts is an escalation and marks the connection', async () => {
    const c = await setup('auto_send', { secret: 'cs_' + 'c3'.repeat(20) });
    const { id } = await c.ask({ text: 'Where is my order #1002?' });
    expect((await rows(c, id)).esc!.reason).toContain('order_lookup_unavailable');
    const [conn] =
      await owner`select status, last_error_code from public.woocommerce_connections where tenant_id = ${c.T.tenantId}`;
    expect(conn).toMatchObject({ status: 'error', last_error_code: 'AUTH' });
  });
  it('only ever reads, and the key never appears in what is stored, logged or sent to the model', async () => {
    const c = await setup('auto_send');
    await c.ask({ text: 'Where is my order #1002?' });
    expect(mock.requests.every((r) => r.method === 'GET')).toBe(true);
    expect(JSON.stringify(mock.requests)).not.toContain(KEY);
    expect(JSON.stringify(c.llm.calls)).not.toContain(KEY);
    const stored = JSON.stringify({
      p: await owner`select * from public.message_processing where tenant_id = ${c.T.tenantId}`,
      a: await owner`select * from public.audit_log where tenant_id = ${c.T.tenantId}`,
      j: await owner`select * from public.jobs where tenant_id = ${c.T.tenantId}`,
    });
    expect(stored).not.toContain(KEY);
    expect(stored).not.toContain(SECRET);
  });
});

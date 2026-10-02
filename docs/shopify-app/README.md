# Shopify app (order lookup / WISMO)

Noctiv answers "Where is my order?" e-mails from live Shopify data. Read-only: scope `read_orders` only,
nothing is written to Shopify. Order lookup logic (`packages/orders`) is platform neutral; Shopify specifics
(OAuth, GraphQL, webhooks) live in `packages/shopify`, so WooCommerce can be added later without touching the decision engine.

## How a merchant connects

Shopify OAuth authorization code grant, expiring offline tokens (1 h access, 90 day refresh; both replaced on refresh).

1. Merchant installs the app from Shopify (`/shopify/install?shop=…&hmac=…`, HMAC verified, signed state + cookie nonce).
2. Callback exchanges the code, checks that granted scopes are exactly `read_orders`, seals the credentials
   (X25519 + AES-GCM, associated data bound to the shop domain) and stores a one-time claim token.
3. The merchant is sent to Noctiv, logs in and claims the install for their business (Integrations → Shopify).
4. Only the worker can open the sealed credentials; tokens are refreshed under a row lock.
5. "Disconnect and delete token" revokes at Shopify and deletes the sealed credentials. Uninstalling in Shopify and the
   mandatory compliance webhooks (`customers/data_request`, `customers/redact`, `shop/redact`, `app/uninstalled`) do the same.

## Environment variables

| Where  | Variable                                             | Meaning                                   |
| ------ | ---------------------------------------------------- | ----------------------------------------- |
| API    | `SHOPIFY_APP_CLIENT_ID`, `SHOPIFY_APP_CLIENT_SECRET` | Partner Dashboard app credentials         |
| API    | `SHOPIFY_INSTALL_URL`                                | Public install link shown in Integrations |
| Worker | `SHOPIFY_APP_CLIENT_ID`, `SHOPIFY_APP_CLIENT_SECRET` | Used to refresh/revoke tokens             |

Set them in `.env` (git-ignored) and in Northflank. Never commit them.

## Owner checklist: Partner Dashboard

1. **Create the app** (Partner Dashboard → Apps → Create app). Use `shopify.app.toml` in this folder as the template
   (app URL `/shopify/app`, redirect `/shopify/callback`, scope `read_orders`, compliance webhooks).
2. **Protected customer data**: Apps → API access requests → Protected customer data access. Request level 2 (customer e-mail,
   name). Development stores need no review; real merchants do. Answer with `data-protection-review.md`.
3. **Distribution**: choose public distribution (can stay unlisted) for more than one merchant. Custom distribution
   is limited to a single store or one Plus organization.
4. **Billing – ask Partner Support before submitting.** We bill via Paddle. Shopify App Store requirement 1.2.1 says
   apps listed in the App Store must use Shopify billing. Whether an _unlisted_ public app tied to a paid external service
   may charge outside Shopify billing is not clearly documented; Shopify staff have said such apps still need a Shopify
   payment path unless they are existing off-platform clients. Ask Partner Support in writing and keep the answer.
5. **Registered business**: the documentation does not require a registered company; individuals or entities can register
   as a Partner (one-time fee on the revenue-share plan). Check the Partner Program Agreement for your situation, and
   whether protected-data review asks for company details.
6. **Embedded app**: App Store requirements 2.2.2/2.2.3 expect an embedded app with App Bridge, and 2.3.1 forbids
   asking merchants to type their shop domain. Our `/shopify/app` page is a minimal landing page that completes the claim;
   confirm with Shopify whether that is enough for an unlisted app, otherwise an embedded page is needed (not built).
7. **Fill in**: privacy policy URL (`/privacy`), emergency contact, support e-mail. Sign `security-and-incident-response.md`.

## Public site: what to flip once the above is done and the app is installable

Held back on purpose (the site still says "coming soon"): `apps/site/src/pages/integrations.html`,
`apps/site/src/pages/for/shopify-stores.html`, the compare pages that list Shopify as coming soon, and
`apps/site/src/public/llms.txt`. Draft pages (`"draft": true`): `help/shopify-order-lookup.html`, `for/where-is-my-order.html`.
Remove the draft flag at the same time.

## Tests

- `packages/orders`, `packages/shopify` unit tests (parsing, identity, decisions, OAuth client against a mock Shopify).
- `apps/worker/test/wismo.db.test.ts`, `apps/api/test/shopify.db.test.ts` (DB + mock Shopify end to end, token never logged).
- Live dev-store test: only when `SHOPIFY_TEST_SHOP` and `SHOPIFY_TEST_ACCESS_TOKEN` are present in `.env`; skipped otherwise.

## Dev Dashboard values (production base `https://app.noctiv.io/api`)

The base is `PUBLIC_API_URL`, or `PUBLIC_APP_URL` + `/api` when that is unset (the web app proxies `/api/*` to the API).
If production sets `PUBLIC_API_URL`, use that host instead of `https://app.noctiv.io/api` everywhere below.

- App URL: `https://app.noctiv.io/api/shopify/app`
- Allowed redirection URL: `https://app.noctiv.io/api/shopify/callback`
- Compliance webhooks (`customers/data_request`, `customers/redact`, `shop/redact`) and `app/uninstalled`, all four:
  `https://app.noctiv.io/api/shopify/webhooks` (the topic arrives in the `X-Shopify-Topic` header)
- Embed app in Shopify admin: off. Use legacy install flow: on (the code sends `scope=read_orders` in the authorize URL).
- `SHOPIFY_INSTALL_URL`: the install link Shopify generates for the app (Dev Dashboard → Distribution). It is not a Noctiv URL.

## Reading the install logs

`/shopify/app` and `/shopify/callback` write one line per request: `shopify <route> <status> <reason>` with a `shopify` object
(`reason`, `status`, `requestHost`, `publicHost`, `redirectUri`, `signedParams` = parameter names only). No signature, code, state or cookie is logged.
Every request also logs `request completed` with the URL (query redacted), status and time.

| reason                                                                           | meaning                                                                                                                                           |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `missing_shop`, `bad_shop_domain`                                                | the request did not name a `*.myshopify.com` store                                                                                                |
| `hmac_invalid` (and `hmac_missing` on the callback)                              | not signed by Shopify with this client secret (wrong secret in Northflank, or a hand-made URL)                                                    |
| `hop_to_public_host`                                                             | Shopify called another host than `PUBLIC_API_URL` (e.g. the platform address); the install continues on the public host so the nonce cookie works |
| `breakout_iframe`                                                                | the app is set to embedded and Shopify framed it; the page reloads itself on top                                                                  |
| `redirect_to_authorize`                                                          | OK: sent to Shopify's consent screen with `redirectUri` (this must be in the app's Allowed redirection URLs)                                      |
| `state_invalid`, `state_shop_mismatch`, `nonce_cookie_missing`, `nonce_mismatch` | callback state or cookie failed (callback opened on another host than the install, or after 10 minutes)                                           |
| `shopify_error`, `missing_code`, `scopes_rejected`, `exchange_failed`            | Shopify refused, or the granted scopes are not exactly `read_orders`                                                                              |
| `installed`                                                                      | OK: tokens sealed, the owner links the store in Integrations                                                                                      |
| `routes_disabled`                                                                | `SHOPIFY_APP_CLIENT_ID/SECRET` or `ACTION_LINK_SECRET` missing on the API                                                                         |

If `/shopify/app` shows `redirect_to_authorize` and `/shopify/callback` never follows, Shopify did not accept `redirectUri`:
make the Dev Dashboard's Allowed redirection URL identical to it (scheme, host, path).

### Install start without a signature

The Dev Dashboard's "Install app" opens the App URL with only `?shop=<store>.myshopify.com` (no `hmac`). `/shopify/app` therefore starts
the OAuth flow for any request that names a valid `*.myshopify.com` store: it only redirects to Shopify's consent screen (signed
state + nonce cookie) and stores, links and reveals nothing (`signed: false` in the log). If an `hmac` is present it must be correct.
`/shopify/callback` always requires Shopify's signature, and the pending install can only be linked by a signed-in owner with the signed claim.
Shopify's authorization-code-grant page only requires the HMAC check on the callback; it does not say whether the install start is signed.

### When Shopify lands on the store admin instead of the consent screen

`redirect_to_authorize` is logged with `authorize` (the exact host, path and parameters Shopify was sent to, state masked), `referer`
(where the merchant came from, without its query) and `secFetch`. If no `shopify callback` line follows, Shopify did not send the merchant to
the callback. Things to check, in this order:

1. Is the app already installed on the store? (Store admin → Settings → Apps and sales channels.) Uninstall it and start again.
2. Does the Dev Dashboard version (active) hold exactly `application_url`, `redirect_urls` and `scopes = read_orders` from the log's `authorize` line?
3. Is the store in the same organization as the app, and does the staff account you are logged in as own the store (not a collaborator without app permission)?
4. Is a distribution method needed for this app to be installed on this store? The Dev Dashboard decides; Noctiv does not pick it.

## Development store without the consent screen (client credentials) — DEVELOPMENT ONLY

If the consent screen never appears (Shopify's authorize step returns to the admin home), the one development store that is in the **same
Shopify organization** as the app can be connected with the
[client credentials grant](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant): the app's own id and secret
are exchanged for a 24-hour token, and the worker mints a new one when it lapses. Shopify's page lists "You've installed your app on your store" as
a requirement, so if the app cannot be installed this may be refused; the refusal reason (`shop_not_permitted`, …) is shown to the owner.

Set on **both** the API and the worker (never anywhere a merchant could choose a shop): `SHOPIFY_DEV_CLIENT_CREDENTIALS_SHOP=noctiv-nvojutjr.myshopify.com`
(together with `SHOPIFY_APP_CLIENT_ID` and `SHOPIFY_APP_CLIENT_SECRET`). Then Integrations → Shopify shows a "Development only" box with
**Connect the development store**. The store is never taken from the request, only this one store can be connected this way, and merchants
are unaffected (they use the install flow). Remove the variable to switch it off.

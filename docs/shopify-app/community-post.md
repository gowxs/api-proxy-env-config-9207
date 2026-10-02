# Post for the Shopify developer community / Partner support

**Title:** Dev Dashboard app (Public distribution, not submitted, legacy install flow): `/admin/oauth/authorize` sends the merchant to the store admin home without a consent screen

**App type**

- Created in the Dev Dashboard, app name "noctiv", active version `noctiv-1`.
- Non-embedded (`embedded = false`), `use_legacy_install_flow = true`, scopes `read_orders` only.
- Distribution method: Public (selected; **not** submitted for review).
- Application URL `https://app.noctiv.io/api/shopify/app`, redirect URL `https://app.noctiv.io/api/shopify/callback`.
- Client ID `159d8f0cd8498422fe7c33549d659cc6` (public value). The dev store `noctiv-nvojutjr.myshopify.com` is in the same organization ("Noctiv") as the app.

**Click sequence**

1. Dev Dashboard → the app → Installs → "Install app" → choose `noctiv-nvojutjr`.
2. Shopify opens our Application URL in a new tab: `GET https://app.noctiv.io/api/shopify/app?shop=noctiv-nvojutjr.myshopify.com` (the first install attempts carried only `shop`; later ones carried `host`, `shop`, `timestamp` and a valid `hmac`).
3. Our server answers `302` to the standard authorize URL:
   `https://noctiv-nvojutjr.myshopify.com/admin/oauth/authorize?client_id=159d8f0cd8498422fe7c33549d659cc6&scope=read_orders&redirect_uri=https%3A%2F%2Fapp.noctiv.io%2Fapi%2Fshopify%2Fcallback&state=<198 characters>`
4. The browser goes to `accounts.shopify.com` ("Choose an account"), and then lands on `https://admin.shopify.com/store/noctiv-nvojutjr` (the admin home). No consent screen, no error message, and **our redirect URL is never called**. The app is not listed under Settings → Apps and sales channels.

**What our logs show** (UTC, one line per request, no secrets): `/shopify/app` hit and answered `302 redirect_to_authorize` at 11:51:58, 12:30:57, 12:40:07 and 12:40:51 (referer `admin.shopify.com`, `sec-fetch-site: cross-site`, `sec-fetch-mode: navigate`, `sec-fetch-dest: document`). There is no request to `/shopify/callback` at any time.

**What we ruled out**

- Same organization (the dev store belongs to the organization that owns the app).
- Client ID in our server matches the Dev Dashboard client ID exactly.
- Redirect URL we send is character for character the one in the active app version; the Application URL matches too.
- Not a browser problem: same result in an incognito window; no extensions.
- The app is not already installed on the store.
- Our server answers promptly with a plain `302`; the HMAC on the install request verifies.
- Not a firewall or WAF block on the callback: the callback is never requested.

**Related reports**

- https://github.com/Shopify/shopify-app-js/issues/3340 (draft/unpublished Public app, install stalls at `accounts.shopify.com`, app code believed correct, unresolved).
- https://community.shopify.dev/t/installing-public-app-on-development-store/26070 (Dev Dashboard install on a dev store asked for a distribution method; support says Public requires review only for non-dev-store installs).

**Questions**

1. For a Dev Dashboard app with Public distribution that has not been submitted, using the legacy install flow, what makes `/admin/oauth/authorize` redirect to the admin home instead of showing the consent screen, for a dev store in the same organization?
2. Is a state of ~200 characters, or the `accounts.shopify.com` "Choose an account" step before the redirect, a known cause?
3. Does the app need to be in a particular state (for example reviewed or listed) before OAuth can complete on a dev store, or is something else missing?
4. The client credentials grant says the app must be installed first. Is there a supported way to install it on a same-organization dev store when the consent screen never appears?

Happy to share the request logs (no secrets) or a screen recording.

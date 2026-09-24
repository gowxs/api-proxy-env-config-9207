# noctiv.io — marketing site plan

Separate from the app. Static, fast, accessible, no tracking. Lives in `apps/site`.

Status: **design system + home hero built, waiting for review.** The rest of the pages start after sign-off.

## 1. Story and principles

"The e-mail assistant that works while you sleep." The site tells one story: a customer writes at night, a reply is ready by morning.

1. **Night → morning.** Deep indigo for the hours Noctiv works; warm dawn light only where the work is done (the demo's 08:05 sky, the horizon line).
2. **One typeface.** Manrope (variable, OFL), self-hosted. Tabular figures for every time and price.
3. **Rules, not cards.** Content sits on hairlines. A surface appears only for a real object: a message, the price, a form. No card grids, blobs or stock illustrations.
4. **One moving thing.** The overnight inbox demo in the hero. Nothing else animates.
5. **Calm contrast.** Every text colour passes WCAG AA; body text passes AAA.

## 2. Design system

Source of truth: `apps/site/src/styles/tokens.css`. Live reference page: `/design-system/` (noindex, not in the sitemap).

### Colour

Light is the default; dark follows the system setting (`prefers-color-scheme`). Any element can pin a theme with `data-theme`.

| Token         | Light     | Dark      | Use                           |
| ------------- | --------- | --------- | ----------------------------- |
| `--bg`        | `#F5F6FA` | `#0D1330` | Page                          |
| `--surface`   | `#FFFFFF` | `#151D40` | Panels, fields                |
| `--surface-2` | `#ECEFF6` | `#1B2550` | Quiet fills                   |
| `--line`      | `#DCE0EB` | `#28325C` | Hairlines                     |
| `--text`      | `#131A2E` | `#EEF1FA` | Headings, body (16:1)         |
| `--text-2`    | `#4A5270` | `#B4BCD9` | Secondary text (7.1:1, 9.7:1) |
| `--text-3`    | `#646C8A` | `#8F98BD` | Labels, notes (4.8:1, 6.4:1)  |
| `--accent`    | `#3B2FD0` | `#5B4FE8` | Primary button (white 8.4:1)  |
| `--link`      | `#3B2FD0` | `#A9A2FF` | Links                         |
| `--ok`        | `#157A51` | `#4CC990` | Success text                  |

Night palette (fixed in both themes; hero, "Rules it can't break" band, footer): Night 950 `#070B1C`, 900 `#0B1026`, 800 `#121A3A`, 700 `#1B2550`, 600 `#2A3566`; night text `#EEF1FA` / `#B4BCD9` / `#8F98BD`; Moon `#F2D98B`. Morning (decorative only): Dawn `#F6C89A`, `#F2A97E`, Morning `#FDF3E4`.

**The dawn line:** a 1 px horizon gradient, the only gradient on the site. It closes the hero and separates night bands.

### Type (Manrope, fluid 360 → 1200 px)

| Step    | Size       | Weight | Tracking | Line height |
| ------- | ---------- | ------ | -------- | ----------- |
| Display | 38 → 64 px | 800    | −3.5%    | 1.06        |
| H2      | 28 → 42 px | 800    | −2.8%    | 1.12        |
| H3      | 19 → 22 px | 700    | −1.2%    | 1.3         |
| Lead    | 17 → 20 px | 400    | 0        | 1.55        |
| Body    | 16 px      | 400    | 0        | 1.6         |
| Small   | 14 px      | 400    | 0        | 1.5         |
| Label   | 12 px caps | 700    | +9%      | 1.3         |

Fonts: latin (25 KB) + latin-ext (15 KB) woff2 subsets, `font-display: swap`, latin preloaded, with a metric-matched Arial fallback so the swap causes no layout shift.

### Spacing and shape

4 px base: 4, 8, 12, 16, 24, 32, 48, 64, 96, 128. Sections 64 → 128 px; page gutters 16 px on phones, 32 px on desktop; content max width 1152 px, text measure 62 ch. Radii: 10 / 16 / 22 px and pill. Tap targets ≥ 44 px.

### Components

- **Buttons:** pill, 48 px tall. Primary (accent), secondary (outline), light (white pill on night, header). Focus: 3 px ring (moon yellow on night). Full width on phones under 480 px.
- **Rows:** rule-lined items for benefits, rules, steps (replaces card grids).
- **Panel:** the one surface (audiences, price, forms).
- **Fields:** 16 px text (no zoom on iOS), 48 px tall, label above.
- **Header:** sticky, night, blurred; links on desktop, a no-JS menu (`<details>`) on phones.
- **Footer:** night; product and company links, contact e-mail.

### The overnight inbox (hero demo)

A 14-second loop driven by `data-step` states: the customer e-mail arrives at 23:41; "Noctiv is drafting a reply"; the draft appears at 23:42 with its sources; "Sent to you for approval"; the clock runs 23:42 → 08:05 while the sky turns from night to morning and the moon becomes a sun; "Approved 08:05".

- Pure CSS transitions plus a 2 KB script; no library.
- Fixed layout (no reflow): every element is always in place, only opacity changes.
- The markup is the finished morning state, so it works without JavaScript.
- Reduced motion: shows the finished state, no animation.
- Pauses when off-screen or the tab is hidden; a visible Pause button (WCAG 2.2.2).
- The clock is decorative (`aria-hidden`); the figure caption states the three times.

## 3. Page map

Words and section order on Home are the approved draft. The other pages reuse approved copy where it exists; new copy is marked **(new, needs approval)**.

| Page         | Path             | Sections                                                                                                                                                                                                                                 |
| ------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home         | `/`              | Hero + overnight inbox · One assistant, three jobs · Built for two kinds of inbox · Rules it can't break (night band) · Up and running in an evening · Pricing · Questions · Footer                                                      |
| Pricing      | `/pricing/`      | One plan (approved price panel) · What's included (approved list) · Questions about billing (new, needs approval: trial end, cancelling, VAT/invoices) · Start trial CTA                                                                 |
| How it works | `/how-it-works/` | The overnight inbox, step by step (demo + captions) · Three jobs (approved) · Rules it can't break (approved) · Up and running in an evening (approved) · What it never does (new, needs approval)                                       |
| Privacy      | `/privacy/`      | Privacy notice for the website and the service: controller, data we process, purposes and legal bases, subprocessors (from `subprocessors.md`), locations, retention (90 days e-mail text default), rights, no tracking cookies, contact |
| Terms        | `/terms/`        | Service terms: the service, trial, fees, acceptable use, customer responsibilities (approval mode, knowledge base accuracy), data processing (DPA), liability, termination and deletion, governing law                                   |
| Contact      | `/contact/`      | contact@noctiv.io, response time, what to include; `mailto:` form-less first version (no backend, no third-party form service)                                                                                                           |
| 404          | `/404`           | Short night-themed page with a link home                                                                                                                                                                                                 |

Navigation: How it works · Pricing · Contact · Sign in (→ `https://app.noctiv.io/`) · **Start free trial** (→ `/pricing/`).

## 4. Technical

- **Build:** `apps/site/build.ts`, no framework and no runtime dependencies. Pages are HTML with a JSON header, assembled from partials; CSS (~12 KB min) inlined per page; the demo script inlined on Home only. Output: `apps/site/dist`.
- **Performance target:** Lighthouse 95+ on mobile for all four categories. The home page is ~30 KB HTML + 25 KB font, one request each, no images above the fold.
- **SEO:** unique titles and descriptions, canonical URLs, Open Graph + Twitter card, a 1200×630 OG image generated from HTML at build time, `sitemap.xml`, `robots.txt`, semantic headings, `lang="en"`.
- **Privacy:** no cookies, no analytics, no third-party requests (fonts self-hosted). If analytics are wanted later: Cloudflare Web Analytics (cookieless), only after an update to the privacy page.
- **Security headers** (`_headers`): strict CSP (self + inline styles/scripts hashed), HSTS, `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, frame-ancestors none; long cache for fonts and images.
- **Review tooling:** `pnpm --filter @noctiv/site shots` takes phone-size screenshots (390 × 844 @3x) in light and dark; `dev` serves on :4321.

## 5. Hosting and domains

- **Cloudflare Pages**, project `noctiv-site`, custom domains `noctiv.io` and `www.noctiv.io` (www → apex redirect).
- **DNS is already on Cloudflare** (nameservers `ara`/`yahir.ns.cloudflare.com`), so no nameserver change is needed.
  - The apex currently has proxied A records pointing to an origin that returns error 521. They get replaced when the Pages custom domain is attached.
  - Mail records stay untouched: MX Hostinger, SPF, Brevo code and DKIM.
- **App at `app.noctiv.io`:** a CNAME to `noctiv-app.netlify.app` (DNS only, not proxied), plus the domain added in Netlify. Supabase Auth Site URL and redirect URLs then move to `https://app.noctiv.io`.
- **Auto-deploy on push:** a GitHub Actions workflow runs on changes under `apps/site/**`. It builds and runs `wrangler pages deploy`, and needs the repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
  - Pushes to `main` deploy to production.
  - Other branches get preview URLs.
- **Token scopes needed:** Account › Cloudflare Pages: Edit; Zone › DNS: Edit (noctiv.io); Zone › Zone: Read.

## 6. Open items

1. **Cloudflare API token and account ID:** not in `.env` yet.
2. **Legal details for Privacy and Terms:** the legal entity name, address, company/VAT number and governing law. The texts should get a lawyer's review before launch.
3. **Copy vs. current setup** (content is approved; flagged so it stays true):
   - "Stored in the EU" / "a database in Frankfurt": the database is in Frankfurt, but the worker currently runs temporarily in London.
   - "Replies within minutes": the free AI tier is rate-limited. Fine once on the paid EU tier.
4. **Trial CTA:** the approved pricing button is `mailto:contact@noctiv.io`, while app sign-up is invite-only. Keep the mailto until self-serve sign-up opens.
5. **E-mail authentication:** add a DMARC record so Brevo counts noctiv.io as authenticated (for example `_dmarc TXT "v=DMARC1; p=none; rua=mailto:contact@noctiv.io"`). Without it, Brevo may rewrite the sender to its own domain; this likely explains the `brevosend.com` sender seen on the password-reset e-mail.

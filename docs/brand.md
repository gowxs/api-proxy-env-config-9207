# Noctiv brand

The brand kit lives in `packages/brand`. **The SVGs in `packages/brand/svg/` are the source of truth**; every icon and image is exported from them.

| Command                                             | What it does                                                                                                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @noctiv/brand svg`                   | Regenerates `svg/*.svg` from the geometry and Manrope 800 (`scripts/build-svg.ts`).                                                                             |
| `pnpm --filter @noctiv/brand export`                | Renders `exports/*` from the SVGs and copies them into the site and the app (`scripts/export.ts`).                                                              |
| `pnpm --filter @noctiv/brand preview`               | Review sheets of the mark and lockups on light and dark (`preview/`, not committed).                                                                            |
| `node --env-file=.env scripts/brand-auth-emails.ts` | Puts Supabase Auth's e-mails (sign-in link, confirmation, recovery…) in the brand shell. Idempotent; run it again after changing the shell or the header image. |

## The mark

A crescent moon that is also a reply bubble: "night" and "an answer" in one shape. It is pure geometry on a 32-unit grid: a disc, a bite taken out of its upper right by a second circle, rounded tips, and a short tail growing from the crescent's thick back towards the lower left.

- **Full mark** (with the tail): everywhere the mark is **24 px or larger**.
- **Small mark** (the crescent alone, no tail): favicons (16 and 32 px) and **anything under 24 px**. At that size the tail turns into a smudge; the crescent alone stays crisp.
- Never draw the mark by hand or rebuild it in another tool: use the files.

## Lockups

| Lockup     | Files                          | Use                                                       |
| ---------- | ------------------------------ | --------------------------------------------------------- |
| Horizontal | `svg/horizontal-<variant>.svg` | Default: site and app headers, e-mail header, footers.    |
| Stacked    | `svg/stacked-<variant>.svg`    | Square or centred layouts: splash screens, slides, print. |
| Mark only  | `svg/mark-<variant>.svg`       | App icons, avatars, where the name is already next to it. |
| Small mark | `svg/mark-small-<variant>.svg` | Under 24 px only (favicons).                              |

The wordmark is "Noctiv" in **Manrope ExtraBold (800)**, tracking −3%, converted to outlines. In the horizontal lockup the mark is 1.55× the cap height, centred on it, with a gap of 0.24× the mark; in the stacked lockup the mark is 2.4× the cap height above the word.

### Variants

| Variant      | Mark       | Wordmark   | On                                    |
| ------------ | ---------- | ---------- | ------------------------------------- |
| `on-light`   | Indigo     | Night navy | White, paper, light photos            |
| `on-dark`    | Dawn amber | Night text | Night navy, dark photos (hero, OG)    |
| `mono-dark`  | Night navy | Night navy | One-colour print, stamps, light fills |
| `mono-light` | White      | White      | Coloured or busy backgrounds          |

## Clear space and minimum size

- **Clear space:** keep at least **½ the mark's height** free on every side of a lockup (for the mark alone, ¼ of its size). Nothing — text, edges, other logos — inside it.
- **Minimum sizes:**
  - Horizontal lockup: **24 px tall** (about 96 px wide). Smaller than that, use the small mark on its own.
  - Stacked lockup: **64 px tall**.
  - Full mark: **24 px**. Small mark: **12 px**.
- App icons: the mark sits on a night-navy tile (rounded for "any" icons, full-bleed for maskable ones, inside the 80% safe circle).

## Colour

From the site's design tokens (`apps/site/src/styles/tokens.css`, mirrored in `packages/brand/src/tokens.ts`).

| Name       | Hex       | Role                                               |
| ---------- | --------- | -------------------------------------------------- |
| Night navy | `#0B1026` | Dark backgrounds, wordmark on light                |
| Night text | `#EEF1FA` | Wordmark and text on night                         |
| Indigo     | `#3B2FD0` | Mark on light, primary buttons, links              |
| Dawn amber | `#F6C89A` | Mark on dark; the only warm colour, used sparingly |
| Morning    | `#FDF3E4` | Palest dawn tone, backgrounds of "done" moments    |
| Paper      | `#F5F6FA` | Light page background                              |

Contrast (WCAG): indigo on paper 7.8:1, on white 8.4:1; night navy on paper 17.4:1; dawn amber on night 12.2:1; night text on night 16.7:1. All pass AAA for large elements.

## Typography

- **Manrope** (variable, OFL) everywhere: 800 for the wordmark and display headings, 700 for subheads, 400–600 for text.
- Headings are set tight (−2% to −4%); body text is never tracked.
- Figures that matter (times, prices) use tabular numbers.
- In e-mails, where web fonts are unreliable, the system UI font stands in; the header image carries the wordmark.

## Exports

| File                                             | Size                    | Where it is used                                                                                       |
| ------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `favicon.svg`                                    | 32 grid                 | Site, app (`app/icon.svg`). Small mark on a night tile.                                                |
| `favicon.ico`                                    | 16 + 32                 | Site, app. Small mark.                                                                                 |
| `apple-touch-icon.png`                           | 180                     | Site, app (`app/apple-icon.png`).                                                                      |
| `icon-192.png`, `icon-512.png`                   | 192, 512                | App manifest, purpose "any".                                                                           |
| `icon-maskable-192.png`, `icon-maskable-512.png` | 192, 512                | App manifest, purpose "maskable".                                                                      |
| `og.jpg`                                         | 1200×630                | Social previews (site and app): wordmark on the hero illustration.                                     |
| `email-header.png`                               | 1200×160 (shown 600×80) | Owner notifications and Supabase Auth e-mails, served from `https://noctiv.io/brand/email-header.png`. |
| `avatar-400.png`                                 | 400×400                 | Social profiles (`https://noctiv.io/brand/avatar-400.png`).                                            |

## Do

- Use the files as they are, in one of the four variants.
- Pick the variant by background: `on-light` on light, `on-dark` on night or dark photos.
- Give it its clear space; let it be the only logo in a header.
- Switch to the small mark under 24 px.

## Don't

- Don't recolour the mark outside the four variants, add gradients, outlines, shadows or glows.
- Don't stretch, rotate, mirror or skew it; don't move the tail or change the bite.
- Don't set "Noctiv" in another font or re-type it: use the outlined wordmark.
- Don't put the full-colour lockup on busy or mid-tone backgrounds (use `mono-light` or a night panel).
- Don't use the full mark below 24 px, or the tail-less mark above it.
- Don't combine the mark with other symbols (stars, the old crescent-and-dot favicon, emoji).

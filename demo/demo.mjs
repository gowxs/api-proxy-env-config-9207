/**
 * Product demo recording of the Noctiv web app (~2.5 minutes, 1280x720, no audio).
 *
 *   cd demo && npm install
 *   npm run demo                 # reads ../.env.local (NOCTIV_EMAIL, NOCTIV_PASSWORD)
 *
 * Run it on a TEST tenant. The script is read-only by construction: every request
 * that is not a GET (except the sign-in itself) is blocked in the browser, and it
 * never clicks Approve, Send, Reject, Issue, Mark paid or Create PDF. The reply-mode
 * scene only hovers the options and opens/cancels the confirmation dialog.
 *
 * Environment:
 *   APP_URL          default https://app.noctiv.io
 *   NOCTIV_EMAIL / NOCTIV_PASSWORD   the test account (never hardcode, never commit)
 *   DEV_LOGIN=1      rehearsal against the local dev stack (APP_URL=http://localhost:3000):
 *                    uses the "Sign in as the demo owner" button instead of the credentials
 *   PACE             1 = full length (default); 0.3 = quick rehearsal
 *   CHROMIUM_PATH    Chromium executable (default: the one in /opt/pw-browsers, else Playwright's)
 */
/* eslint-disable no-console -- the scene timestamps are the output */
/* global process, console, URL, document, NodeFilter, setInterval */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const APP_URL = (process.env.APP_URL || 'https://app.noctiv.io').replace(/\/$/, '');
const EMAIL = process.env.NOCTIV_EMAIL;
const PASSWORD = process.env.NOCTIV_PASSWORD;
const DEV_LOGIN = process.env.DEV_LOGIN === '1';
const PACE = Number(process.env.PACE || 1);
const OUT = path.resolve('output');

if (!DEV_LOGIN && (!EMAIL || !PASSWORD)) {
  console.error(
    'Set NOCTIV_EMAIL and NOCTIV_PASSWORD (../.env.local), or DEV_LOGIN=1 for the dev stack.',
  );
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
const SHOTS = path.join(OUT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = '/opt/pw-browsers';
  if (fs.existsSync(base)) {
    for (const d of fs
      .readdirSync(base)
      .filter((x) => /^chromium-\d+$/.test(x))
      .sort()
      .reverse()) {
      const p = path.join(base, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined; // Playwright's own download
}

const browser = await chromium.launch({ executablePath: chromiumPath() });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  locale: 'en-GB',
  recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
});

// Read-only guard: only GET/HEAD/OPTIONS go through, plus the sign-in itself.
const blocked = [];
await context.route('**/*', (route) => {
  const req = route.request();
  const method = req.method();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return route.continue();
  if (/\/auth\/v1\/|\/dev\/login/.test(req.url())) return route.continue();
  blocked.push(`${method} ${new URL(req.url()).pathname}`);
  return route.abort();
});

// A visible cursor: a soft red dot that grows a little while pressed.
await context.addInitScript(() => {
  const mount = () => {
    if (document.getElementById('demo-cursor')) return;
    const dot = document.createElement('div');
    dot.id = 'demo-cursor';
    dot.style.cssText =
      'position:fixed;z-index:2147483647;width:20px;height:20px;border-radius:50%;background:rgba(255,60,60,.6);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);pointer-events:none;transform:translate(-50%,-50%);transition:width .12s,height .12s;left:-60px;top:-60px';
    document.documentElement.appendChild(dot);
    document.addEventListener(
      'mousemove',
      (e) => {
        dot.style.left = e.clientX + 'px';
        dot.style.top = e.clientY + 'px';
      },
      true,
    );
    document.addEventListener(
      'mousedown',
      () => {
        dot.style.width = dot.style.height = '30px';
      },
      true,
    );
    document.addEventListener(
      'mouseup',
      () => {
        dot.style.width = dot.style.height = '20px';
      },
      true,
    );
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
});

// Redaction: signed links (quote accept links, tokens) and IBANs are blurred wherever they appear.
await context.addInitScript(() => {
  const RE =
    /(https?:\/\/\S*(?:\/q\/|\/a\/|token|access_token|apikey)\S*|\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b)/g;
  const redact = () => {
    if (!document.body) return;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const hits = [];
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.parentElement && n.parentElement.dataset.redacted) continue;
      RE.lastIndex = 0;
      if (RE.test(n.nodeValue || '')) hits.push(n);
    }
    for (const n of hits) {
      const frag = document.createDocumentFragment();
      let last = 0;
      const text = n.nodeValue || '';
      RE.lastIndex = 0;
      for (let m = RE.exec(text); m; m = RE.exec(text)) {
        frag.append(text.slice(last, m.index));
        const span = document.createElement('span');
        span.dataset.redacted = '1';
        span.style.filter = 'blur(7px)';
        span.style.userSelect = 'none';
        span.textContent = m[0];
        frag.append(span);
        last = m.index + m[0].length;
      }
      frag.append(text.slice(last));
      n.replaceWith(frag);
    }
  };
  setInterval(redact, 200);
});

const page = await context.newPage();
page.setDefaultTimeout(20_000);

// --- timing helpers -----------------------------------------------------------
const T0 = Date.now();
const elapsed = () => (Date.now() - T0) / 1000;
const mmss = (s) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const wait = (ms) => page.waitForTimeout(ms * PACE);
const timeline = [];

/** Starts a scene at its planned second (waits if early, reports if late). */
async function scene(atSec, name) {
  const target = atSec * PACE;
  const ahead = target - elapsed();
  if (ahead > 0) await page.waitForTimeout(ahead * 1000);
  const late = elapsed() - target;
  const t = elapsed();
  timeline.push({ t, name });
  console.log(
    `[${mmss(t)}] scene: ${name}   (${new Date().toISOString()}${late > 1.5 ? `, ${late.toFixed(1)}s late` : ''})`,
  );
}

// --- slow, deliberate mouse ---------------------------------------------------
let mx = 640;
let my = 360;
await page.mouse.move(mx, my);

async function glideTo(x, y) {
  const dist = Math.hypot(x - mx, y - my);
  const steps = Math.max(18, Math.min(70, Math.round(dist / 9)));
  const sx = mx;
  const sy = my;
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // ease in-out
    await page.mouse.move(sx + (x - sx) * e, sy + (y - sy) * e);
    await page.waitForTimeout(14 + 6 * PACE);
  }
  mx = x;
  my = y;
}
async function point(locator, { dx = 0.5, dy = 0.5 } = {}) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('not visible');
  await glideTo(box.x + box.width * dx, box.y + box.height * dy);
  return box;
}
async function click(locator) {
  await point(locator);
  await wait(350);
  await locator.click();
}
async function typeSlow(locator, text) {
  await click(locator);
  await locator.pressSequentially(text, { delay: 70 });
  await wait(300);
}
/** Scrolls the page smoothly by px (positive = down) with the wheel. */
async function scroll(px, ms = 1600) {
  const steps = Math.max(1, Math.round((ms * PACE) / 40));
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, px / steps);
    await page.waitForTimeout(40);
  }
}
const settle = async () => {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.mouse.move(mx, my); // keeps the cursor dot alive after a full page load
};
const nav = (label) =>
  page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: new RegExp(`^\\s*${label}\\b`) })
    .first();
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

const skipped = [];
const recorded = [];
async function tryStep(label, fn) {
  try {
    await fn();
    recorded.push(label);
  } catch (e) {
    skipped.push(`${label}: ${String(e.message).split('\n')[0]}`);
    console.log(`  (skipped: ${label}: ${String(e.message).split('\n')[0]})`);
  }
}

// =============================================================================
try {
  // ---- 0:00 Login ------------------------------------------------------------
  await scene(0, 'Login and sign in');
  await page.goto(`${APP_URL}/login`, { waitUntil: 'networkidle' });
  await settle();
  await wait(2200);
  if (DEV_LOGIN) {
    await click(page.getByRole('button', { name: /sign in as the demo owner/i }));
  } else {
    await typeSlow(page.getByLabel('Email'), EMAIL);
    await typeSlow(page.getByLabel('Password'), PASSWORD);
    await wait(500);
    await click(page.getByRole('button', { name: /^sign in$/i }));
  }
  await page.waitForURL(/\/home/, { timeout: 45_000 });
  await settle();
  await shot('00-login-done');

  // ---- 0:15 Dashboard --------------------------------------------------------
  await scene(15, 'Dashboard overview');
  await page.getByText('This month', { exact: true }).first().waitFor();
  await wait(1500);
  await tryStep('needs-you card', async () => {
    await point(page.getByText('Needs you', { exact: true }).first());
    await wait(1800);
    const rows = page
      .locator('a[href^="/conversations"], a[href^="/documents"]')
      .filter({ hasText: /draft|unpaid|answer/i });
    if (await rows.count()) {
      await point(rows.first());
      await wait(1500);
    }
  });
  await tryStep('this month card', async () => {
    await point(page.getByText('This month', { exact: true }).first());
    await wait(2200);
    await scroll(360, 1800);
    await wait(2500);
  });
  await shot('01-dashboard');

  // ---- 0:30 Incoming e-mail and the drafted reply ------------------------------
  await scene(30, 'Incoming e-mail and AI-drafted reply');
  await click(nav('Inbox'));
  await page.waitForURL(/\/conversations/);
  await settle();
  await wait(2200);
  await tryStep('open a conversation with a draft', async () => {
    const withDraft = page
      .locator('a[href^="/conversations/"]')
      .filter({ hasText: 'Draft to approve' })
      .first();
    const any = page.locator('ul a[href^="/conversations/"]').first();
    const row = (await withDraft.count()) ? withDraft : any;
    await point(row);
    await wait(1800);
    await row.click();
    await page.waitForURL(/\/conversations\/[0-9a-f-]{36}/);
    await settle();
    await wait(2500);
    // The customer's e-mail first, then the reply Noctiv drafted for it.
    const inbound = page.getByText(/^Summary:/).first();
    if (await inbound.count()) {
      await point(inbound, { dx: 0.3 });
      await wait(3500);
    }
    const draft = page.locator('[id^="draft-"]').first();
    if (await draft.count()) {
      await point(draft.locator('div.whitespace-pre-wrap').first(), { dx: 0.9, dy: 0.5 });
      await wait(4500);
      // Hover only, at the button's right edge: pressing it would send a real e-mail.
      const approve = draft.getByRole('button', { name: /approve and send/i });
      if (await approve.count()) {
        await point(approve, { dx: 0.92 });
        await wait(2500);
      }
    }
    await shot('02-draft');
  });

  // ---- 0:55 Reply modes ------------------------------------------------------
  await scene(55, 'The three reply modes (settings)');
  await click(nav('Settings'));
  await page.waitForURL(/\/settings/);
  await settle();
  await wait(1800);
  await tryStep('reply mode section', async () => {
    const heading = page.getByRole('heading', { name: 'Reply mode', exact: true });
    await heading.evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    await wait(1800);
    const radios = page.locator('fieldset input[type=radio][name=mode]');
    const labels = page.locator('fieldset label').filter({ has: page.locator('input[name=mode]') });
    if ((await labels.count()) !== 3) throw new Error('expected three modes');
    for (let i = 0; i < 3; i++) {
      await point(labels.nth(i), { dy: 0.4 });
      await wait(2900);
    }
    // Show the safety confirmation for a more automatic mode, then cancel. Never applies a mode.
    let current = 0;
    for (let i = 0; i < 3; i++) if (await radios.nth(i).isChecked()) current = i;
    if (current < 2) {
      await click(labels.nth(current + 1));
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      await wait(2800);
      const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
      await point(cancel);
      await wait(500);
      await cancel.click();
      await wait(1200);
      if (!(await radios.nth(current).isChecked())) throw new Error('mode changed unexpectedly');
    }
    await shot('03-modes');
  });

  // ---- 1:20 Knowledge base and mini-CRM ---------------------------------------
  await scene(80, 'Knowledge base and mini-CRM (leads)');
  await click(nav('Knowledge'));
  await page.waitForURL(/\/knowledge/);
  await settle();
  await wait(1000);
  await tryStep('knowledge sources', async () => {
    await point(page.getByText('Sources', { exact: true }).first());
    await wait(1600);
    await scroll(160, 900);
    await wait(1000);
    await shot('04-knowledge');
  });
  await click(nav('Leads'));
  await page.waitForURL(/\/leads/);
  await settle();
  await wait(1000);
  await tryStep('leads list and stage filters', async () => {
    // Rows stay closed: an open row shows notes and billing details.
    const rows = page.locator('ul > li > button');
    await rows.first().waitFor();
    await point(rows.first());
    await wait(1600);
    const chips = page
      .locator('button.rounded-full')
      .filter({ hasText: /^(All|New|Draft ready|Answered|Quoted)/ });
    const n = await chips.count();
    for (const i of [2, 3].filter((i) => i < n)) {
      await click(chips.nth(i));
      await wait(1200);
    }
    if (n) {
      await click(chips.first());
      await wait(500);
    }
    await shot('05-leads');
  });

  // ---- 1:40 A quote ---------------------------------------------------------
  await scene(100, 'A quote');
  await click(nav('Quotes'));
  await page.waitForURL(/\/quotes/);
  await settle();
  await wait(1200);
  await tryStep('open a quote', async () => {
    const q = page.locator('a[href^="/conversations/"]').first();
    await point(q);
    await wait(900);
    await q.click();
    await page.waitForURL(/\/conversations\/[0-9a-f-]{36}/);
    await settle();
    await wait(1500);
    // The quote block: lines, VAT and total (the PDF itself goes out as an e-mail attachment).
    const block = page.getByText(/^Quote Q-/).first();
    await block.evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    await wait(1200);
    await point(page.getByText('Total', { exact: true }).first(), { dx: 0.6 });
    await wait(3600);
    await shot('06-quote');
  });

  // ---- 1:55 Documents ---------------------------------------------------------
  await scene(115, 'Documents (invoice, delivery note, CMR)');
  await click(nav('Documents'));
  await page.waitForURL(/\/documents/);
  await settle();
  await wait(1000);
  for (const tab of ['Invoices', 'Delivery notes', 'CMR']) {
    await tryStep(`documents tab: ${tab}`, async () => {
      const t = page.getByRole('tab', { name: tab, exact: true });
      if (!(await t.count())) throw new Error('no such tab (nothing of this kind yet)');
      await click(t);
      await wait(1100);
    });
  }
  await tryStep('open a document', async () => {
    await click(page.getByRole('tab', { name: 'Invoices', exact: true }));
    await wait(600);
    const d = page.locator('a[href^="/documents/"]').first();
    await point(d);
    await wait(800);
    await d.click();
    await page.waitForURL(/\/documents\/[0-9a-f-]{36}/);
    await settle();
    await wait(1800);
    await scroll(200, 900);
    await wait(1400);
    await shot('07-document');
  });

  // ---- 2:10 Back to the dashboard, end ------------------------------------------
  await scene(130, 'Back to the dashboard, end');
  await click(nav('Home'));
  await page.waitForURL(/\/home/);
  await settle();
  await wait(2000);
  await glideTo(900, 260);
  await wait(2500);
  await scroll(300, 1800);
  await wait(2000);
  await scroll(-300, 1400);
  await shot('08-end');
  await scene(148, 'End');
} finally {
  const video = page.video();
  await context.close();
  const file = video ? await video.path() : null;
  if (file) {
    const webm = path.join(OUT, 'noctiv-demo.webm');
    fs.renameSync(file, webm);
    console.log(`Saved ${path.relative(process.cwd(), webm)}  (${mmss(elapsed())} recorded)`);
    // MP4 without an audio track (-an), H.264, playable everywhere.
    const mp4 = path.join(OUT, 'noctiv-demo.mp4');
    const r = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-i',
        webm,
        '-an',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        '20',
        '-preset',
        'slow',
        '-movflags',
        '+faststart',
        mp4,
      ],
      { stdio: 'inherit' },
    );
    console.log(
      r.status === 0
        ? `Saved ${path.relative(process.cwd(), mp4)}`
        : 'ffmpeg failed (is it installed?)',
    );
  }
  await browser.close();
  console.log('\nScene timestamps (for the voiceover):');
  for (const s of timeline) console.log(`  ${mmss(s.t)}  ${s.name}`);
  if (skipped.length) console.log('\nSkipped:\n  ' + skipped.join('\n  '));
  console.log(
    `\nBlocked write requests (read-only guard): ${blocked.length}${blocked.length ? '\n  ' + [...new Set(blocked)].join('\n  ') : ''}`,
  );
}

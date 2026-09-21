#!/usr/bin/env node
/**
 * ux-probe driver — one long-running process per session.
 *
 * A tiny HTTP API in front of a persistent Playwright browser context, so a
 * client that knows NOTHING about this codebase can "look at" a running web
 * app and interact with it the way a first-time visitor would: read the
 * visible text, see the interactive things a real user sees, click/fill/type,
 * navigate, and inspect a running journal of what happened.
 *
 * DESIGN CONSTRAINTS (deliberate — see tools/ux-probe/README.md):
 *   - NO knowledge of any particular application. There is not a single
 *     application-specific selector in this file: elements are discovered by
 *     generic HTML tag + ARIA role and labelled by their accessible name, so
 *     what the client sees is what a real user sees, not implementation
 *     detail.
 *   - Handles (`ref`) are STABLE across snapshots where the page is: a ref is
 *     a hash of (role, accessible name, occurrence-ordinal in DOM order), not
 *     a positional index, so the same button keeps the same ref even when
 *     other elements appear/disappear around it.
 *   - The page is kept open for the life of the process (persistent context),
 *     and one screenshot is written per step into the session directory as
 *     evidence.
 *   - It reports what IS, including errors and empty states — it never
 *     "helpfully" hides a broken screen.
 *
 * Usage:
 *   node tools/ux-probe/driver.mjs \
 *     --port 4001 --web-url http://localhost:3001 \
 *     --session-id ux-agent-1 --session-dir tools/ux-probe/.sessions/ux-agent-1
 *
 * Endpoints (full contract in README.md):
 *   GET  /health
 *   GET  /snapshot
 *   POST /act         { kind: 'click'|'fill'|'goto'|'back'|'press', ref?, value?, url? }
 *   GET  /journal
 */
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[name] = true;
    } else {
      out[name] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port ?? process.env.UX_DRIVER_PORT ?? 4001);
const webUrl = String(args['web-url'] ?? process.env.UX_WEB_URL ?? 'http://localhost:3001');
const sessionId = String(args['session-id'] ?? process.env.UX_SESSION_ID ?? `session-${port}`);
const sessionDir = resolve(
  String(args['session-dir'] ?? process.env.UX_SESSION_DIR ?? resolve(process.cwd(), '.sessions', sessionId)),
);
const headed = args.headed === true || process.env.UX_HEADED === '1';
const navTimeoutMs = Number(args['nav-timeout'] ?? process.env.UX_NAV_TIMEOUT_MS ?? 30_000);
// Click/fill/press should fail fast when a `ref` is stale or not actionable,
// rather than making an agent wait the full navigation timeout for a control
// that clearly isn't there.
const actionTimeoutMs = Number(args['action-timeout'] ?? process.env.UX_ACTION_TIMEOUT_MS ?? 8_000);

mkdirSync(sessionDir, { recursive: true });

// ---------------------------------------------------------------------------
// Browser-side extraction helpers (executed inside the page)
//
// These are stringified into page.evaluate, so they must be fully
// self-contained (no closures over driver state) and use only browser APIs.
// ---------------------------------------------------------------------------

/** Interactive ARIA roles a first-time visitor can actually act on. */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'checkbox',
  'radio',
  'switch',
  'combobox',
  'listbox',
  'textbox',
  'searchbox',
  'slider',
  'spinbutton',
  'treeitem',
]);

/**
 * Collects the interactive elements the user can see, each with a stable
 * `ref` derived from (role, accessible name, occurrence ordinal). Elements
 * are also tagged in the DOM with `data-uxprobe-ref` so `/act` can resolve a
 * ref to an exact element without guessing.
 */
function collectInteractive(interactiveRoles) {
  const roleSet = new Set(interactiveRoles);

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  function roleOf(el) {
    const explicit = (el.getAttribute('role') || '').trim().toLowerCase();
    if (explicit) return roleSet.has(explicit) ? explicit : null;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'hidden') return null;
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    return null;
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    if (el.hasAttribute('hidden')) return false;
    const style = window.getComputedStyle(el);
    if (!style) return false;
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  function clean(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function labelOf(el, role) {
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const joined = labelledby
        .split(/\s+/)
        .map((id) => {
          const node = document.getElementById(id);
          return node ? node.innerText || node.textContent || '' : '';
        })
        .join(' ');
      const cleaned = clean(joined);
      if (cleaned) return cleaned;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const labels = el.labels ? Array.from(el.labels) : [];
      const labelText = clean(labels.map((l) => l.innerText || l.textContent || '').join(' '));
      if (labelText) return labelText;
      const placeholder = clean(el.getAttribute('placeholder'));
      if (placeholder) return placeholder;
      const title = clean(el.getAttribute('title'));
      if (title) return title;
      const name = clean(el.getAttribute('name'));
      if (name) return name;
      if (role === 'button') {
        const value = clean(el.getAttribute('value'));
        if (value) return value;
      }
      return '';
    }
    const text = clean(el.innerText || el.textContent || '');
    if (text) return text;
    const title = clean(el.getAttribute('title'));
    if (title) return title;
    const alt = clean(el.getAttribute('alt'));
    if (alt) return alt;
    const value = clean(el.getAttribute('value'));
    if (value) return value;
    return '';
  }

  const SELECTOR = 'a[href], button, input, select, textarea, [role], [contenteditable="true"]';
  const nodes = Array.from(document.querySelectorAll(SELECTOR));
  const counters = new Map();
  const out = [];
  const usedRefs = new Set();

  for (const el of nodes) {
    const role = roleOf(el);
    if (!role) continue;
    if (!isVisible(el)) continue;
    const label = labelOf(el, role);
    const key = role + '|' + label;
    const ordinal = counters.get(key) ?? 0;
    counters.set(key, ordinal + 1);
    let ref = 'e' + fnv1a(key + '|' + ordinal);
    // Vanishingly unlikely, but never hand out a duplicate ref to two
    // live elements in one snapshot.
    let bump = ordinal;
    while (usedRefs.has(ref)) {
      bump += 1;
      ref = 'e' + fnv1a(key + '|' + bump);
    }
    usedRefs.add(ref);
    el.setAttribute('data-uxprobe-ref', ref);

    const tag = el.tagName.toLowerCase();
    const isField = tag === 'input' || tag === 'select' || tag === 'textarea';
    const item = { ref, kind: role, label };
    if (isField) {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      let value;
      if (type === 'checkbox' || type === 'radio') value = el.checked ? 'true' : 'false';
      else value = String(el.value ?? '');
      if (value.length > 300) value = value.slice(0, 300);
      item.value = value;
    }
    item.disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
    if (tag === 'a') {
      const href = el.getAttribute('href');
      if (href) item.href = href;
    }
    out.push(item);
  }
  return out;
}

/** The trimmed, human-readable text a visitor would actually read. */
function collectVisibleText() {
  if (!document.body) return '';
  const raw = document.body.innerText || '';
  const lines = raw.split('\n').map((line) => line.replace(/\s+/g, ' ').trim());
  const kept = [];
  for (const line of lines) {
    if (line === '' && kept.length > 0 && kept[kept.length - 1] === '') continue;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

/**
 * Best-effort extraction of "error-looking" text the user can see. Generic
 * heuristics only (ARIA live regions, alert roles, and class-name hints) —
 * never an app-specific selector.
 */
function collectErrorText() {
  const parts = [];
  const push = (text) => {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (t) parts.push(t);
  };
  const visible = (el) => {
    if (!el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return !(rect.width === 0 && rect.height === 0);
  };
  for (const sel of ['[role="alert"]', '[aria-live="assertive"]', '[aria-live="polite"]', '[data-error]']) {
    document.querySelectorAll(sel).forEach((el) => {
      if (visible(el)) push(el.innerText || el.textContent);
    });
  }
  [
    '[class*="error" i]:not(:has([class*="error" i]))',
    '[class*="danger" i]:not(:has([class*="danger" i]))',
    '[class*="invalid" i]:not(:has([class*="invalid" i]))',
  ].forEach((sel) => {
    document.querySelectorAll(sel).forEach((el) => {
      if (!visible(el)) return;
      const t = String(el.innerText || '').replace(/\s+/g, ' ').trim();
      if (t.length > 0 && t.length < 400) push(t);
    });
  });
  const unique = Array.from(new Set(parts));
  return unique.join(' | ').slice(0, 1200);
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------
const journal = {
  sessionId,
  webUrl,
  startedAt: new Date().toISOString(),
  steps: [],
};
let stepIndex = 0;
let ready = false;
let lastSnapshot = null;

/** Per-step browser-event buffers, drained into the journal after each step. */
let consoleErrors = [];
let pageErrors = [];
let failedRequests = [];

let context = null;
let page = null;

function screenshotPath(index, kind) {
  const name = `step-${String(index).padStart(3, '0')}-${kind}.png`;
  return resolve(sessionDir, name);
}

async function takeScreenshot(index, kind) {
  if (!page) return null;
  const file = screenshotPath(index, kind);
  try {
    await page.screenshot({ path: file, fullPage: true });
  } catch {
    try {
      await page.screenshot({ path: file });
    } catch {
      return null;
    }
  }
  return file;
}

/**
 * Waits until the page's visible text has stopped changing for a couple of
 * consecutive samples (or a cap). A client-rendered screen often shows a
 * loading state first and swaps in its data after hydration; the text length
 * changing is a generic, app-agnostic signal that "content is still arriving".
 * The ticking world clock perturbs the text only once a second, so two
 * consecutive 250ms samples still read as stable between ticks.
 */
async function waitForStableText(page, { intervalMs = 250, stableSamples = 2, capMs = 6_000 } = {}) {
  const deadline = Date.now() + capMs;
  let lastLength = -1;
  let sameCount = 0;
  while (Date.now() < deadline) {
    const length = await page
      .evaluate(() => (document.body ? (document.body.innerText || '').length : 0))
      .catch(() => -1);
    if (length === lastLength && length !== -1) {
      sameCount += 1;
      if (sameCount >= stableSamples) return;
    } else {
      sameCount = 0;
      lastLength = length;
    }
    await page.waitForTimeout(intervalMs);
  }
}

async function settle() {
  if (!page) return;
  // A lead-in pause first: client-side routing (Next's App Router, React
  // Router, etc.) kicks off its data fetch a tick AFTER the click is
  // dispatched. Calling waitForLoadState('networkidle') immediately can see a
  // momentarily quiet network and return before that fetch has even started,
  // which made a snapshot describe the previous page. Letting the action's
  // effects begin first, then waiting for quiet, then settling once more,
  // keeps every snapshot describing the page the action actually landed on.
  await page.waitForTimeout(350);
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 });
  } catch {
    /* the page may already be past this state */
  }
  try {
    await page.waitForLoadState('networkidle', { timeout: 5_000 });
  } catch {
    /* long-polling / continuous requests never go idle; don't hang on it */
  }
  // Some screens fetch their data in a mount effect that only STARTS after
  // the route's own navigation fetch finishes, so the first idle window can
  // close before the second fetch begins. A short gap followed by a second
  // idle wait catches that chained fetch (it is how a listing page's rows
  // appear), so the snapshot describes loaded content, not a skeleton.
  await page.waitForTimeout(600);
  try {
    await page.waitForLoadState('networkidle', { timeout: 5_000 });
  } catch {
    /* as above */
  }
  // Finally, wait for the rendered text to stop changing. This is what lets a
  // first visit to a route (whose JS/route chunk may still be compiling in
  // dev, and whose data arrives after hydration) settle on the loaded screen
  // rather than snapshot a loading placeholder.
  await waitForStableText(page);
  await page.waitForTimeout(200);
}

async function snapshotBody() {
  if (!page) throw new Error('browser page is not ready');
  const [title, url, elements, visibleText, errorText] = await Promise.all([
    page.title().catch(() => ''),
    Promise.resolve(page.url()),
    page.evaluate(collectInteractive, [...INTERACTIVE_ROLES]),
    page.evaluate(collectVisibleText),
    page.evaluate(collectErrorText),
  ]);
  return { url, title, visibleText, elements, errorText };
}

/** Wraps one action: clears event buffers, runs it, settles, records a step. */
async function performStep(action) {
  const index = ++stepIndex;
  consoleErrors = [];
  pageErrors = [];
  failedRequests = [];
  let error = null;
  try {
    // Re-tag the current DOM before acting on a ref. The `data-uxprobe-ref`
    // attribute is injected during snapshot, but a client-side re-render
    // (clock ticks, live data) can replace elements and drop it. Re-running
    // the same role/name-based collection assigns the SAME deterministic ref
    // to the SAME visible control, so a ref from a prior snapshot stays
    // resolvable without the agent re-fetching — and the click lands on the
    // freshly-rendered element, not a detached one.
    if (action.ref && (action.kind === 'click' || action.kind === 'fill' || action.kind === 'press')) {
      await page.evaluate(collectInteractive, [...INTERACTIVE_ROLES]);
      await page.waitForTimeout(150);
    }
    if (action.kind === 'goto') {
      const target = new URL(action.url ?? '/', webUrl).toString();
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
    } else if (action.kind === 'back') {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
    } else if (action.kind === 'click') {
      if (!action.ref) throw new Error('click requires a `ref`');
      // Dispatch the click on the freshly re-tagged element directly rather
      // than going through coordinate-based actionability. In a UI where a
      // transient modal/overlay is still fading out over the page, a
      // coordinate click can land on the overlay or on a node React is about
      // to replace; a direct DOM `click()` (which React's root listener still
      // receives, since the event bubbles) reliably reaches the intended
      // control. A missing ref is reported immediately, not after a timeout.
      const clicked = await page.evaluate((ref) => {
        const el = document.querySelector(`[data-uxprobe-ref="${ref}"]`);
        if (!el) return false;
        if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'center' });
        el.click();
        return true;
      }, action.ref);
      if (!clicked) throw new Error(`no element with ref "${action.ref}" is currently present`);
    } else if (action.kind === 'fill') {
      if (!action.ref) throw new Error('fill requires a `ref`');
      if (action.value === undefined) throw new Error('fill requires a `value`');
      await page.locator(`[data-uxprobe-ref="${action.ref}"]`).first().fill(String(action.value), { timeout: actionTimeoutMs });
    } else if (action.kind === 'press') {
      if (action.value === undefined) throw new Error('press requires a `value` (a key name, e.g. "Enter")');
      if (action.ref) {
        await page.locator(`[data-uxprobe-ref="${action.ref}"]`).first().press(String(action.value), { timeout: actionTimeoutMs });
      } else {
        await page.keyboard.press(String(action.value));
      }
    } else {
      throw new Error(`unknown action kind "${action.kind}"`);
    }
    await settle();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    await settle().catch(() => {});
  }

  const body = error && !page
    ? { url: '', title: '', visibleText: '', elements: [], errorText: '' }
    : await snapshotBody().catch((caught) => ({
        url: page ? page.url() : '',
        title: '',
        visibleText: '',
        elements: [],
        errorText: caught instanceof Error ? caught.message : String(caught),
      }));

  const screenshot = await takeScreenshot(index, action.kind);
  const step = {
    index,
    at: new Date().toISOString(),
    action,
    resultUrl: body.url,
    title: body.title,
    error,
    errorText: body.errorText,
    consoleErrors: [...consoleErrors],
    pageErrors: [...pageErrors],
    failedRequests: [...failedRequests],
    screenshot: screenshot ? screenshot.split(/[\\/]/).pop() : null,
  };
  journal.steps.push(step);
  lastSnapshot = { ...body, step: index, error };
  return lastSnapshot;
}

// ---------------------------------------------------------------------------
// Browser lifecycle
// ---------------------------------------------------------------------------
async function initBrowser() {
  const userDataDir = resolve(sessionDir, 'browser-profile');
  mkdirSync(userDataDir, { recursive: true });
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: !headed,
    viewport: { width: 1440, height: 900 },
    args: ['--no-sandbox'],
  });
  page = context.pages()[0] ?? (await context.newPage());

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err && err.message ? err.message : String(err));
  });
  page.on('requestfailed', (request) => {
    failedRequests.push({
      url: request.url(),
      method: request.method(),
      failure: request.failure() ? request.failure().errorText : 'unknown',
    });
  });

  // Initial navigation — step 0, so the journal always begins with the page
  // the client asked for, even before any /act call.
  consoleErrors = [];
  pageErrors = [];
  failedRequests = [];
  let initialError = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await page.goto(webUrl, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
      initialError = null;
      break;
    } catch (caught) {
      initialError = caught instanceof Error ? caught.message : String(caught);
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  await settle();
  const body = await snapshotBody().catch(() => ({ url: webUrl, title: '', visibleText: '', elements: [], errorText: '' }));
  const screenshot = await takeScreenshot(0, 'initial');
  journal.steps.push({
    index: 0,
    at: new Date().toISOString(),
    action: { kind: 'goto', url: webUrl },
    resultUrl: body.url,
    title: body.title,
    error: initialError,
    errorText: body.errorText,
    consoleErrors: [...consoleErrors],
    pageErrors: [...pageErrors],
    failedRequests: [...failedRequests],
    screenshot: screenshot ? screenshot.split(/[\\/]/).pop() : null,
  });
  lastSnapshot = { ...body, step: 0 };
  ready = true;
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) reject(new Error('request body too large'));
    });
    req.on('end', () => {
      if (!raw) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === 'GET /health') {
      return sendJson(res, 200, {
        status: 'ok',
        ready,
        sessionId,
        webUrl,
        driverUrl: `http://localhost:${port}`,
        currentUrl: page ? page.url() : null,
        stepCount: journal.steps.length,
      });
    }
    if (!ready) {
      return sendJson(res, 503, { error: 'browser session is still starting' });
    }
    if (route === 'GET /snapshot') {
      const body = await snapshotBody();
      return sendJson(res, 200, { ...body });
    }
    if (route === 'POST /act') {
      const action = await readBody(req);
      if (!action || typeof action.kind !== 'string') {
        return sendJson(res, 400, { error: 'body must be JSON with a string `kind`' });
      }
      const result = await performStep(action);
      return sendJson(res, 200, result);
    }
    if (route === 'GET /journal') {
      return sendJson(res, 200, journal);
    }
    return sendJson(res, 404, { error: `no route for ${route}` });
  } catch (caught) {
    return sendJson(res, 500, { error: caught instanceof Error ? caught.message : String(caught) });
  }
});

async function shutdown() {
  try {
    if (context) await context.close();
  } catch {
    /* best effort */
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(port, '127.0.0.1', async () => {
  // eslint-disable-next-line no-console
  console.log(`[ux-probe] ${sessionId}: HTTP on http://localhost:${port}, web=${webUrl}, sessionDir=${sessionDir}`);
  try {
    await initBrowser();
    // eslint-disable-next-line no-console
    console.log(`[ux-probe] ${sessionId}: ready (${journal.steps.length} initial step(s))`);
  } catch (caught) {
    // eslint-disable-next-line no-console
    console.error(`[ux-probe] ${sessionId}: failed to start browser:`, caught);
    ready = false;
  }
});

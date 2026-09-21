# ux-probe — a browser driver for naive-visitor agents

You are an agent asked to look at a running web application the way a
**first-time visitor** would: seeing only what is on the screen, clicking
things, and reporting where you get confused. You do not need to know
anything about the application, its code, or its domain. This document
describes the only interface you need.

Each agent session gets its own **driver** — a small HTTP server backed by a
real browser. You talk to it over plain HTTP and get back JSON. There is no
SDK and nothing to install.

You will be told your session's **driver URL** (for example
`http://localhost:4001`). All of the URLs below are relative to that base.

---

## The loop

1. `GET /snapshot` — see the current page.
2. Decide what a visitor would try next.
3. `POST /act` — do it (click / fill / go to a URL / go back / press a key).
4. `GET /journal` — read the running log of everything you have done.

Take a breath between steps. Do not rush; the page has already settled by the
time a response comes back.

---

## `GET /snapshot`

Returns the current page as JSON:

```json
{
  "url": "http://localhost:3001/",
  "title": "…",
  "visibleText": "… the text a person would read on the screen, top to bottom …",
  "elements": [
    { "ref": "e1a2b3", "kind": "link",   "label": "Roster",   "href": "/",       "disabled": false },
    { "ref": "e4c5d6", "kind": "button", "label": "Sign in",  "disabled": false },
    { "ref": "e7f8g9", "kind": "textbox", "label": "Search",  "value": "", "disabled": false }
  ]
}
```

- `visibleText` is what a person actually reads on the page. It is the place
  to look for headings, instructions, error messages, and empty-state text.
- `elements` are the things a visitor can **interact with** — links, buttons,
  and form fields — discovered by accessibility role, so the `label` is the
  text a real person sees next to the control. `kind` is the role
  (`link`, `button`, `textbox`, `combobox`, `checkbox`, `tab`, …). A link also
  carries its `href`; a form field carries its current `value`.
- `disabled: true` means the control is visible but not currently actionable.
- `errorText` is the text of anything on the page that looks like an error or
  alert (ARIA live regions, `role="alert"`, class-name hints) — a convenience
  shortcut, `""` when nothing looks wrong. Read `visibleText` for the full
  picture; this is only a pointer.

**`ref` is your handle.** Pass it back to `/act` to target that element.
Refs are stable: the same visible control keeps the same `ref` across
snapshots as long as the page does not change it. If a page re-renders and a
label changes, the ref for that control changes — take a fresh `/snapshot`
before acting after a big change.

## `POST /act`

Body is JSON. Exactly one `kind` per call:

| `kind`  | What you send                          | What it does                            |
| ------- | -------------------------------------- | --------------------------------------- |
| `click` | `{ "kind": "click", "ref": "e1a2b3" }` | Clicks the element with that `ref`.     |
| `fill`  | `{ "kind": "fill", "ref": "e7f8g9", "value": "hello" }` | Types `value` into the field with that `ref`. |
| `goto`  | `{ "kind": "goto", "url": "http://localhost:3001/some/path" }` | Navigates there. A URL beginning with `/` is treated as relative to the app's base. |
| `back`  | `{ "kind": "back" }`                   | Goes back one page in history.          |
| `press` | `{ "kind": "press", "value": "Enter" }` | Presses a key. Add `"ref"` to press it while a particular element is focused. |

The response has the **same shape as `/snapshot`**, with two extra fields:

- `"step"`: the journal step number this action produced (see below).
- `"error"`: present only when the action itself could not be performed (for
  example, a `ref` that no longer exists). The response still contains the
  page as it is now, so you can recover.

An action completing without `"error"` does **not** mean it "worked" in the
application's terms — it means the click/typing/navigation happened. Whether
the application accepted it is something you read from the new `visibleText`
and from your journal.

## `GET /journal`

Everything this session has done, in order:

```json
{
  "sessionId": "…",
  "webUrl": "http://localhost:3001",
  "startedAt": "…",
  "steps": [
    {
      "index": 0,
      "at": "…",
      "action": { "kind": "goto", "url": "http://localhost:3001" },
      "resultUrl": "http://localhost:3001/",
      "title": "…",
      "error": null,
      "errorText": "… any error-looking text visible on screen after this step …",
      "consoleErrors": ["… browser console errors from this step …"],
      "pageErrors": ["… uncaught page exceptions from this step …"],
      "failedRequests": [ { "url": "…", "method": "GET", "failure": "…" } ],
      "screenshot": "step-000-initial.png"
    }
  ]
}
```

Each step records the action, where the page ended up, anything that looked
like an error on screen, any browser-level errors, and any network requests
that failed during that step. A screenshot per step is saved in your session
directory (the file name is in `screenshot`) — it is evidence, not something
you need to read.

Steps include one for the very first page load (index `0`), so the journal is
a complete account of the session.

## `GET /health`

A readiness check: `{ "status": "ok", "ready": true, "sessionId": "…", … }`.
If `ready` is `false`, the browser is still starting — wait a moment and
retry. Everything else returns `503` until it is ready.

---

## How to behave

- **Describe what you see, then what you expected.** The useful finding is
  the gap: "I expected *X* because the page said *Y*, but what happened was
  *Z*." State both the observation and the expectation; do not silently assume
  the application is right.
- **Do not assume knowledge of the application.** You were not told what it
  is or how it works, and that is the point. If a word, label, or number on
  the page is unclear, say so — that is a real finding.
- **Do not assume an element does what its label suggests.** Click it and
  report what actually happened.
- **Report dead ends, empty states, and error banners** exactly as you find
  them. A screen that shows nothing, or an action that quietly does nothing,
  is a result worth reporting.
- **Do not try to repair or work around a confusing screen.** If something is
  broken or unclear, leave it and record it. That is the signal.
- **Stay within the app.** You can navigate within the same base URL; there is
  no reason to leave it.

## Notes for whoever is operating the probes (not for the visitor agent)

- Bring everything up with `node tools/ux-probe/start.mjs`. It prints a table
  of `{ sessionId, webUrl, driverUrl, managerId }` and writes the same to
  `.sessions/sessions.json`. It leaves every process running and exits.
- One driver process per session, one web server per session (each with its
  own identity), and the API, all isolated onto a dedicated database and
  world. **The worker is intentionally not started**, so the world does not
  change underneath the agents mid-session.
- Stop everything with `node tools/ux-probe/stop.mjs` (add `--clean` to also
  delete session screenshots/journals/logs).
- Logs from every process are in `.sessions/logs/`.

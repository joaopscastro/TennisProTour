# UI direction prototypes

Two static, side-by-side visual directions for the Tennis Pro Tour UI, so the
owner can compare looks before committing to one.

These are **throwaway design artefacts**. They are **not part of the app
build**, are not imported by `apps/`, `packages/`, or any TypeScript, and are
not deployed. Nothing here should be treated as a source of truth for
behaviour — the real product rules live in the app.

## Files

| File | What it is |
|---|---|
| `index.html` | A simple chooser linking both prototypes with a short description of each. |
| `a-broadcast-telemetry.html` | **Direction A — Broadcast Sports Telemetry.** Dark broadcast-booth look: dense squad tables, segmented stat bars, horizontal bracket, one court-lime accent. Saira Condensed / IBM Plex Mono / Inter. |
| `c-terminal.html` | **Direction C — 90s Management Terminal.** Monospace terminal: box-drawn panels, ASCII bars, bracketed tokens, hotkey tabs, amber-on-black. IBM Plex Mono only. |

Both prototypes render the **same two screens** — **ROSTER** and **TOURNAMENT
(BRACKET)** — with the **same invented dataset**, so the comparison is fair.
The dataset is fictional but shaped to match the real DTOs.

## How to open them

Double-click any of the `.html` files, or open them from a browser:

```
design/prototypes/index.html
design/prototypes/a-broadcast-telemetry.html
design/prototypes/c-terminal.html
```

Each file is fully self-contained: all CSS is inline in a `<style>` block, the
only external request is an optional Google Fonts `@import` (with local font
fallbacks, so they still look right offline). There is **no build step, no
npm, no bundler, no app imports**.

Each prototype has a tiny inline `<script>` only for switching between the two
screens. If scripting is disabled, both screens render stacked.

## Product rules both prototypes honour

These are real product rules, not styling choices:

- A rank always names its ladder — `SENIOR #87`, `U16 #34`, `U16 NR`, never a
  bare number.
- Junior prize money is `$0` — shown as "amateur circuit — no prize money",
  never blank.
- "No points" is not "no prize": a first-round loss shows no points but still
  shows prize money.
- A decided match that has not yet aired shows `LIVE` / `STARTS IN 3:12` and
  **no score**, and is not styled as a link; an aired match shows the score.
- `[Q]` and `[WC]` are plain bracketed tokens, never emoji.
- Surface colour encodes the four surfaces only (clay / grass / hard /
  indoor) — it is never a page background.

## Not included

No emoji anywhere. Icons are inline SVG (Direction A) or typographic glyphs
(Direction C); flags are small inline SVG (Direction A) or boxed 3-letter
codes (Direction C).

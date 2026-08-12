# UI direction v2 — from admin panel to game

**Supersedes `docs/ui-direction.md`'s aesthetic guidance.** Its
*conventions* (flags, tennis scoreline notation, surface colors, rank
prominence, honest "Premiere" language) remain correct and stay. Its
*aesthetic* — flat, muted, data-forward, deliberately non-illustrated —
was wrong for a game and produced a SaaS admin panel.

## Diagnosis

Current screens are correct and inert. Every interaction is a form
submission against a data table. There is no sense of place, no
consequence, no celebration, no motion, no texture. A title win adds a
row. A rank change is a static number. The product reads as tooling for
managing tennis data rather than a world you inhabit.

## The five things missing

### 1. Presence — the world needs a place, not a nav sidebar
- A real header/hero identity per screen, not a page title in grey.
- Depth: panels that read as objects — borders, layered surfaces,
  shadow, texture — rather than text floating on off-white.
- Surface colors used as environment, not just badges: a clay
  tournament screen should *feel* like clay.
- The world clock treated as living chrome (as Rocking Rackets does),
  not a sidebar footnote.

### 2. Consequence — actions must visibly land
- Winning a title: a real moment (card reveal, trophy animation,
  interstitial) — never just a new list row.
- Ranking changes: animate the number moving, show +/− delta and
  position shift.
- Training applied on tick: show the attribute *gaining*, not a silently
  updated value.
- Claiming a prospect: a reveal, not a table row disappearing.

### 3. Feedback ("juice") — every interaction responds
- Numbers count up rather than snapping.
- Bars fill with easing; state changes transition rather than jump.
- Buttons have press states; async actions show real progress.
- Hover reveals depth (H2H record, recent form, why a stat matters).
- Nothing should ever change silently between renders.

### 4. Character — players must look like people, not rows
- **Avatars become prominent, not incidental** — the anime/illustrated
  direction I twice argued against was right. Larger, more expressive,
  present everywhere a player is named.
- Player cards, not player rows, wherever the player *is* the subject
  (scouting, profile, match). Tables are for comparison only.
- Copy with personality: "Vukovic is one win from her first title" beats
  "Round: Final".

### 5. Home — an inbox/world view, not a dashboard of systems
- Landing is what happened to *your* players (results, milestones,
  rivals, threats), not a roster table.
- This is GC-7 in the backlog; it is as much a feel problem as a
  feature.

## What stays from v1
Tennis conventions (flags, scorelines, surface colors, seeds, rank
prominence, net-line motif), honesty rules (never "live", never fake
precision, disclose tradeoffs), and information density where the job
genuinely is comparison (bracket, filters, planner).

## What is explicitly reversed
- "Flat, minimal, non-illustrated" → depth, texture, illustration.
- "Avoid looking like a game" → look like a game, without looking like
  a gacha mobile title.
- Avatars as small incidental thumbnails → avatars as identity.
- Static state changes → animated, celebrated state changes.

## Reference points
Aim between **Football Manager's** dense-but-atmospheric presentation
and **Blaseball/Sorare's** card-forward player identity — not Stripe,
not Linear, not Notion. If a screenshot could plausibly be a B2B
analytics product, it is wrong.

---

# Backlog additions (slot into `backlog-make-it-a-game.md`)

These are **P0**, alongside GC-1. The game being unplayable (GC-1) and
the game not feeling like a game (below) are the same severity.

### GC-14 · Visual identity pass (Claude Design)
**AC:**
- Redesign roster, scouting, tournament, profile, and match replay
  against this document — depth, texture, prominent illustrated
  avatars, environmental surface color, real hero areas.
- Produce a shared component language (panels, cards, buttons, badges)
  so screens stop being independently-styled tables.
- Every screen passes the test: *could this be a B2B SaaS screenshot?*
  If yes, iterate.

### GC-15 · Motion & feedback system (Claude Code)
**AC:**
- Shared animation primitives: count-up numbers, easing bars, state
  transitions, press feedback, skeleton→content reveals.
- Applied to: rank changes, XP balance changes, attribute gains after
  a tick, claim actions, match score updates during replay.
- No state change in the app happens without visible feedback.
- Respects `prefers-reduced-motion`.

### GC-16 · Celebration moments (Claude Code, after GC-14)
**AC:**
- Title win, first career title, ranking milestones (top 100/10/1),
  band graduation, and rare-prospect claim each produce a distinct
  celebratory moment — not a list entry.
- Each is shareable (ties to GC-12).
- Triggered from existing domain events (`TournamentCompleted`, peak
  ranking updates, graduation) — no new backend concepts.

### GC-17 · Player cards replace player rows
**AC:**
- Scouting, profile header, and match replay present players as cards
  with prominent avatar, archetype (GC-10), form, and H2H (GC-6).
- Tables retained only where comparison is the actual job (bracket,
  rankings, planner).

---

## Revised P0 order

1. **GC-1** — cold-start deadlock (unplayable otherwise)
2. **GC-14** — visual identity pass (Design; runs in parallel with code work)
3. **GC-2** — verify surface weighting landed
4. **GC-3** — post-match causality
5. **GC-15** — motion & feedback
6. **GC-4** — first-session flow (needs 14/15/3 to land well)
7. **GC-16 / GC-17** — celebration + player cards
8. **GC-5** — probability tuning

Everything in P1/P2 and the freeze list is unchanged.

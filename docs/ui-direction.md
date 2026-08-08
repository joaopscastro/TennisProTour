# UI direction — Grand Circuit

Final, agreed direction from four Claude Design rounds (roster, bracket,
match replay, Manager Pro). This is the spec the actual Next.js build
should be checked against — treat it with the same durability as
CLAUDE.md.

## Visual conventions (apply across every screen)
- Tennis-ball logo in the sidebar wordmark.
- Real flag icons next to every player name (not text country codes).
- Prominent rank number (e.g. "#4") as the primary status signal; OVR
  rating is secondary, shown smaller underneath.
- Tennis scoreline notation for results, e.g. "Last: W 7-6, 6-2" — not
  a generic W/L indicator.
- Surface-color system: clay/grass/hard/indoor each get a consistent
  accent color, used on surface badges, affinity bars, and tournament
  tags.
- Net-line motif: a thin horizontal divider with a small center tick
  (evokes a net post), used as a structural divider — e.g. above table
  headers, above the sidebar footer.
- Seed numbers shown next to entrant names in tournament contexts, e.g.
  "(4) Deshawn Okafor."
- Sentence case throughout, no title case, no ALL CAPS except small
  label text (e.g. column headers, badges).
- Age-band badge: a small blue "U14"/"U16" pill (same blue used
  nowhere else, so it reads as one consistent signal) wherever a
  junior tournament or a junior-eligible player's ranking appears —
  the tournament picker, the tournaments list, the bracket header, and
  the roster dashboard's Rank column. Never shown for senior
  tournaments/rankings — absence of the badge IS the "this is senior"
  signal, not a separate "SENIOR" label.
- Sidebar XP balance: a persistent, always-visible readout just above
  the tier footer (not tucked into a page a manager has to navigate
  to) — it's spent on two real decisions (claiming a talent-pool
  candidate, converting a player to a coach), so it needs to be
  checkable from wherever a manager is deciding either one.

## Roster dashboard
- Roster sized for 2 (free) or 4 (Pro) players — never a long
  scrollable list. Shows "Roster X/Y slots used."
- Free-tier upsell copy states the tradeoff explicitly, e.g. "Manager
  Pro adds 2 more (faster point decay applies)" — never a bare perk
  with no cost mentioned.
- Fatigue shown as a prominent bar/meter per row with a moderate/fresh
  label, not buried behind a detail view.
- Surface affinity: four color-coded bars (C/G/H/I), height/fill
  proportional to strength (0–60 scale), not flat yes/no.
- Stage badge (Youth/Prime/Decline/Retired) plus a transition estimate,
  e.g. "Decline in ~4 seasons," "Retires in 1 season."
- Rank column shows the age-band badge (see visual conventions above)
  next to the rank number whenever a player's CURRENT age makes them
  junior-eligible (`RosterDashboardEntryDto.rankBand`, derived from
  `juniorEligibilityForAge` server-side, never guessed client-side) —
  the number itself is that player's position within THAT band, not
  the senior tour. No badge = senior rank, same as everywhere else the
  badge convention applies.
- Training Focus is a single dropdown with three grouped sections —
  Surface (Clay/Grass/Hard/Indoor), Technical (Serve/Forehand/Backhand/
  Volley), and Physical (Speed/Stamina/Strength) — exactly one
  selection at a time, never both simultaneously. There is no Mental
  group: mental attributes are not a valid `TrainingFocus` value at
  all, a compile-time impossibility via the domain model's
  `TrainingFocus`/`TrainableAttribute` types, not a UI-level omission.
- Row-level quick actions: Enter Tournament, change Training Focus —
  no drill-in required. **The tournament picker (`EnterTournamentModal`)
  shows the real age-band badge per junior tournament and disables any
  row that would exceed the real ITF weekly junior entry cap, OR that
  the player isn't currently age-eligible for** — see
  `JUNIOR_WEEKLY_ENTRY_CAP` (3 tournaments/week, not a smaller
  placeholder — see `juniorEntryCap.ts`'s doc comment for the sourcing)
  and `isAgeEligibleForTournamentBand` (playing UP into an older junior
  band is allowed — a real, deliberately-permitted case — playing down
  or a senior player entering a junior draw is not). Both show the
  exact reason inline ("Already entered 3/3 junior tournaments this
  week" / "Too old for this u14 draw — a player may play up into an
  older junior band, not down"), computed server-side from the same
  sources `RegisterEntrantUseCase` itself enforces against, never a
  client-side guess. Disabled up front, not just caught after a failed
  submit. The senior tour never shows either message — no age
  restriction applies there, on purpose (a junior player entering
  senior tournaments is a normal, unrestricted case, not a bug).
  Release/cut a player requires drilling in.
  **Convert to coach** lives in the same drill-in "More" menu as
  Release, for the same reason: it's exactly as consequential
  (permanent, removes the player from the roster) and shouldn't be a
  one-click row action. Unlike Release (a native `window.confirm()`),
  conversion opens a real modal — see `CoachConversionModal` — because
  the manager needs to see the SPECIFIC XP cost and resulting
  coachRating for that exact player (both pulled from the real
  `CoachConversionPolicy`, never invented placeholder numbers) before
  the explicit confirm step, not just acknowledge a generic warning
  string. The modal states the coach cap plainly if the manager is
  already at it (1 free tier / 2 Manager Pro — see `coachCap.ts`) and
  disables the confirm button rather than letting the attempt fail
  after the fact.
- Sort options include fatigue and stage/age, not just alphabetical.
- Real empty state for a brand-new manager: "Your roster is empty,"
  one-line explanation, "Browse Talent Pool" CTA — not a blank table.
- **Acquiring a player is pool-based and scarce, not instant/on-demand
  — this superseded an earlier direct "Hire Player" form design, don't
  reintroduce it.** "Browse talent pool" is a link to the dedicated
  `/scouting` page (see below), not a modal — claiming a candidate is
  substantial enough a decision (and the scouting screen full enough
  of its own information) to deserve a real page, matching the sidebar
  nav item it fulfills rather than living tucked inside Roster. A
  Manager Pro manager with at least one custom-player credit
  additionally sees a "Create custom player (N)" button on the Roster
  page itself — a name/nationality-only form (no attribute input at
  all) that shows the remaining credit count and spends one per use;
  this one stays a modal since it's a quick, self-contained action, not
  a browsing experience. Never show it to a free-tier manager, and
  never show it to a Pro manager with 0 credits (matching the "state
  the tradeoff/cost explicitly" convention above, not a bare disabled
  button with no explanation).

## Scouting
- The talent pool's real home — fulfills the sidebar nav item that
  used to read "Scouting / SOON."
- One row per candidate: flag + name, current OVR (precise, not
  fuzzed), a rarity tier badge (Common/Strong/Exceptional — how good
  this player already is), a **separate** potential tier badge
  (Limited/Promising/High/Elite — how good scouts think they could
  become), the real XP claim cost (`TalentClaimPricingPolicy.priceFor`,
  never a flat/estimated number), and a Claim button.
- **A candidate the manager can't afford stays fully visible, never
  hidden or filtered out** — that would silently shrink the pool for
  no reason a manager could see. The cost is shown muted/greyed
  instead of the normal dark tone, Claim is disabled (not removed),
  and a clear "Need N more XP" line states exactly how short the
  manager is, computed from their real current balance, not a vague
  "insufficient funds."
- Rarity and potential get visually distinct badge colors, on purpose
  — they're answering two different questions (current ability vs.
  scouted upside) and reusing one color language for both would blur
  that a "Common" player can still show "Elite" potential (the
  diamond-in-the-rough case scouting exists to sometimes find).
- A short, explicit disclaimer near the top of the screen that current
  attributes are precise but potential is a deliberately imperfect
  read, not a promise — this is a direct, load-bearing gameplay fact
  (see CLAUDE.md's "Player acquisition" note on the noise built into
  potentialTier), not incidental copy; don't cut it for space.
- Claiming is a real race against other managers: a candidate can
  disappear (already claimed) between loading the list and clicking
  claim, and that failure is shown inline (plus the list refreshes),
  never silently retried or hidden.
- Same manager-id dev-mode input pattern as Roster/Manager Pro — no
  shared cross-page identity yet, each screen asks independently.

## Tournaments (browse + planner)
- Two views behind a segmented Browse/Planner toggle at the top right
  — Browse is the original open/started tournament lists; Planner is
  the multi-week forward-planning view (see below). No manager
  identity is needed for Browse (it's public data); Planner needs one,
  same dev-mode manager-id input pattern as Scouting/Roster.
- **Filter bar (Browse only)**: a category segmented control (All /
  Senior / Junior), a row of tier chips (U14, U16, Futures,
  Challenger, Tour, Major — deliberately mixing age-band values and
  senior tier names into one flat set, matching the age-band-badge
  convention above rather than introducing raw J-grade filtering), and
  a row of surface chips (Clay/Grass/Hard/Indoor). All three groups
  combine with AND; an empty selection in a group means no restriction
  from it, not "show nothing." A combination with zero matches shows
  an honest "no tournaments match your filters" line, never a
  disabled/hidden chip trying to prevent the combination up front. Note
  for future work: as of this writing, Scouting itself has no filter
  bar of its own — this is the first one in the app, styled to match
  existing badge/pill conventions (rounded chips, active = dark
  fill/white text), not lifted from an existing Scouting pattern.
- **Multi-week planner**: pick a roster player, see their real entries
  (or lack thereof) across the next several upcoming weeks as columns,
  side by side — backed by `GET /players/:id/entry-planner`
  (`PlayerEntryPlannerQuery`). Each week shows its real entry/entries
  or "No entry yet," plus an inline (not modal) "+ Register" picker
  scoped to tournaments open for exactly that week — the point is
  committing several weeks' worth of entries in one sitting, so the
  picker never navigates away or closes the page. Reuses the same
  eligibility/cap data (`ageEligible`, `juniorEntryCountThisWeek`/
  `CapThisWeek`) `EnterTournamentModal` already reads, so a blocked
  attempt is disabled with the same real reason inline, not a second,
  possibly-drifted rule.

## Tournament bracket
- Single-elimination bracket, coded by the tournament's surface.
- Round status badges: Decided / In Progress / Upcoming, with a
  legend (Decided path / Pending-TBD / Bye) shown once at the top.
- Decided-path highlighting: solid colored connector lines trace a
  winner's route up the bracket; pending paths are lighter/greyed.
- Byes shown unambiguously: "BYE" tag plus "— No opponent —," never
  styled like a real scheduled match.
- Partial rounds handled correctly: shows "X of Y played," individual
  undecided matches show a scheduled time rather than a placeholder
  result.
- **Scaling rule**: any fully-decided round collapses into a compact
  list (name, result, truncated on overflow) — not just the earliest
  round. At a 128-draw, every completed round behind the active one
  collapses, keeping the full bracket viewable without excessive
  scrolling. Collapsed rows drop flags/seeds for compactness — this is
  a deliberate tradeoff, not an oversight.
- Decided match cards are clickable, linking to the match replay
  screen. This is stated in the on-screen legend ("Decided cards link
  to match replay →").

## Match replay
This is the most distinctive screen — it fakes a live-scoring
experience from a fully pre-simulated, immutable result log. No real
real-time connection exists anywhere in this feature.

- **Never use the word "live."** Use "Replay in progress" for active
  playback, and **"Premiere"** (not "Live") to label the actively-
  playing set — e.g. "SET 1 · PREMIERE." This is deliberate: the
  outcome is fully determined before anyone watches, so "live" is a
  false claim even under synced playback.
- **Playback model: wall-clock-synced "Premiere," not free on-demand
  replay.** A match simulated for a 3:00pm scheduled start should, if
  opened at 3:12pm, reflect where the match would actually be by now —
  not restart from zero. This preserves a shared "watching together"
  feeling.
- **Live-edge cap (open decision as of this doc — confirm before
  shipping):** speed controls and skip-ahead should let a viewer catch
  up to the match's actual current elapsed-real-time position, but
  never see beyond it until real time progresses further. Needs a
  "caught up — waiting for the next point" state for when a viewer
  hits that edge.
- Score display: SET 1/2/3 columns, each labeled, with the active set
  visually distinguished (bold/highlighted styling) — never a "LIVE"
  tag. Blank columns for sets not yet played must read unambiguously
  as "not played yet," not as missing data.
- **Point-level scoring is real**, not simulated as a coin-flip per
  game: standard 0/15/30/40 → deuce → advantage progression, with
  distinct visual treatment for deuce/advantage states (the highest-
  tension moments). Shown as "Current game: 40-40 · Deuce" style,
  positioned below/beside the main set/game score.
- Running commentary feed: accumulates as playback progresses, newest
  entry on top, scrollable once several entries exist. If no
  notable event has fired yet at a given point in playback, show a
  neutral placeholder ("Nothing notable yet — keep watching"), never a
  pre-play message once playback has actually started.
- Scrub bar includes tick marks at notable moments (breaks, set
  points, tiebreaks) — reinforces this is a curated replay of known
  events, not a raw progress bar.
- Speed controls should be labeled by estimated watch time (e.g.
  "Normal (~40s)," "Fast (~20s)," "Very fast (~5s)"), not raw internal
  multipliers — internal pacing constants are an implementation detail
  and shouldn't leak into button labels. Default to the slowest/most
  watchable tier on mount, not a faster one.
- Two additional states beyond active playback: a pre-play "Watch
  Replay" prompt (should reflect the Premiere/scheduled-time model,
  e.g. "Premieres at 3:00pm," not a generic "watch" prompt), and a
  post-completion state offering both "Back to Bracket" and, if
  applicable, "View Semifinal →" (or equivalent next-round link).

## Manager Pro
- Positioning line up top states the fairness commitment before
  pricing appears: "A paid tier for managers who want more room and
  less upkeep — not more win rate."
- Free tier is presented as fully playable, explicitly: "no crippled
  trial, no paywalled mechanics" — never framed as a limited trial.
- No SaaS-pricing-page tropes that undercut the fairness positioning:
  no "Most popular" social-pressure badge, no countdown urgency, no
  comparison table designed to make free look artificially worse.
- **"The one perk with a cost"** gets its own labeled section, visually
  distinguished (warning-tinted background) from the pure-convenience
  perks below it. The perk (4 roster slots instead of 2) and its cost
  (faster point decay on those slots specifically) are shown side by
  side in the same card — never perk-then-buried-disclaimer.
- Everything else (longer registration windows, extra stats/history
  pages, vacation delegate, no banners) is labeled explicitly as
  zero-effect-on-competitiveness convenience, reinforcing the contrast
  with the one perk that does carry a cost.

## Known open items (not yet resolved as of this doc)
- Live-edge capping behavior for match replay (see above) — needs
  explicit confirmation and implementation before the frontend ships.
- Whether the collapsed bracket rows should show anything richer on
  hover/click (e.g. a tooltip revealing the truncated name) — deferred,
  not blocking.

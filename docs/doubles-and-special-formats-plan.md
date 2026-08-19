# Doubles (P7) and Special Formats (P8) — plan

Status: **P7a, P7b, P7c, and P8 (a/b/c) are all BUILT. Nothing in this doc
is currently planned-not-built.** This line previously read "P7a + P7b
BUILT; P7c/P8 planned, not built," directly contradicted by this same
doc's own "Phasing" section further down (P7c marked ✅ BUILT) and P8's
own a/b/c subsections (each marked ✅ BUILT) — found and fixed during a
CLAUDE.md/AGENTS.md audit that trusted this line instead of the doc's own
body, the same class of staleness fixed there. See "Phasing" below for
what P7c covers (chemistry, doubles titles/peaks, doubles qualifying,
junior doubles — all shipped) and the P8a/b/c sections for special formats.
The partnership model (P7a) and the full doubles competition loop (P7b) are
implemented, tested, and wired end to end. P7b is what this status line used
to describe as the remaining "competition loop": the `doubles` skill
(attribute + generation + trainable), a generic `S`-defaulted
bracket/match type refactor (singles byte-identical), `Tournament`
doubles draws (`doublesDrawSize`/`doublesEntrants`/`doublesPairs`/
`doublesRounds`), per-player solo entry (`RegisterDoublesEntrantUseCase`,
`POST /tournaments/:id/doubles-entrants`), draw formation
(`DoublesPairingService` + `FormDoublesDrawUseCase` — persistent pairs
first, then random pairing + free-agent fillers, cutoff by SUM of
doubles-else-singles entry rankings), composite-pair simulation
(`DoublesPairPolicy` + `doublesSkill` in the sim, `discipline: 'doubles'`
ledger entries scaled by `DOUBLES_POINTS_FACTOR`, both players credited),
a doubles `RankPositionQuery` (best-14), and the frontend doubles panel +
solo-entry control + profile `doubles` skill. Migration
`0033_round_johnny_storm.sql`. Remaining: P7c (chemistry, doubles
titles/peaks, doubles qualifying, junior doubles) and P8.

Source of the requirement: `docs/rocking-rackets-competitive-analysis.md`
§1e (RR's doubles + special formats) and the gap table rows 5 and 7.

---

## P7. Doubles

### Why it matters

Roster utility and content from the *same* players. A roster slot is a
scarce, valuable thing today, and a player who isn't a singles star is
dead weight — doubles gives that player a second job, an own ranking to
climb, and a "doubles specialist" fantasy. It also doubles the amount of
match content a tournament produces without adding a single new player.

### RR reference (what we're *loosely* copying)

- A separate **trainable `doubles` stat**, distinct from the singles
  skills.
- **40% of the doubles stat adds to skill in doubles matches** (the one
  hard number RR documents).
- A **parallel ranking** (best-14 over 52 weeks, vs. best-18 singles)
  and **parallel draws on the same tournaments**.

### The one hard part (why this is "large")

A doubles match has **four players, two per side**. Everything the sim,
the bracket, and the ledger assume is "one `PlayerId` per side" today:

- `BracketRound.matches[].entrantA/entrantB` are `PlayerId`s; an outcome
  has `winner`/`loser` `PlayerId`s.
- `RankingLedgerEntry` is per-player.
- `StatisticalMatchSimulator` takes two `MatchParticipant`s.
- `RegisterEntrantUseCase`/weekly caps count one player per entry.

Doubles has to thread a *pair* through each of those without breaking the
singles path. That is the entire size of P7; the rest is ordinary.

### The partnership model — the social core (major task)

Doubles is not "any two players this week": it is a **persistent
partnership**, managed from the roster board and visible on every
involved player's profile. This is the piece that makes doubles feel like
a real *relationship* rather than a bracket-fill convenience, and it is
the first place one real manager's players interact with another's.

Two ways a pair comes to exist:

- **Same-manager pair.** A manager forms a pair from two of their own
  rostered players, directly from their board — immediate, active the
  moment it's created, no confirmation needed.
- **Cross-manager pair.** A manager targets another real manager's player
  (never a free agent — a managerless player has no one to accept) and
  sends an **invitation**. The target player's manager sees the pending
  invite on their board and accepts (→ active) or declines (→ gone).

An **active pair is always highlighted on both players' profiles** — a
"Doubles partner" element on the profile hero, with the partner's name,
flag and a link to their profile. (A pending invite shows as *pending*,
never as an active partnership.)

**`DoublesPair` is a new aggregate** (Competition context — it is the
unit that enters doubles draws; its invitation surface is pull-based, so
it does NOT need the not-yet-built Notifications context):

```
DoublesPair {
  id: PairId                 // branded id
  playerA: PlayerId          // the player whose manager created the pair
  playerB: PlayerId          // the partner
  status: 'pending' | 'active' | 'dissolved'
}
```

- `pending` = cross-manager, awaiting the *non-creating* manager's accept.
  `active` = playing. `dissolved` = declined, or ended later.
- The pair is visible to both managers (each sees it on their own board,
  since it involves their player).

**Invariants / rules** (each a deliberate decision, flagged here):

- A player is in **at most one** active pair and at most one pending
  invite at a time — one doubles relationship, not a stable of them.
- **Free agents and fill-only players are excluded entirely** from pairs:
  they have no manager to form a pair with or accept an invite.
- **Releasing a player dissolves any pair they're in** — a released player
  becomes a free agent, so the pair can't survive. `ReleasePlayerUseCase`
  must break active/pending pairs involving the released player (the one
  cascade).
- Either side can **dissolve an active cross-manager pair unilaterally**
  — a doubles partnership is a two-way street; nobody is trapped.

**Surfaces** (all pull-based, no push):

- **Board:** a "Doubles" section on the roster board to form a same-manager
  pair (pick two of your players) and to list your pairs + incoming
  invitations.
- **Invite target:** from another real manager's player's profile, an
  "Invite as doubles partner" action (disabled for free agents, with a
  note).
- **Player profile:** the active-pair highlight, plus the invite/accept/
  dissolve affordances for the manager(s) involved.

### Decisions + recommendations

1. **Doubles ability = one new trainable `doubles` skill, not a derived
   formula.** Add `'doubles'` to the attribute model as its own skill,
   trainable via `TrainingFocus` (extend `TrainableAttribute` with
   `'doubles'`; `isPhysicalAttribute` stays false, `applyTraining` gets a
   third branch like technical — open-ended or gated by the existing
   `potentialCeiling`). This is RR-faithful, gives the specialist fantasy
   a real training target, and keeps the change localized (one union
   member + one branch) rather than inventing a derived blend that would
   need its own tuning. PLACEHOLDER: whether the doubles skill is
   open-ended like technical or ceiling-gated like physical is a balance
   call, not made here.
2. **The pair, not the entry, is the unit.** Supersedes the earlier
   "ad-hoc pairs" sketch — the partnership model above is the design.
   There is no persistent *chemistry* stat in v1 (the pair is persistent;
   chemistry, if ever, slots onto it later — see P7c).
3. **Doubles draws live on the SAME tournaments** as singles (RR's
   model), not separate tournaments — otherwise doubles never feels like
   part of the same event. This means `Tournament` gains a
   `doublesRounds: BracketRound[]` beside `rounds`/`qualifyingRounds`,
   keyed on a new `PairId` (branded id) rather than `PlayerId`. The
   cleanest route is to generalize the bracket to a generic slot id (a
   branded string) so `BracketGenerator` seeds a doubles draw exactly as
   it seeds a singles one — the same "one implementation, not two
   near-copies" pattern `Tournament.roundsFor(draw)` already uses for
   main vs. qualifying. Doubles qualifying is explicitly OUT of v1 (see
   "out of scope").
4. **Ranking is a separate `discipline`, not a fake band.** Add an
   additive `discipline: 'singles' | 'doubles'` (default `'singles'`) to
   `RankingLedgerEntry`, and a doubles `RankPositionQuery` reusing
   `RankingCalculationService` with `bestResultsCapFor('doubles') = 14`
   (RR's number). Points are awarded to **both** players of the winning
   pair. Junior doubles is out of scope — doubles is senior-only in v1,
   so no U14/U16 doubles bands.
5. **Sim reuses `StatisticalMatchSimulator` with a composite pair
   rating.** A doubles "participant" is the pair; its effective rating is
   the mean of the two players' singles-relevant ratings **plus a
   doubles-skill term** (RR's "40% of the doubles stat" is the starting
   PLACEHOLDER — e.g. `+ 0.4 * doublesSkill` per player into the pair
   blend). The match log/outcome shape is unchanged (set scores); only
   the participant input differs. Replay shows four names.
6. **Fatigue/form: treat a doubles match like a singles match for v1.**
   Simplest correct default — same `fatigueCostForMatch`, same
   `applyMatchForm(1)` — then tune down (RR implies doubles is lighter)
   only if it proves to over-punish. A PLACEHOLDER tuning question, not a
   blocker.
7. **Entry caps are separate per discipline.** A player may enter singles
   AND doubles in the same tournament/week without the two counting
   against each other (the senior 1/week cap is a *singles* cap; doubles
   gets its own). An active pair registers as a single doubles entrant via
   its `PairId`.

### Phasing

- **P7a — Partnerships (the major task, standalone).** ✅ BUILT.
  `DoublesPair` aggregate + repository (new table + migration) + the
  invite/accept/decline/dissolve state machine + the board "Doubles"
  section + the invite-from-profile action + the active-pair profile
  highlight. Shipped on its own, before any doubles match is simulated
  — pairs can exist and be highlighted with no doubles competition yet.
- **P7b — the doubles competition loop.** ✅ BUILT. `doubles` skill →
  per-player solo entry → draw formation (pairing + combined-ranking
  cutoff) → composite-pair sim → doubles ranking band (best-14, both
  players credited) → doubles panel + entry UI. Consumes P7a's pairs
  (a persistent pair is one way to enter together; solo entrants are
  randomly paired, with free-agent fillers for an odd count).
- **P7c — depth.** ✅ BUILT (the coherent "complete the doubles loop" set):
  pair **chemistry** (a `DoublesPair` stat grown by playing together,
  carried onto the formed pair, fed to the sim as a small
  `CHEMISTRY_BONUS_PER_POINT` bonus), **doubles titles** (a
  `doubles_titles` row for the champion pair, both players) and **doubles
  peak rankings** (`doubles_peak_rankings`, best-14 high-water mark).
  Migration `0034_nasty_steve_rogers.sql`. STILL deferred (genuinely
   separate large features): none. (Junior doubles and doubles qualifying
   both shipped: every tier holds a doubles draw with per-band rankings
   (best-14 senior / best-6 junior); draws of 16+ pairs run a small,
   draw-size-derived qualifying event — `doublesQualifyingDrawSize`/
   `doublesQualifierSlots` stored at open time, `FormDoublesDrawUseCase`
   routes pairs into direct-acceptance vs. the qualifying field by
   combined ranking, `SimulateDueMatchesUseCase` sweeps it, and
   `PromoteDoublesQualifiersUseCase` seeds the deferred main doubles draw.
   Migrations `0036_tired_sinister_six.sql` + `0037_swift_wild_pack.sql`.)

### Explicitly out of scope for v1

Mixed doubles. (Pair chemistry, doubles titles, doubles peak rankings,
junior doubles, and DOUBLES QUALIFYING all shipped; Practice Sessions
are P8a, built.)

---

## P8. Special formats

Three sub-features, in build order. RR also lists **Olympics** — that is
explicitly **not** in scope here (it was never in our P8 line item).

### P8a. Practice Sessions — cheapest, highest value ✅ BUILT

A no-ranking-points, **no-form** activity: a player practices instead of
entering a tournament, gaining training experience (funds
`Player.applyTraining`) and crediting the manager's ladder, **without
touching form**. This is the outlet that makes the fatigue/form
constraint systems *tolerable* — when you don't want a real match, you
practice, and you're no longer choosing between "play and wreck form" and
"do nothing". (RR's exact version: top-100 only, 15 manager points/win;
ours is open to any rostered player.)

**Built:** `PracticePolicy`/`StandardPracticePolicy` (experience 2,
fatigue 2, ladder 15 — placeholders), `RunPracticeSessionUseCase` (once
per player per game day via the `practice_sessions` (player, season,
week, day) marker), `POST /players/:id/practice`, and a "Practice"
button on the roster board. The once-per-day guard makes it a throttle,
not an infinite XP tap — same day clock that paces matches. Migration
`0035_dear_havok.sql`.

### P8b. Masters Cup — season capstone, round-robin ✅ BUILT

**Built:** a season-end capstone for BOTH singles (top 8 senior players)
and doubles (top 8 persistent partnerships, ranked by combined doubles
entry ranking). The genuinely new shape is the ROUND-ROBIN GROUP STAGE:
`GroupStage`/`GroupStanding`/`groupStandings` + `GroupStageGenerator`
(snake-seeded 2×4 groups, pairwise matches), feeding a 4-player knockout
(semis + final) that reuses the existing `BracketGenerator`. The
`MastersCup` aggregate holds both disciplines' group stages + knockouts
and their advancement; `GenerateMastersCupUseCase` runs on the season's
capstone week (week 40, placeholder), `SimulateMastersCupMatchUseCase`
reuses the point-by-point sim (capstone points + titles at the
knockout), `SimulateDueMastersCupMatchesUseCase` paces it day-by-day,
and `AdvanceMastersCupUseCase` seeds the knockout once both group stages
finish. Persisted as `masters_cups` (jsonb group/knockout blobs —
one cup per season). Migration `0038_charming_pretty_boy.sql`, plus a
`/masters-cup` page.

### P8c. World Team Cup — country teams ✅ BUILT

A Davis-Cup-style national team event. **Built:** the `WorldTeamCup`
aggregate — two round-robin groups of four countries (reusing
`GroupStageGenerator`), every pairing a TIE of three rubbers (2 singles +
1 doubles, first to two — the real Davis Cup tie format), feeding a
knockout (semis + final). `GenerateWorldTeamCupUseCase` selects the top 8
countries by combined top-player ranking (each country's team is its top 2
players — the "2 players play singles and form the pair" case);
`SimulateWorldTeamCupRubberUseCase` reuses the point-by-point sim (a
doubles rubber is a composite pair; no individual ranking points/titles —
it's a team event); `SimulateDueWorldTeamCupRubbersUseCase` paces it
day-by-day; `AdvanceWorldTeamCupUseCase` seeds the knockout then the
final. Persisted as `world_team_cups` (jsonb blobs, one per season) —
migration `0039_powerful_toad.sql` — plus a `/world-team-cup` page.

A Davis-Cup-like national team event. This is the biggest and most social
of the three, and it is the least aligned with what we have: it needs a
"country team" concept (nationality-grouped rosters, or nationality
grouping of free agents/players), a team-vs-team match format, and a
team ranking. **Deliberately last** — build only if the social/academy
direction is actually wanted; it is closer to Bounded Context #7 (Social)
than to the Competition context, and could equally live under that
umbrella later.

### Recommendation

Build **P8a (Practice) first** — small, standalone, and it makes the
already-shipped fatigue/form systems feel better rather than adding a new
system. Then **P8b (Masters Cup)** once a season capstone is wanted. Hold
**P8c (World Team Cup)** until the social direction is decided.

---

## Open questions for the owner (P7/P8)

1. **Can a manager have multiple pairs at once, or one pair per roster
   slot?** The plan says "one active pair per *player*", but a manager
   with 4 players could field up to 2 pairs — is that intended, or should
   a manager be limited to one active pair total?
2. **Doubles-skill ceiling:** open-ended (technical-style) or gated
   (physical-style)? Affects whether doubles specialists converge on the
   same number or spread.
3. **Fatigue/form weight for doubles:** full singles weight, or a lighter
   fraction? (Recommend full for v1, then tune.)
4. **Masters Cup cadence:** once per season (like `juniorMasters`), and
   does it slot into the senior ladder as an extra tier or stay a
   separate capstone points event?
5. **World Team Cup or a different social feature first?** It may not be
   worth building at all unless the academy/guild direction is confirmed.

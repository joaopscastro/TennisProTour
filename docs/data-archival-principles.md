# Data archival & scalability principles

## Core principle: never delete history, structure for fast hot-path access instead
"Archive" here does not mean prune or summarize — the player profile
page needs real, full history to remain queryable indefinitely (a
tournament win from three seasons ago must still be there). The actual
problem to solve is keeping the *live* gameplay queries (current
rolling ranking) fast regardless of how much historical data
accumulates underneath them — an indexing and query-shape problem, not
a retention problem.

## What's already right by design
`RankingLedgerEntry` was built around a rolling 52-week window from the
start — the live ranking computation only ever needs recent entries
per player, never a full-table or full-history scan. That's the
correct shape already. What hasn't been confirmed is whether the
actual database index matches this access pattern.

## Before building the new profile-page tables

1. **Audit existing indexes** on the ranking ledger and match/tournament
   result tables against the two real access patterns: (a) "recent
   entries for one player" (the hot path, rolling-window ranking), and
   (b) "full history for one player" (the profile page). Confirm
   neither degrades into a full-table scan as the table grows — report
   what's actually indexed today, don't assume.

2. **New peak-ranking table stays small and mutable** — one row per
   player per ranking scope (senior/U14/U16), updated in place, never
   append-only. This table's size is bounded by player count × scope
   count, not by time — it should never grow unbounded.

3. **New trophy table stays append-only but lean** — reference
   tournament data (tournament ID, tier, season/week) rather than
   copying tournament details into each row. Display-time joins back to
   the canonical `Tournament` data, no denormalization.

4. **Tournament history queries reuse existing tournament/match tables**
   — no new store duplicating data that already exists elsewhere.

## Deliberately deferred, not built now
Season/year-based Postgres table partitioning for the high-volume
append-only tables (ranking ledger, match results) — this is the real
answer for genuine long-term scale, but building it now would be
solving a scale problem this game doesn't have yet. Revisit when there's
a concrete trigger: a single world's ledger exceeding roughly a few
million rows, or measured query latency degrading past an acceptable
threshold — whichever comes first. Until then, correct indexing is
sufficient.

## Existing precedent worth extending, not duplicating
`MatchLog` already established the right pattern for bulky,
low-frequency-access detail: point-by-point replay data lives outside
the hot relational path (object storage), not in a growing table. If
the profile page ever wants granular match-level detail beyond
round-level results, follow this same pattern rather than duplicating
replay data into a new table.

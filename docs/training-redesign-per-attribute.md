# Training redesign — per-attribute, three philosophies

**Status: built.** The `TrainingFocus`/training-application piece this
doc specifies (single-attribute selection, mental structurally
excluded via the `TrainableAttribute` type, technical uncapped,
physical gated per-attribute by reusing `applyPotentialDiminishingReturns`
rather than a second plateau formula) is implemented in
`packages/domain/src/player/{PlayerAttributes,TrainingPolicy,Player}.ts`,
threaded through the DB schema/migration, the API routes/schema
validation, and the roster dashboard's Training Focus dropdown. What
this doc does NOT yet cover, because this pass didn't touch it: the
surface × attribute weighting table below is still just the design,
not wired into `StatisticalMatchSimulator` or anywhere else.

Supersedes the coarse technical/physical/mental TrainingFocus cluster
system. Surface is handled separately (passive, match-driven) and is
not part of this. **This was a real, disclosed regression until fixed
directly, not just an assumption that happened to hold**: when the
manual `TrainingFocus: 'surface'` weekly option was removed as a
cluster-training axis, "passive, match-driven" growth was assumed to
already exist as its replacement — it didn't. Nothing anywhere in the
codebase ever called `SurfaceAffinities.trainedOn()` automatically, so
surface affinity was frozen at its `initial()` value (20 on all four
surfaces) forever, for any player, unless a manager happened to pick
that exact weekly focus. Confirmed by a full-repo grep for every
`trainedOn`/`trainedOnSurface` call site before writing a single line
of the fix. Now genuinely fixed: `SimulateMatchUseCase` applies
`Player.applyMatchSurfaceGrowth(tournament.surface, MATCH_SURFACE_AFFINITY_GAIN)`
to both participants after every simulated match, alongside the
existing fatigue application — see that constant's doc comment for why
its value is 1, not something smaller (a real constraint from
`SurfaceAffinities.trainedOn` now rounding to a whole number to match
the `integer` DB column, not an arbitrary tuning choice — fixing THAT
rounding gap was itself only discovered by actually persisting a
fractional result against live Postgres, not by reading the code).

## The three philosophies

| Cluster | Trainable? | Growth bound |
|---|---|---|
| Mental (consistency, clutch) | No — never a training target | Generated already mature at creation; personality isn't coached |
| Physical (speed, stamina, strength) | Yes, per-attribute | Hidden ceiling per attribute, set at generation, unknown to the manager — same pattern as the existing scouting `potentialCeiling` and coach-rating cap |
| Technical (serve, forehand, backhand, volley) | Yes, per-attribute | No ceiling — open-ended, bounded only by training investment and eventual decay once the player enters decline |

**Assumption, flag if wrong**: mental attributes stay exempt from
training but still decay normally during the decline stage, same as
every other attribute — not frozen for the player's whole career.

## TrainingFocus becomes single-attribute selection

Seven selectable options, one choice per week (unchanged philosophy —
a real weekly decision, not a checklist):
- Technical: serve | forehand | backhand | volley
- Physical: speed | stamina | strength

Mental is not selectable at all. UI reuses the existing grouped-dropdown
pattern (previously Surface/Skill headers, now Technical/Physical).

## Surface × attribute weighting (match simulation)

Confirmed starting point — placeholder/untuned like every other flagged
constant in this project, but grounded in how tennis actually plays,
not arbitrary:

| Surface | Rewards | Penalizes |
|---|---|---|
| Grass | Serve ×1.5, Volley ×1.4, Speed ×1.1 | Stamina ×0.8, Consistency ×0.9 |
| Clay | Stamina ×1.4, Consistency ×1.3, Forehand ×1.2 | Serve ×0.8, Volley ×0.7 |
| Hard | Neutral — all ×1.0 | — |
| Indoor | Serve ×1.3, Volley ×1.1 | Stamina ×0.9 |

This makes training choices create real, surface-specific player
identity: a grass serve-and-volleyer and a clay grinder become
mechanically distinct builds, not just cosmetically different.

## Deliberately deferred, not solved now

Whether the overall `potentialCeiling` (driving Scouting's uncertainty
range) should be *derived* from the new per-physical-attribute ceilings
plus technical/mental logic, rather than independently generated as it
is today. Deriving it would be more internally consistent but is real
added complexity — keeping it independent for now, flagged here so it
isn't forgotten.

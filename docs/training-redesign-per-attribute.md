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
system. Surface is already handled separately (passive, match-driven —
see the prior surface-affinity decision) and is not part of this.

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

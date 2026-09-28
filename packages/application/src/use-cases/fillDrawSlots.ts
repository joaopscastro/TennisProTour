import { isAgeEligibleForTournamentBand, Player, PlayerId, RankingBand, Tournament, TournamentEntrant } from '@tennis-manager/domain';
import { PlayerRepository, TournamentRepository } from '../ports/ports';
import { RankedPlayer, RankPositionQuery } from '../queries/RankPositionQuery';

/**
 * The shared "top this tournament's draw up from the unclaimed-player
 * pool" step. Extracted verbatim from StartDueTournamentsUseCase's
 * private fillSlots (the same selection it has always used), so the
 * second caller that needs it — PromoteQualifiersUseCase, rescuing a
 * main draw left too sparse to seed after qualifying promotion — pads
 * from the exact same pool with the exact same eligibility and
 * weekly-commitment rules rather than a second, drifting near-copy.
 *
 * The caller supplies the pool it wants (see
 * FillDrawSlotsPreloaded.freeAgentPool — StartDue passes the unified
 * `findFreeAgents()` list, the same pool the doubles padding uses; the
 * fallback for callers that don't is the fill-only filter).
 *
 * Selection is scoped by ranking BAND membership, never a skill proxy:
 * `isAgeEligibleForTournamentBand` decides who's eligible, genuinely
 * ranked candidates are preferred when a rank query is supplied, and
 * everyone else is ordered by id for a fully deterministic result. A
 * candidate already registered in ANY other tournament scheduled the
 * same `weekScheduled` is skipped (`findByPlayerAndWeek`), so one filler
 * is never double-booked into two draws the same week.
 *
 * The caller supplies `addEntrant` because the aggregate operation
 * legitimately differs by state: an OPEN tournament uses
 * `registerEntrant`, whereas one already underway (qualifying being
 * played) must use `addMainDrawFiller`. This keeps the aggregate's
 * invariants where they belong while the pool logic stays in one place.
 */
export interface FillDrawSlotsDeps {
  players: PlayerRepository;
  tournaments: TournamentRepository;
  /** Optional: the rank query for the tournament's own band. When
   * omitted (a caller with no rank query), selection just falls back to
   * the deterministic id ordering. Ignored when `preloaded.ranked` is
   * supplied. */
  rankQuery?: RankPositionQuery;
}

/**
 * Run-wide inputs a caller that fills SEVERAL draws in one execution can
 * load once and share, instead of re-reading pool/rankings/commitments
 * per draw (the fill N+1). Every field is OPTIONAL and falls back to
 * today's per-call read, so existing callers and fakes are unchanged.
 *
 * Content and ORDERING are load-bearing: the caller must supply the pool
 * it wants selected from, and `ranked` must be the band's
 * `sortedRankings()` — both exactly as the fallback path would produce
 * them, so the same candidates are picked in the same order.
 */
export interface FillDrawSlotsPreloaded {
  /** The pool candidates are selected from, in its own read order.
   * StartDueTournamentsUseCase passes `players.findFreeAgents()` — the
   * SAME unified pool the doubles padding path uses (every manager-less,
   * non-retired free agent, not just `fillOnly` ones), so a released
   * free agent the doubles path can place is never invisible to the
   * singles fill. When absent the legacy `findAll()` filter
   * (`fillOnly && !isRetired()`) is used, so other callers (and fakes)
   * are unchanged. */
  freeAgentPool?: ReadonlyArray<Player>;
  /** The tournament's band list from a run-wide `sortedRankings()`. */
  ranked?: ReadonlyArray<RankedPlayer>;
  /** The set form of "already entered ANY tournament the same week",
   * from `TournamentRepository.findEnteredPlayerIdsForWeek`. When
   * supplied, candidates in the set are skipped exactly as a non-empty
   * `findByPlayerAndWeek` result used to be — and the ids actually
   * filled by THIS call are added to the set, mirroring what the
   * immediate `save()` below makes visible to the next per-candidate
   * DB read in the old code. */
  enteredPlayerIdsForWeek?: Set<PlayerId>;
  /** The set form of the signing rule's `noUnfinishedCommitment`
   * predicate, from `TournamentRepository.findUnfinishedCommitmentPlayerIds`.
   * A candidate in this set is still alive in an earlier week's draw (a
   * 14-day major, a late-running event), so placing them into this draw
   * would give one player two matches on the same day — the per-week
   * set above cannot see that. Ids actually filled by THIS call are
   * added, so a later draw in the same run (even a different week's)
   * can't reuse them. Optional: absent (an in-memory fake, the legacy
   * fallback path) keeps the pre-existing same-week-only exclusion. */
  unfinishedCommitmentPlayerIds?: Set<PlayerId>;
}

/**
 * Per-tick counters for one fill run, so "the singles fill selected 0
 * while the doubles path placed 50+ from the same pool" can be PROVEN
 * from one log line rather than inferred from the entry table after the
 * fact (the evidence gap the 52-week agent season's VERIFIED-FINDINGS
 * §1 explicitly could not close: "not determinable from the artifacts
 * why the singles filler pool was empty"). Mutated in place by
 * fillDrawSlots when supplied; every field is a cumulative count across
 * the run.
 */
export interface FillDrawSlotsDiagnostics {
  /** Eligible (age-band-passing) candidates examined. */
  considered: number;
  /** Skipped because they are still alive in an earlier draw. */
  excludedUnfinishedCommitment: number;
  /** Skipped because they already hold a same-week entry. */
  excludedSameWeek: number;
  /** Actually placed. */
  selected: number;
}

export function emptyFillDrawSlotsDiagnostics(): FillDrawSlotsDiagnostics {
  return { considered: 0, excludedUnfinishedCommitment: 0, excludedSameWeek: 0, selected: 0 };
}

export async function fillDrawSlots(
  deps: FillDrawSlotsDeps,
  tournament: Tournament,
  needed: number,
  draw: 'main' | 'qualifying',
  addEntrant: (entrant: TournamentEntrant) => void,
  preloaded: FillDrawSlotsPreloaded = {},
  diagnostics?: FillDrawSlotsDiagnostics,
): Promise<number> {
  if (needed <= 0) return 0;
  const band: RankingBand = tournament.ageBand ?? 'senior';

  // A retired player is never a live filler: nothing deletes a retired
  // player, and without this exclusion they would still be selected into
  // a real tournament draw they can never play.
  const fillOnlyPlayers =
    preloaded.freeAgentPool ?? (await deps.players.findAll()).filter((p) => p.fillOnly && !p.isRetired());
  const ranked = preloaded.ranked ?? (deps.rankQuery ? await deps.rankQuery.sortedRankings() : []);
  const rankOrder = new Map(ranked.map((r, index) => [r.playerId, index]));

  const eligible = fillOnlyPlayers.filter((p) =>
    isAgeEligibleForTournamentBand(p.seasonAgeAnchorWeeks, tournament.ageBand),
  );

  const enteredThisWeek = preloaded.enteredPlayerIdsForWeek;
  const unfinishedCommitments = preloaded.unfinishedCommitmentPlayerIds;
  const available: PlayerId[] = [];
  for (const candidate of eligible) {
    if (diagnostics) diagnostics.considered += 1;
    // Still alive in ANY earlier-concluded-by-week draw — never placed
    // into this one, regardless of whether that draw's week matches.
    if (unfinishedCommitments?.has(candidate.id)) {
      if (diagnostics) diagnostics.excludedUnfinishedCommitment += 1;
      continue;
    }
    if (enteredThisWeek) {
      // Preloaded commitment set: one membership check instead of a
      // single-player round trip (the N+1 this preload removes).
      if (!enteredThisWeek.has(candidate.id)) available.push(candidate.id);
      else if (diagnostics) diagnostics.excludedSameWeek += 1;
      continue;
    }
    const committedElsewhere = await deps.tournaments.findByPlayerAndWeek(candidate.id, tournament.weekScheduled);
    if (committedElsewhere.length === 0) available.push(candidate.id);
    else if (diagnostics) diagnostics.excludedSameWeek += 1;
  }

  available.sort((a, b) => {
    const aRank = rankOrder.get(a);
    const bRank = rankOrder.get(b);
    // Genuinely-ranked candidates first (in their real rank order) —
    // structurally near-impossible for an unclaimed player today, but
    // genuinely honored, not dead code.
    if (aRank !== undefined || bRank !== undefined) {
      if (aRank === undefined) return 1;
      if (bRank === undefined) return -1;
      return aRank - bRank;
    }
    // Fully deterministic tie-break — never a skill/rating proxy.
    return a.localeCompare(b);
  });

  const selected = available.slice(0, needed);
  if (diagnostics) diagnostics.selected += selected.length;
  for (const playerId of selected) {
    // A filler in the qualifying field IS a qualifier — it has to win its
    // way through exactly like a human registrant there. Left absent for
    // the main draw, unchanged from before qualifying existed.
    const entrant: TournamentEntrant =
      draw === 'qualifying'
        ? { playerId, seed: null, draw, entryType: 'Q' }
        : { playerId, seed: null };
    addEntrant(entrant);
    enteredThisWeek?.add(playerId);
    // The new entrant now holds an unfinished commitment to THIS draw,
    // so the run-wide set is updated too — a later draw this run (even
    // in a different week) must not reuse them.
    unfinishedCommitments?.add(playerId);
  }
  // Persist immediately — later tournaments processed this same run rely
  // on findByPlayerAndWeek seeing it.
  await deps.tournaments.save(tournament);

  return selected.length;
}

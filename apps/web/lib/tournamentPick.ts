import type { TournamentDto } from './api';

/**
 * Pure sort/filter/grouping helpers for the tournament entry pickers.
 *
 * A naive first-time-user walkthrough found the entry modal was one flat
 * list of 230-250 rows in an effectively arbitrary order (a season-1
 * week-9 event ahead of week 3), with no way to narrow it and a 13-year-old
 * being offered senior majors. These helpers are the real, tested
 * computation behind the fix — the same "extract the pure rule into
 * lib/*.ts and pin it" pattern as bracketStatus.ts/xp.ts.
 *
 * Deliberately typed against a minimal structural surface rather than the
 * full TournamentDto so tests can build tiny fixtures; real DTOs satisfy it
 * unchanged.
 */

export interface PickableTournament {
  id: string;
  name: string;
  tier: string;
  surface: string;
  ageBand: string | null;
  hostCountry: string | null;
  weekScheduled: { season: number; week: number };
  /** Only present when the list was fetched with ?playerId= (see
   * fetchOpenTournaments); undefined for a non-player-scoped list. */
  ageEligible?: boolean;
  entrants: ReadonlyArray<{ draw: 'main' | 'qualifying' }>;
  drawSize: number;
  qualifierSlots?: number;
  entryViaQualifying?: boolean;
  qualifyingFieldFull?: boolean;
  /** Player-scoped fields echoed off the same DTO (see TournamentDto). */
  weeklyEntryCountThisWeek?: number;
  weeklyEntryCapThisWeek?: number;
  mainDrawEntrants?: number;
  qualifyingFieldTaken?: number;
  qualifyingFieldSize?: number;
}

/** Junior age bands, in their canonical order — the same values the
 * age-band badges render. */
export const JUNIOR_BAND_VALUES = ['u14', 'u16', 'u18'] as const;
export type JuniorBand = (typeof JUNIOR_BAND_VALUES)[number];

export function isJuniorBandValue(value: string): value is JuniorBand {
  return (JUNIOR_BAND_VALUES as readonly string[]).includes(value);
}

/** Which slice of the picker list to show. 'eligible' is the default: only
 * tournaments whose band the player's age actually qualifies for. The
 * "show everything" options stay one click away — the pre-filter is a
 * disclosure, never a silent hide (see Finding A's constraint 3). */
export type CircuitFilter = 'eligible' | 'all' | 'senior' | 'junior';

/** Absolute week index (season * 52 + week) — the real gameweek ordering,
 * season-aware so a season-2 week-1 sorts after a season-1 week-52. */
export function tournamentWeekIndex(week: { season: number; week: number }): number {
  return week.season * 52 + week.week;
}

/** Tier order, only ever a tie-break INSIDE a week — orders the tiers a
 * manager scans in a familiar direction (futures → major, j30 → j500)
 * without claiming any cross-circuit equivalence. */
const TIER_ORDER: Record<string, number> = {
  futures: 1,
  challenger: 2,
  tour: 3,
  major: 4,
  j30: 1,
  j60: 2,
  j100: 3,
  j200: 4,
  j300: 5,
  j500: 6,
  juniorMasters: 7,
};

/** The picker's real sort: nearest/current week first, then senior before
 * junior within a week, then tier, then name. The API's list order was
 * effectively arbitrary — it scrambled weeks, which is what made the flat
 * list impossible to scan. */
export function compareTournamentsForPicker(a: PickableTournament, b: PickableTournament): number {
  const weekA = tournamentWeekIndex(a.weekScheduled);
  const weekB = tournamentWeekIndex(b.weekScheduled);
  if (weekA !== weekB) return weekA - weekB;
  const circuitA = a.ageBand ? 1 : 0;
  const circuitB = b.ageBand ? 1 : 0;
  if (circuitA !== circuitB) return circuitA - circuitB;
  const tierA = TIER_ORDER[a.tier] ?? 99;
  const tierB = TIER_ORDER[b.tier] ?? 99;
  if (tierA !== tierB) return tierA - tierB;
  return a.name.localeCompare(b.name);
}

export function sortTournamentsForPicker<T extends PickableTournament>(list: readonly T[]): T[] {
  return [...list].sort(compareTournamentsForPicker);
}

export interface TournamentPickGroup<T> {
  key: string;
  label: string;
  items: T[];
}

/** Sections a sorted list by circuit + scheduled week. Sorting senior
 * before junior within a week keeps each section contiguous (see
 * compareTournamentsForPicker), so the sections render as one clean run
 * rather than interleaving. */
export function groupTournamentsForPicker<T extends PickableTournament>(
  list: readonly T[],
): TournamentPickGroup<T>[] {
  const groups: TournamentPickGroup<T>[] = [];
  const byKey = new Map<string, TournamentPickGroup<T>>();
  for (const tournament of list) {
    const circuit = tournament.ageBand ? 'junior' : 'senior';
    const key = `${circuit}-${tournament.weekScheduled.season}-${tournament.weekScheduled.week}`;
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        label: `${circuit === 'junior' ? 'Junior' : 'Senior'} · Season ${tournament.weekScheduled.season}, Week ${tournament.weekScheduled.week}`,
        items: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(tournament);
  }
  return groups;
}

export interface TournamentPickFilters {
  circuit: CircuitFilter;
  surfaces: ReadonlySet<string>;
  search: string;
}

function searchHaystack(tournament: PickableTournament): string {
  return `${tournament.name} ${tournament.tier} ${tournament.surface} ${tournament.ageBand ?? ''} ${tournament.hostCountry ?? ''}`.toLowerCase();
}

/** Applies the picker's circuit / surface / search narrowing. Circuit is
 * the primary axis: 'eligible' drops a band the player's age doesn't
 * qualify for (never a silent hide — it is the labelled default), while
 * 'all'/'senior'/'junior' are explicit, matchable choices. */
export function matchesTournamentPickFilters(tournament: PickableTournament, filters: TournamentPickFilters): boolean {
  if (filters.circuit === 'eligible' && tournament.ageEligible === false) return false;
  if (filters.circuit === 'senior' && tournament.ageBand !== null) return false;
  if (filters.circuit === 'junior' && tournament.ageBand === null) return false;
  if (filters.surfaces.size > 0 && !filters.surfaces.has(tournament.surface)) return false;
  const query = filters.search.trim().toLowerCase();
  if (query.length > 0 && !searchHaystack(tournament).includes(query)) return false;
  return true;
}

/** Whether a tournament still has room for the queried player. A
 * qualifying-tier entrant below the cutoff is measured against the
 * QUALIFYING field (which `entrants.length < drawSize` can't see —
 * `entrants` includes qualifying entrants), while a direct-acceptance or
 * non-qualifying entrant is measured against the main draw. */
export function tournamentHasRoom(tournament: PickableTournament): boolean {
  if (tournament.entryViaQualifying) return !tournament.qualifyingFieldFull;
  const mainEntrants = tournament.entrants.filter((e) => e.draw !== 'qualifying').length;
  const mainCapacity = tournament.drawSize - (tournament.qualifierSlots ?? 0);
  return mainEntrants < mainCapacity;
}

/** Why this player can't be entered into this tournament right now, or
 * null if they can. Mirrors RegisterEntrantUseCase's real refusals (age
 * band, weekly cap, full qualifying field, full main draw) so both entry
 * surfaces — the picker modal and a tournament page's own entry control —
 * explain a block the same way, from the same data. */
export function tournamentRefusalReason(tournament: PickableTournament): string | null {
  if (tournament.ageEligible === false) {
    return `Too old for this ${tournament.ageBand} draw — a player may play up into an older junior band, not down`;
  }
  const overCap =
    tournament.weeklyEntryCountThisWeek !== undefined &&
    tournament.weeklyEntryCapThisWeek !== undefined &&
    tournament.weeklyEntryCountThisWeek >= tournament.weeklyEntryCapThisWeek;
  if (overCap) {
    return tournament.weeklyEntryCapThisWeek === 1
      ? 'Already entered a tournament this week — a player can only play one tournament per week'
      : `Already entered ${tournament.weeklyEntryCountThisWeek}/${tournament.weeklyEntryCapThisWeek} tournaments this week`;
  }
  if (tournament.entryViaQualifying && tournament.qualifyingFieldFull) {
    return `Qualifying field full (${tournament.qualifyingFieldTaken}/${tournament.qualifyingFieldSize}) — no [Q] places left`;
  }
  if (!tournamentHasRoom(tournament)) {
    const capacity = tournament.drawSize - (tournament.qualifierSlots ?? 0);
    return `Main draw full (${tournament.mainDrawEntrants ?? 0}/${capacity})`;
  }
  return null;
}

export type BrowseCategory = 'all' | 'senior' | 'junior';

/** Keeps a tier-chip selection consistent with a freshly chosen category.
 *
 * This is the real cause of the Browse page's "Junior filter shows
 * nothing" bug: the default tier selection is `['tour']` (senior-only),
 * so picking Junior left an impossible Junior + Tier=Tour combination
 * selected and every row was filtered out. Dropping the now-inapplicable
 * chips leaves an empty tier set, which the filter bar already treats as
 * "no restriction from this group" — so Junior genuinely shows every
 * junior event, exactly what its label claims. */
export function pruneTiersForCategory<T extends string>(category: BrowseCategory, tiers: ReadonlySet<T>): Set<T> {
  const next = new Set(tiers);
  if (category === 'senior') {
    for (const value of next) if (isJuniorBandValue(value)) next.delete(value);
  } else if (category === 'junior') {
    for (const value of next) if (!isJuniorBandValue(value)) next.delete(value);
  }
  return next;
}

/** Whether a tier chip can ever match under the chosen category — showing
 * a senior tier chip under Junior only ever produced an empty list, so the
 * filter bar renders only the chips that can actually apply. */
export function tierChipAppliesToCategory(value: string, category: BrowseCategory): boolean {
  if (category === 'senior') return !isJuniorBandValue(value);
  if (category === 'junior') return isJuniorBandValue(value);
  return true;
}

/** Convenience: the full picker pipeline (filter → sort → group) used by
 * EnterTournamentModal, in one place so the list order can't drift between
 * the modal and any future caller. */
export function buildTournamentPickGroups<T extends PickableTournament>(
  list: readonly T[],
  filters: TournamentPickFilters,
): TournamentPickGroup<T>[] {
  const filtered = list.filter((t) => matchesTournamentPickFilters(t, filters));
  return groupTournamentsForPicker(sortTournamentsForPicker(filtered));
}

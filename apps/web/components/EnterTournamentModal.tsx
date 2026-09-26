'use client';

import { useEffect, useMemo, useState } from 'react';
import { TournamentDto, fetchOpenTournaments, registerEntrant } from '../lib/api';
import { CircuitFilter, PlayerFitContext, buildTournamentPickGroups, entryFitFor, entryFitLabel, fitGuidance, managerEntrantLabel, tournamentRefusalReason } from '../lib/tournamentPick';
import { AgeBandBadge, Button, SurfaceBadge } from './ui/primitives';
import { Modal } from './ui/Modal';
import { Icon } from './ui/Icon';
import { TournamentRewardsLadder, TournamentRewardSummary } from './TournamentRewards';

const SURFACE_CHIPS: Array<{ value: string; label: string }> = [
  { value: 'clay', label: 'Clay' },
  { value: 'grass', label: 'Grass' },
  { value: 'hard', label: 'Hard' },
  { value: 'indoor', label: 'Indoor' },
];

// "Eligible" means "every event this player is PERMITTED to enter", which is
// deliberately broader than "events in their own age band": a junior may play
// up into an older junior band (never down), and anyone — junior or senior —
// may enter the senior tour. The old label alone didn't say that, so a U14
// player's list containing U16/U18/senior events read as a bug. The title and
// the body copy below now spell it out; the rules themselves are unchanged.
const CIRCUIT_CHIPS: Array<{ value: CircuitFilter; label: string; title: string }> = [
  { value: 'eligible', label: 'Eligible to enter', title: "Every event this player is permitted to enter — their own junior band, any older junior band (a junior may play up, never down), and any senior event" },
  { value: 'all', label: 'All circuits', title: 'Every open tournament, eligible or not' },
  { value: 'senior', label: 'Senior', title: 'Senior-tour events only' },
  { value: 'junior', label: 'Junior', title: 'Junior-band events only' },
];

interface Props {
  playerId: string;
  playerName: string;
  /** The player's actual owning manager — required so the register
   * call authenticates as the right manager (see registerEntrant's
   * doc comment); omitting this silently falls back to the dev-mode
   * default manager, which only coincidentally works when that
   * happens to be who's logged in. */
  managerId: string;
  /** When set (the player profile's Schedule planner passes the week
   * the manager clicked "Enter" on), restrict the list to tournaments
   * scheduled for exactly that week — a manager entering a player for
   * a specific future week should not be offered every open
   * tournament across the whole season. Omitted (the roster board's
   * "Enter" action) = show every open tournament, same as before. */
  week?: { season: number; week: number };
  /** What the app already knows about this player (rank + overall) so the
   * picker can mark each event as a direct entry or a qualifying one. Both
   * callers already hold this — no new query. Omitted = no fit guidance. */
  playerFit?: PlayerFitContext | null;
  onClose: () => void;
  onEntered: (tournament: TournamentDto) => void;
}

/** A single selectable tournament row. The selected state is deliberately
 * unmistakable (ring + check pill + aria-pressed), because a naive-user
 * walkthrough found the previous subtle border change wasn't noticed at
 * all — "the visible text and element states did not change". */
function TournamentPickRow({
  tournament,
  selected,
  blocked,
  reason,
  onSelect,
}: {
  tournament: TournamentDto;
  selected: boolean;
  blocked: boolean;
  reason: string | null;
  onSelect: () => void;
}) {
  const fit = entryFitFor(tournament);
  const managers = managerEntrantLabel(tournament.managerEntrants);
  return (
    <button
      onClick={() => !blocked && onSelect()}
      disabled={blocked}
      aria-pressed={selected}
      data-selected={selected}
      className="relative text-left rounded-[6px] pl-[16px] pr-[12px] py-[9px] cursor-pointer disabled:cursor-not-allowed"
      style={{
        border: selected ? '2px solid var(--accent)' : '1px solid var(--hair)',
        background: selected ? 'var(--bg-3)' : 'var(--bg-2)',
        boxShadow: selected ? '0 0 0 3px color-mix(in srgb, var(--accent) 28%, transparent)' : undefined,
        opacity: blocked ? 0.55 : 1,
      }}
    >
      {selected && (
        <span
          aria-hidden
          style={{ position: 'absolute', left: 0, top: 6, bottom: 6, width: 3, borderRadius: 3, background: 'var(--accent)' }}
        />
      )}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex-none"><SurfaceBadge surface={tournament.surface} size="sm" /></span>
          <AgeBandBadge band={tournament.ageBand} />
          {tournament.entryViaQualifying && <span className="flex-none"><span className="gc-badge gc-badge--q">[Q]</span></span>}
          <div className="text-[13.5px] font-semibold truncate">{tournament.name}</div>
        </div>
        <div className="flex items-center gap-2 flex-none">
          {selected && (
            <span className="inline-flex items-center gap-[4px]" style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 11 }}>
              <Icon name="check" size={11} /> Selected
            </span>
          )}
          <div className="num" style={{ color: 'var(--ink-3)' }}>
            {tournament.mainDrawEntrants}/{tournament.drawSize}
          </div>
        </div>
      </div>
      <div className="text-[11.5px] mt-[3px]" style={{ color: 'var(--ink-3)' }}>
        {tournament.tier} · season {tournament.weekScheduled.season}, week {tournament.weekScheduled.week}
        {tournament.hostCountry ? (
          <>
            {' · '}
            <Icon name="house" size={11} title="Host country — a player of this nationality has home advantage here" style={{ verticalAlign: 'text-bottom' }} />
            {' '}{tournament.hostCountry}
          </>
        ) : ''}
        {' · '}
        <span style={{ fontWeight: 700, color: fit === 'direct' ? 'var(--win)' : 'var(--warn)' }}>
          {entryFitLabel(fit)}
        </span>
      </div>
      {tournament.entryViaQualifying && !tournament.qualifyingFieldFull && (
        <div className="text-[11px] mt-[4px]" style={{ color: 'var(--ink-2)' }}>
          You&apos;ll enter through qualifying — {tournament.qualifyingFieldTaken}/{tournament.qualifyingFieldSize} qualifying spots taken
        </div>
      )}
      {/* Who else is already in — the server's own count of manager-owned
          entrants, so a manager can judge whether it makes sense to enter
          without opening every tournament. It shows who HAS entered, never
          who will. */}
      {managers && (
        <div className="text-[11px] mt-[4px]" style={{ color: managers === 'No managers entered yet' ? 'var(--ink-4)' : 'var(--ink-2)' }}>
          {managers}
        </div>
      )}
      {reason && (
        <div className="text-[11px] font-semibold mt-[4px]" style={{ color: 'var(--loss)' }}>
          {reason}
        </div>
      )}
      <TournamentRewardSummary tournament={tournament} />
    </button>
  );
}

/**
 * Real tournament picker for the roster row's "Enter" action —
 * replaces the earlier "register into whichever open tournament has
 * room first" shortcut. Lists every tournament actually open for
 * registration (GET /tournaments?status=open) and lets the manager
 * choose, since silently picking one on the player's behalf is a
 * meaningful decision (surface, tier, field size) a manager should
 * make deliberately.
 *
 * The list is sorted nearest-week-first and sectioned by circuit+week,
 * and defaults to only what the player is age-eligible for (with explicit
 * "All circuits"/"Senior"/"Junior" ways to widen it) — see
 * lib/tournamentPick.ts. Without that, a first-time user faced a flat
 * ~250-row list in arbitrary week order with no way to narrow it.
 */
export function EnterTournamentModal({ playerId, playerName, managerId, week, playerFit, onClose, onEntered }: Props) {
  const [tournaments, setTournaments] = useState<TournamentDto[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [circuit, setCircuit] = useState<CircuitFilter>('eligible');
  const [surfaces, setSurfaces] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState('');
  // Default ON: with ~250 open events, the fastest answer to "what should
  // this player enter?" is the set that accepts them directly. It is a
  // labelled, one-click-widenable disclosure, never a silent hide.
  const [directEntryOnly, setDirectEntryOnly] = useState(true);

  useEffect(() => {
    fetchOpenTournaments(playerId)
      .then((all) =>
        setTournaments(
          all.filter(
            (t) =>
              !t.entrants.some((e) => e.playerId === playerId) &&
              (!week || (t.weekScheduled.season === week.season && t.weekScheduled.week === week.week)),
          ),
        ),
      )
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [playerId, week]);

  async function handleConfirm() {
    if (!selectedId) return;
    setSubmitting(true);
    setError(null);
    try {
      const tournament = await registerEntrant(selectedId, playerId, managerId);
      onEntered(tournament);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  const filters = useMemo(() => ({ circuit, surfaces, search, directEntryOnly }), [circuit, surfaces, search, directEntryOnly]);
  const groups = useMemo(() => (tournaments ? buildTournamentPickGroups(tournaments, filters) : []), [tournaments, filters]);
  const filteredCount = useMemo(() => groups.reduce((n, g) => n + g.items.length, 0), [groups]);

  const selectedTournament = tournaments?.find((t) => t.id === selectedId) ?? null;
  const guidance = fitGuidance(playerFit);
  const anyNarrowing = circuit !== 'eligible' || surfaces.size > 0 || search.trim().length > 0 || directEntryOnly;

  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title={`Enter ${playerName} into a tournament`}
      footer={
        <div className="flex items-center gap-2 w-full">
          {/* Say WHY "Enter tournament" is disabled: nothing is selected yet
              (mirrors the singles entry panel's equivalent note). A disabled
              button with no visible instruction read as broken. */}
          {!selectedId && (
            <span className="text-[11.5px] mr-auto" style={{ color: 'var(--ink-3)' }}>
              Select a tournament above to enable Enter.
            </span>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleConfirm} disabled={!selectedId || submitting}>
            {submitting ? 'Entering…' : 'Enter tournament'}
          </Button>
        </div>
      }
    >
      <div className="text-[12.5px] mb-3" style={{ color: 'var(--ink-3)', lineHeight: 1.5 }}>
        {circuit === 'eligible'
          ? `Showing every event ${playerName} is permitted to enter — a junior may play up an age band (never down), and anyone may enter the senior tour. Switch to All/Senior/Junior to narrow the list.`
          : 'Choose a tournament still open for registration.'}
      </div>

      {/* The cap fact a manager needs BEFORE picking: the weekly entry cap
          counts tournaments, not draws, so a singles entry here plus the
          event's doubles is still one tournament — it must never read as a
          second weekly commitment the way a different event would be. */}
      <div className="text-[11.5px] mb-3" style={{ color: 'var(--ink-4)', lineHeight: 1.5 }}>
        The weekly cap counts tournaments, not draws: {playerName}&apos;s singles and doubles at the SAME event is one
        tournament. After entering singles here, add the doubles entry from the event&apos;s page — no extra weekly
        entry.
      </div>

      {guidance && (
        <div
          className="mb-3 rounded-[6px] px-3 py-2 text-[12px] leading-[1.5]"
          style={{ background: 'var(--bg-3)', border: '1px solid var(--hair)', color: 'var(--ink-2)' }}
        >
          <strong style={{ color: 'var(--ink)' }}>Which event fits {playerName}?</strong> {guidance}
        </div>
      )}

      {error && (
        <div className="gc-notice mb-3" style={{ color: 'var(--loss)', borderColor: 'color-mix(in srgb, var(--loss) 40%, transparent)' }}>
          {error}
        </div>
      )}

      {tournaments !== null && tournaments.length > 0 && (
        <div className="flex flex-col gap-[8px] mb-3 rounded-[6px] p-3" style={{ border: '1px solid var(--hair)', background: 'var(--bg-2)' }}>
          <div className="t-label">
            Search &amp; filter
          </div>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, tier, surface or country…"
            className="gc-input text-[13px] w-full"
            aria-label="Search open tournaments"
          />
          <div className="flex flex-wrap items-center gap-[6px]">
            {CIRCUIT_CHIPS.map((chip) => (
              <button
                key={chip.value}
                type="button"
                title={chip.title}
                aria-pressed={circuit === chip.value}
                data-active={circuit === chip.value}
                onClick={() => setCircuit(chip.value)}
                className="gc-chip"
              >
                {chip.label}
              </button>
            ))}
            <div className="w-px h-4 mx-1" style={{ background: 'var(--hair)' }} />
            {SURFACE_CHIPS.map((chip) => {
              const active = surfaces.has(chip.value);
              return (
                <button
                  key={chip.value}
                  type="button"
                  aria-pressed={active}
                  data-active={active}
                  onClick={() => setSurfaces((current) => { const next = new Set(current); if (next.has(chip.value)) next.delete(chip.value); else next.add(chip.value); return next; })}
                  className="gc-chip"
                >
                  {chip.label}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-[6px]">
            <span className="t-label">Best fit</span>
            <button
              type="button"
              aria-pressed={directEntryOnly}
              data-active={directEntryOnly}
              title="Only events that take this player straight into the main draw — no qualifying"
              onClick={() => setDirectEntryOnly((v) => !v)}
              className="gc-chip"
            >
              Direct entry only
            </button>
            {directEntryOnly && (
              <button
                type="button"
                onClick={() => setDirectEntryOnly(false)}
                className="gc-chip"
              >
                Show all events
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {tournaments === null && !error && (
          <div className="text-[13px]" style={{ color: 'var(--ink-3)' }}>
            Loading open tournaments…
          </div>
        )}
        {tournaments?.length === 0 && (
          <div className="text-[13px]" style={{ color: 'var(--ink-3)' }}>
            {week ? 'No tournaments are open for this week.' : 'No tournaments are open for entries right now.'}
          </div>
        )}
        {tournaments && tournaments.length > 0 && filteredCount === 0 && (
          <div className="text-[13px]" style={{ color: 'var(--ink-3)' }}>
            No tournaments match these filters — widen the circuit filter, turn off “Direct entry only”, or clear the search.
          </div>
        )}
        {groups.map((group) => (
          <div key={group.key} className="flex flex-col gap-2">
            <div className="t-label pt-1">
              {group.label}
            </div>
            {group.items.map((t) => {
              const reason = tournamentRefusalReason(t);
              return (
                <TournamentPickRow
                  key={t.id}
                  tournament={t}
                  selected={selectedId === t.id}
                  blocked={reason !== null}
                  reason={reason}
                  onSelect={() => setSelectedId(t.id)}
                />
              );
            })}
          </div>
        ))}
      </div>

      {tournaments && tournaments.length > 0 && (
        <div className="text-[11px] mt-2 flex items-center justify-between gap-3" style={{ color: 'var(--ink-4)' }}>
          <span>
            {filteredCount} of {tournaments.length} events match your filters.
          </span>
          {anyNarrowing && (
            <button
              type="button"
              onClick={() => { setCircuit('all'); setSurfaces(new Set()); setSearch(''); setDirectEntryOnly(false); }}
              className="cursor-pointer bg-transparent border-none underline p-0"
              style={{ color: 'var(--accent)', fontSize: 11 }}
            >
              Show all {tournaments.length}
            </button>
          )}
        </div>
      )}

      {selectedTournament && (
        <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--hair)' }}>
          <div className="t-label mb-[7px]">
            What you&apos;re playing for — {selectedTournament.name}
          </div>
          <TournamentRewardsLadder tournament={selectedTournament} />
          {/* The "check before you enter" affordance: open the tournament's
              profile to see the actual names already registered (the detail
              page lists manager-entered players). A new tab so the modal's
              selection isn't lost. */}
          <a
            href={`/tournaments/${encodeURIComponent(selectedTournament.id)}`}
            target="_blank"
            rel="noreferrer"
            className="inline-block mt-[8px] text-[11.5px] font-semibold no-underline hover:underline"
            style={{ color: 'var(--accent)' }}
          >
            See who&apos;s already entered →
          </a>
        </div>
      )}
    </Modal>
  );
}

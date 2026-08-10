'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  PlannerWeekDto,
  PlayerProfileDto,
  RankingBand,
  TrainingFocus,
  TrainingScheduleWeekDto,
  fetchEntryPlanner,
  fetchPlayerProfile,
  fetchTrainingSchedule,
  setTrainingScheduleEntry,
} from '../../../lib/api';
import { Sidebar } from '../../../components/Sidebar';
import { EnterTournamentModal } from '../../../components/EnterTournamentModal';
import {
  WEEKS_PER_SEASON,
  avatarColorFor,
  flagFor,
  initialsFor,
  stageLabel,
  stageMeta,
  tournamentHistoryResultLabel,
} from '../../../lib/format';

const SURFACE_COLOR: Record<string, string> = {
  clay: 'oklch(58% 0.14 45)',
  grass: 'oklch(52% 0.12 142)',
  hard: 'oklch(55% 0.13 240)',
  indoor: 'oklch(48% 0.05 300)',
};

const JUNIOR_BADGE = { bg: 'oklch(90% 0.1 240)', fg: 'oklch(35% 0.14 240)' };
const ACHIEVEMENT_BADGE = { bg: 'oklch(88% 0.13 75)', fg: 'oklch(38% 0.16 60)' };

const BAND_LABEL: Record<RankingBand, string> = { senior: 'Senior', u14: 'U14', u16: 'U16' };

const HISTORY_PAGE_SIZE = 8;

// Same focus-picker reference data / helpers as the roster dashboard's
// "Set focus" dropdown (app/page.tsx) — deliberately not extracted to
// a shared module, matching this codebase's existing tolerance for
// small duplicated reference data per screen (e.g. SURFACE_COLOR is
// already repeated across several pages).
const FOCUS_GROUPS: Array<{ label: string; options: Array<{ label: string; focus: TrainingFocus }> }> = [
  {
    label: 'Surface',
    options: (['clay', 'grass', 'hard', 'indoor'] as const).map((surface) => ({
      label: surface[0].toUpperCase() + surface.slice(1),
      focus: { kind: 'surface', surface },
    })),
  },
  {
    label: 'Technical',
    options: [
      { label: 'Serve', focus: { kind: 'attribute', attribute: 'serve' } },
      { label: 'Forehand', focus: { kind: 'attribute', attribute: 'forehand' } },
      { label: 'Backhand', focus: { kind: 'attribute', attribute: 'backhand' } },
      { label: 'Volley', focus: { kind: 'attribute', attribute: 'volley' } },
    ],
  },
  {
    label: 'Physical',
    options: [
      { label: 'Speed', focus: { kind: 'attribute', attribute: 'speed' } },
      { label: 'Stamina', focus: { kind: 'attribute', attribute: 'stamina' } },
      { label: 'Strength', focus: { kind: 'attribute', attribute: 'strength' } },
    ],
  },
];

function trainingFocusLabel(focus: TrainingFocus | null): string {
  if (!focus) return 'No focus';
  if (focus.kind === 'surface') return focus.surface[0].toUpperCase() + focus.surface.slice(1);
  return focus.attribute[0].toUpperCase() + focus.attribute.slice(1);
}

function focusEquals(a: TrainingFocus | null, b: TrainingFocus): boolean {
  if (!a) return false;
  if (a.kind !== b.kind) return false;
  return a.kind === 'surface' && b.kind === 'surface' ? a.surface === b.surface : (a as { attribute: string }).attribute === (b as { attribute: string }).attribute;
}

function NetDivider({ className }: { className?: string }) {
  return (
    <div className={`flex items-center gap-0 my-[2px] ${className ?? 'mb-[18px]'}`}>
      <div className="w-px h-[9px]" style={{ background: 'oklch(35% 0.006 75)' }} />
      <div className="flex-1 h-[1.5px]" style={{ background: 'oklch(50% 0.006 75)' }} />
      <div className="w-px h-[9px]" style={{ background: 'oklch(35% 0.006 75)' }} />
      <div className="flex-1 h-[1.5px]" style={{ background: 'oklch(50% 0.006 75)' }} />
      <div className="w-px h-[9px]" style={{ background: 'oklch(35% 0.006 75)' }} />
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[13px] font-bold tracking-[0.2px] mb-[10px]" style={{ color: 'oklch(25% 0.006 75)' }}>
      {children}
    </div>
  );
}

/** Which bands to show in "current standing" — senior always; a junior
 * band otherwise only when it's this player's live band right now, or
 * it's "historically relevant" (a real ranked position or a peak ever
 * recorded there) — both facts already present on the DTO, no
 * additional backend field needed for this rule. */
function visibleCurrentBands(profile: PlayerProfileDto): RankingBand[] {
  const bands: RankingBand[] = ['senior'];
  for (const band of ['u14', 'u16'] as const) {
    const current = profile.currentRankings.find((r) => r.band === band);
    const hasPeak = profile.peakRankings.some((p) => p.band === band);
    if (band === profile.currentEligibleBand || (current && current.rank !== null) || hasPeak) {
      bands.push(band);
    }
  }
  return bands;
}

export default function PlayerProfilePage() {
  const params = useParams<{ id: string }>();
  const playerId = params.id;
  const [profile, setProfile] = useState<PlayerProfileDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyShown, setHistoryShown] = useState(HISTORY_PAGE_SIZE);

  // Schedule section (Step 2): two existing, separate backend reads —
  // the tournament entry planner and the new training-schedule planner
  // — combined into one per-week timeline here on the frontend, not a
  // new backend concept (see PlayerTrainingScheduleQuery's own doc
  // comment). Both default to the same DEFAULT_PLANNER_WEEKS window
  // starting at the world's current week, so they line up week-for-week.
  const [plannerWeeks, setPlannerWeeks] = useState<PlannerWeekDto[] | null>(null);
  const [scheduleWeeks, setScheduleWeeks] = useState<TrainingScheduleWeekDto[] | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [openFocusMenuWeek, setOpenFocusMenuWeek] = useState<number | null>(null);
  const [enterModalWeek, setEnterModalWeek] = useState<number | null>(null);
  const [busyWeek, setBusyWeek] = useState<number | null>(null);

  useEffect(() => {
    fetchPlayerProfile(playerId)
      .then(setProfile)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [playerId]);

  const loadSchedule = useCallback(() => {
    Promise.all([fetchEntryPlanner(playerId), fetchTrainingSchedule(playerId)])
      .then(([planner, schedule]) => {
        setPlannerWeeks(planner);
        setScheduleWeeks(schedule);
      })
      .catch((e) => setScheduleError(e instanceof Error ? e.message : String(e)));
  }, [playerId]);

  useEffect(() => {
    loadSchedule();
  }, [loadSchedule]);

  const scheduleByWeekKey = useMemo(() => {
    const map = new Map<string, TrainingScheduleWeekDto>();
    scheduleWeeks?.forEach((w) => map.set(`${w.week.season}-${w.week.week}`, w));
    return map;
  }, [scheduleWeeks]);

  async function handleSelectFocus(weekIndex: number, week: { season: number; week: number }, focus: TrainingFocus) {
    if (!profile?.managerId) return;
    setOpenFocusMenuWeek(null);
    setBusyWeek(weekIndex);
    try {
      await setTrainingScheduleEntry(playerId, focus, week, profile.managerId);
      loadSchedule();
    } catch (e) {
      setScheduleError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyWeek(null);
    }
  }

  const currentBands = useMemo(() => (profile ? visibleCurrentBands(profile) : []), [profile]);

  if (error) {
    return (
      <div className="flex min-h-screen text-[oklch(22%_0.006_75)] font-sans" style={{ background: 'oklch(98% 0.004 75)' }}>
        <Sidebar active="roster" />
        <div className="flex-1 p-8">
          <div className="text-[13px] rounded-[6px] px-3 py-2" style={{ color: 'oklch(45% 0.16 25)', background: 'oklch(95% 0.03 25)' }}>
            {error}
          </div>
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="flex min-h-screen text-[oklch(22%_0.006_75)] font-sans" style={{ background: 'oklch(98% 0.004 75)' }}>
        <Sidebar active="roster" />
        <div className="flex-1 p-8 text-[13.5px]" style={{ color: 'oklch(50% 0.006 75)' }}>
          Loading player…
        </div>
      </div>
    );
  }

  const stg = stageMeta(profile.stage);
  const visibleHistory = profile.tournamentHistory.slice(0, historyShown);
  const hasMoreHistory = historyShown < profile.tournamentHistory.length;

  return (
    <div className="flex min-h-screen text-[oklch(22%_0.006_75)] font-sans" style={{ background: 'oklch(98% 0.004 75)' }}>
      <Sidebar active="roster" />

      <div className="flex-1 p-8 max-w-[860px] min-w-0">
        <Link href="/" className="text-[13px] font-semibold no-underline hover:underline" style={{ color: 'oklch(45% 0.12 240)' }}>
          ← Back to roster
        </Link>

        {/* Header */}
        <div className="flex items-center gap-4 mt-[14px] mb-[18px]">
          <div
            className="w-[64px] h-[64px] flex-none rounded-[8px] flex items-center justify-center text-white font-bold text-[22px]"
            style={{ background: avatarColorFor(profile.playerId) }}
          >
            {initialsFor(profile.name)}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-[10px]">
              <div className="text-[23px] font-bold tracking-[-0.2px]">{profile.name}</div>
              <div
                className="inline-block px-[9px] py-[3px] rounded-[4px] text-[11px] font-bold tracking-[0.3px]"
                style={{ background: stg.bg, color: stg.fg }}
              >
                {stageLabel(profile.stage)}
              </div>
            </div>
            <div className="text-[13.5px] mt-[4px] flex items-center gap-[7px]" style={{ color: 'oklch(48% 0.006 75)' }}>
              <span>{flagFor(profile.nationality)}</span>
              {profile.nationality} · Age {(profile.ageInWeeks / WEEKS_PER_SEASON).toFixed(1)}
            </div>
          </div>
        </div>

        <NetDivider />

        {/* Current standing */}
        <SectionLabel>Current standing</SectionLabel>
        <div className="flex gap-[10px] mb-[22px]">
          {currentBands.map((band) => {
            const entry = profile.currentRankings.find((r) => r.band === band)!;
            return (
              <div key={band} className="flex-1 bg-white rounded-[8px] p-[14px]" style={{ border: '1px solid oklch(90% 0.005 75)' }}>
                <div className="flex items-center gap-[6px] mb-[6px]">
                  <div className="text-[11px] font-bold tracking-[0.4px] uppercase" style={{ color: 'oklch(52% 0.006 75)' }}>
                    {BAND_LABEL[band]}
                  </div>
                  {band !== 'senior' && (
                    <div
                      className="text-[9.5px] font-bold tracking-[0.3px] uppercase px-[5px] py-[1.5px] rounded-[3px]"
                      style={{ background: JUNIOR_BADGE.bg, color: JUNIOR_BADGE.fg }}
                    >
                      {band}
                    </div>
                  )}
                </div>
                <div className="text-[24px] font-bold [font-variant-numeric:tabular-nums]">
                  {entry.rank !== null ? `#${entry.rank}` : '—'}
                </div>
                <div className="text-[11.5px]" style={{ color: 'oklch(52% 0.006 75)' }}>
                  {entry.totalPoints} pts
                </div>
              </div>
            );
          })}
        </div>

        {/* Peak standing */}
        <SectionLabel>Peak standing</SectionLabel>
        {profile.peakRankings.length === 0 ? (
          <div className="text-[13px] mb-[22px]" style={{ color: 'oklch(52% 0.006 75)' }}>
            No peak ranking yet.
          </div>
        ) : (
          <div className="flex gap-[10px] mb-[22px]">
            {profile.peakRankings.map((p) => (
              <div
                key={p.band}
                className="flex-1 rounded-[8px] p-[14px]"
                style={{ background: 'oklch(97% 0.03 75)', border: '1px solid oklch(88% 0.08 70)' }}
              >
                <div className="flex items-center gap-[6px] mb-[6px]">
                  <div className="text-[11px] font-bold tracking-[0.4px] uppercase" style={{ color: 'oklch(48% 0.1 65)' }}>
                    Peak · {BAND_LABEL[p.band]}
                  </div>
                </div>
                <div className="text-[24px] font-bold [font-variant-numeric:tabular-nums]" style={{ color: 'oklch(35% 0.1 60)' }}>
                  {p.peakPoints} pts
                </div>
                <div className="text-[11.5px]" style={{ color: 'oklch(48% 0.1 65)' }}>
                  Peaked Season {p.peakAsOfWeek.season}, Week {p.peakAsOfWeek.week}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Titles */}
        <SectionLabel>Titles</SectionLabel>
        {profile.titles.length === 0 ? (
          <div className="text-[13px] mb-[22px]" style={{ color: 'oklch(52% 0.006 75)' }}>
            No titles yet.
          </div>
        ) : (
          <div className="flex flex-col gap-[8px] mb-[22px]">
            {profile.titles.map((title) => (
              <Link
                key={title.tournamentId}
                href={`/tournaments/${title.tournamentId}`}
                className="flex items-center justify-between rounded-[8px] px-[14px] py-[11px] no-underline hover:opacity-90"
                style={{ background: ACHIEVEMENT_BADGE.bg, color: ACHIEVEMENT_BADGE.fg }}
              >
                <div className="flex items-center gap-[10px] min-w-0">
                  <span className="text-[16px]">🏆</span>
                  <div className="font-semibold text-[13.5px] overflow-hidden text-ellipsis whitespace-nowrap">{title.name}</div>
                  {title.ageBand && (
                    <div
                      className="text-[9.5px] font-bold tracking-[0.3px] uppercase px-[5px] py-[1.5px] rounded-[3px] flex-none"
                      style={{ background: JUNIOR_BADGE.bg, color: JUNIOR_BADGE.fg }}
                    >
                      {title.ageBand}
                    </div>
                  )}
                </div>
                <div className="text-[11.5px] font-semibold flex-none">
                  {title.tier} · S{title.weekEarned.season} W{title.weekEarned.week}
                </div>
              </Link>
            ))}
          </div>
        )}

        <NetDivider />

        {/* Schedule — combined frontend view over two existing, separate
            backend reads (tournament entry planner + training schedule),
            not a new backend concept. Same lookahead window as the
            tournament planner elsewhere in this app. */}
        <SectionLabel>Schedule</SectionLabel>
        {!profile.managerId && (
          <div className="text-[12px] mb-[10px]" style={{ color: 'oklch(52% 0.006 75)' }}>
            Free agent — no manager to schedule tournaments or training for.
          </div>
        )}
        {scheduleError && (
          <div className="mb-3 text-[12.5px] rounded-[6px] px-3 py-2" style={{ color: 'oklch(45% 0.16 25)', background: 'oklch(95% 0.03 25)' }}>
            {scheduleError}
          </div>
        )}
        {plannerWeeks === null && !scheduleError && (
          <div className="text-[13px] mb-[22px]" style={{ color: 'oklch(52% 0.006 75)' }}>
            Loading schedule…
          </div>
        )}
        {plannerWeeks && (
          <div className="flex flex-col gap-[8px] mb-[22px]">
            {plannerWeeks.map((pw, i) => {
              const weekKey = `${pw.week.season}-${pw.week.week}`;
              const sw = scheduleByWeekKey.get(weekKey);
              const busy = busyWeek === i;
              return (
                <div
                  key={weekKey}
                  className="flex items-center gap-[12px] bg-white rounded-[8px] px-[14px] py-[11px]"
                  style={{ border: '1px solid oklch(90% 0.005 75)', opacity: busy ? 0.6 : 1 }}
                >
                  <div className="text-[11.5px] font-semibold flex-none" style={{ color: 'oklch(48% 0.006 75)', width: 76 }}>
                    S{pw.week.season} W{pw.week.week}
                  </div>

                  {/* Tournament entry — reuses the existing registration
                      flow (EnterTournamentModal) rather than a new one. */}
                  <div className="flex-1 min-w-0">
                    {pw.entries.length > 0 ? (
                      <div className="flex flex-col gap-[3px]">
                        {pw.entries.map((t) => (
                          <Link
                            key={t.id}
                            href={`/tournaments/${t.id}`}
                            className="text-[12.5px] font-semibold no-underline hover:underline overflow-hidden text-ellipsis whitespace-nowrap block"
                            style={{ color: 'oklch(28% 0.006 75)' }}
                          >
                            {t.name}
                          </Link>
                        ))}
                      </div>
                    ) : profile.managerId ? (
                      <button
                        onClick={() => setEnterModalWeek(i)}
                        disabled={busy}
                        className="text-[11.5px] font-semibold cursor-pointer rounded-[5px] px-[8px] py-[4px] disabled:cursor-not-allowed"
                        style={{ border: '1px solid oklch(85% 0.006 75)', color: 'oklch(45% 0.006 75)' }}
                      >
                        + Enter tournament
                      </button>
                    ) : (
                      <span className="text-[11.5px]" style={{ color: 'oklch(60% 0.006 75)' }}>
                        —
                      </span>
                    )}
                  </div>

                  {/* Training focus — resolved from the training
                      schedule; editable inline via the same dropdown
                      shape the roster dashboard already uses. */}
                  <div className="relative flex-none" style={{ width: 150 }}>
                    <button
                      onClick={() => profile.managerId && setOpenFocusMenuWeek(openFocusMenuWeek === i ? null : i)}
                      disabled={!profile.managerId || busy}
                      className="w-full text-left rounded-[6px] px-[10px] py-[6px] text-[12px] font-semibold cursor-pointer flex items-center justify-between gap-[6px] disabled:cursor-not-allowed"
                      style={{ background: 'oklch(97% 0.003 75)', border: '1px solid oklch(88% 0.006 75)', color: 'oklch(28% 0.006 75)' }}
                    >
                      <span className="flex items-center gap-[5px] overflow-hidden text-ellipsis whitespace-nowrap">
                        {trainingFocusLabel(sw?.focus ?? null)}
                        {sw?.isExplicit && (
                          <span className="text-[9px] font-bold flex-none" style={{ color: 'oklch(55% 0.13 240)' }} title="Explicit entry for this week">
                            ●
                          </span>
                        )}
                      </span>
                      <span className="text-[10px] flex-none" style={{ color: 'oklch(55% 0.006 75)' }}>
                        ▾
                      </span>
                    </button>
                    {openFocusMenuWeek === i && (
                      <div
                        className="absolute top-[calc(100%+4px)] right-0 min-w-[170px] max-h-[260px] overflow-y-auto bg-white rounded-[6px] z-10 py-1"
                        style={{ border: '1px solid oklch(88% 0.006 75)', boxShadow: '0 4px 14px rgba(0,0,0,0.1)' }}
                      >
                        {FOCUS_GROUPS.map((grp, gi) => (
                          <div key={grp.label} style={gi > 0 ? { borderTop: '1px solid oklch(93% 0.004 75)' } : undefined}>
                            <div
                              className="px-[10px] pt-[6px] pb-[3px] text-[10px] font-bold tracking-[0.5px] uppercase"
                              style={{ color: 'oklch(55% 0.006 75)' }}
                            >
                              {grp.label}
                            </div>
                            {grp.options.map((opt) => (
                              <div
                                key={opt.label}
                                onClick={() => handleSelectFocus(i, pw.week, opt.focus)}
                                className="flex items-center justify-between px-[10px] py-[6px] text-[12px] cursor-pointer hover:bg-[oklch(96%_0.003_75)]"
                                style={{ color: 'oklch(28% 0.006 75)' }}
                              >
                                {opt.label}
                                {focusEquals(sw?.focus ?? null, opt.focus) && (
                                  <span className="font-bold" style={{ color: 'oklch(55% 0.13 240)' }}>
                                    ✓
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {enterModalWeek !== null && profile.managerId && (
          <EnterTournamentModal
            playerId={profile.playerId}
            playerName={profile.name}
            managerId={profile.managerId}
            onClose={() => setEnterModalWeek(null)}
            onEntered={() => {
              setEnterModalWeek(null);
              loadSchedule();
            }}
          />
        )}

        <NetDivider />

        {/* Tournament history */}
        <SectionLabel>Tournament history</SectionLabel>
        {profile.tournamentHistory.length === 0 ? (
          <div className="text-[13px]" style={{ color: 'oklch(52% 0.006 75)' }}>
            No tournament entries yet.
          </div>
        ) : (
          <div className="flex flex-col gap-[8px]">
            {visibleHistory.map((entry) => (
              <Link
                key={entry.tournamentId}
                href={`/tournaments/${entry.tournamentId}`}
                className="flex items-center justify-between bg-white rounded-[8px] px-[14px] py-[11px] no-underline"
                style={{ border: '1px solid oklch(90% 0.005 75)', color: 'inherit' }}
              >
                <div className="flex items-center gap-[10px] min-w-0">
                  <div
                    className="text-[10px] font-bold tracking-[0.4px] uppercase px-[7px] py-[3px] rounded-[4px] text-white flex-none"
                    style={{ background: SURFACE_COLOR[entry.surface] ?? 'oklch(50% 0.006 75)' }}
                  >
                    {entry.surface}
                  </div>
                  {entry.ageBand && (
                    <div
                      className="text-[9.5px] font-bold tracking-[0.3px] uppercase px-[5px] py-[1.5px] rounded-[3px] flex-none"
                      style={{ background: JUNIOR_BADGE.bg, color: JUNIOR_BADGE.fg }}
                    >
                      {entry.ageBand}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="font-semibold text-[13.5px] overflow-hidden text-ellipsis whitespace-nowrap">{entry.name}</div>
                    <div className="text-[11px]" style={{ color: 'oklch(52% 0.006 75)' }}>
                      {entry.tier} · {entry.drawSize}-draw · Season {entry.weekScheduled.season}, Week {entry.weekScheduled.week}
                    </div>
                  </div>
                </div>
                <div className="text-[12px] font-semibold flex-none" style={{ color: entry.won ? 'oklch(38% 0.16 60)' : 'oklch(45% 0.006 75)' }}>
                  {tournamentHistoryResultLabel(entry)}
                </div>
              </Link>
            ))}
          </div>
        )}

        {hasMoreHistory && (
          <button
            onClick={() => setHistoryShown((n) => n + HISTORY_PAGE_SIZE)}
            className="w-full mt-[10px] py-[9px] rounded-[6px] text-[12.5px] font-semibold cursor-pointer hover:bg-[oklch(96%_0.003_75)]"
            style={{ border: '1px solid oklch(85% 0.006 75)', color: 'oklch(28% 0.006 75)' }}
          >
            Show more ({profile.tournamentHistory.length - historyShown} more)
          </button>
        )}
      </div>
    </div>
  );
}

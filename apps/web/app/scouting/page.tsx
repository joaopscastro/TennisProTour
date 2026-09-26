'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  TalentPoolCandidateDto,
  WorldClockDto,
  claimTalentPoolCandidate,
  fetchTalentPool,
  fetchWorldClock,
} from '../../lib/api';
import { AppShell } from '../../components/ui/AppShell';
import { PageShell, Button, StatBar, Flag } from '../../components/ui/primitives';
import { Tabs } from '../../components/ui/Tabs';
import { Icon } from '../../components/ui/Icon';
import { CelebrationMoment, CelebrationOverlay } from '../../components/ui/Celebration';
import { useCountdown, formatCountdown } from '../../lib/useCountdown';
import { useDevManagerId } from '../../lib/managerContext';
import { useEntitlement } from '../../lib/entitlement';
import { xpAffordability } from '../../lib/xp';
import { disambiguatedNames, formatMoney, WEEKS_PER_SEASON } from '../../lib/format';
import { titleSummaryLabel } from '../../lib/titles';

function overallOf(c: TalentPoolCandidateDto): number {
  const { technical, physical, mental } = c.attributes;
  const all = [...Object.values(technical), ...Object.values(physical), ...Object.values(mental)];
  return Math.round(all.reduce((sum, v) => sum + v, 0) / all.length);
}

/** Mean of one attribute cluster (technical / physical / mental) — the
 * compact, OBSERVABLE summary the table column shows. Derived only from
 * current attributes; nothing hidden (no ceiling, no grade) can leak. */
function clusterAverage(cluster: Record<string, number>): number {
  const values = Object.values(cluster);
  return Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
}

/** The table's attribute summary column: one mono figure per cluster,
 * labelled T·P·M. The full per-attribute bars stay one row-expand away. */
function AttributeSummary({ attributes }: { attributes: TalentPoolCandidateDto['attributes'] }) {
  const clusters: Array<[string, Record<string, number>]> = [
    ['T', attributes.technical],
    ['P', attributes.physical],
    ['M', attributes.mental],
  ];
  return (
    <span className="num" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
      {clusters.map(([label, cluster], i) => (
        <span key={label}>
          {i > 0 && <span style={{ color: 'var(--ink-4)' }}> · </span>}
          <span style={{ color: 'var(--ink-3)' }}>{label}</span>{' '}
          <span style={{ color: 'var(--ink-2)' }}>{clusterAverage(cluster)}</span>
        </span>
      ))}
    </span>
  );
}

/** How the free-agent table is ordered. "Youngest" is the long-standing
 * default (see the "youngest first" copy) — the other two are the
 * comparison axes a scout actually weighs a prospect on. Sorted
 * client-side over data the DTO already carries; no new query. */
type ScoutSort = 'youngest' | 'overall' | 'cost';

/** A compact per-attribute snapshot so two prospects can be compared
 * without opening each profile — held in the row's expanded <tr>.
 * Deliberately only CURRENT attributes — hidden potential/ceilings stay
 * profile-only by design (see talentPoolRoutes' DTO note); nothing here
 * can leak a ceiling. */
function AttributeSnapshot({ attributes }: { attributes: TalentPoolCandidateDto['attributes'] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px 18px' }}>
      {Object.entries(attributes.technical).map(([name, value]) => (
        <StatBar key={`t-${name}`} label={name} value={value} />
      ))}
      {Object.entries(attributes.physical).map(([name, value]) => (
        <StatBar key={`p-${name}`} label={name} value={value} />
      ))}
      {Object.entries(attributes.mental).map(([name, value]) => (
        <StatBar key={`m-${name}`} label={name} value={value} />
      ))}
    </div>
  );
}

/** The Scouting table pages the pool 48 rows at a time. */
const TALENT_POOL_PAGE_SIZE = 48;

/** The filter-independent counts the server sends with every page — see
 * TalentPoolPageDto. Kept separate from `candidates` so "Show more" can
 * append without losing the honest totals. */
interface PoolMeta {
  total: number;
  poolTotal: number;
  availableTotal: number;
}

export default function ScoutingPage() {
  const devManagerId = useDevManagerId();
  const [managerId, setManagerId] = useState(devManagerId ?? '');
  const [managerIdInput, setManagerIdInput] = useState(devManagerId ?? '');
  const { entitlement, refresh: refreshEntitlement } = useEntitlement(managerId);
  const [candidates, setCandidates] = useState<TalentPoolCandidateDto[] | null>(null);
  const [poolMeta, setPoolMeta] = useState<PoolMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [claimedOutId, setClaimedOutId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [worldClock, setWorldClock] = useState<WorldClockDto | null>(null);
  const [celebrations, setCelebrations] = useState<CelebrationMoment[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sortBy, setSortBy] = useState<ScoutSort>('youngest');
  // Which rows are expanded to show their full attribute bars. A Set (not a
  // single id) so two prospects can be compared side by side, which is the
  // whole point of the row-expand pattern; toggling is per row and the
  // state deliberately survives sorting and filtering.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  // The pool deliberately spans raw teenagers to match-hardened veterans,
  // and the youngest are exactly the ones a junior draw pulls in — so the
  // default "Youngest" sort used to open on a page that was ~92%
  // "Unavailable" (measured: 44 blocked / 4 signable). This filter
  // defaults ON so a first-time manager sees a useful list, while the
  // committed players are only one click away (never hidden permanently).
  // Since P1-A2 it is a REAL server-side filter (`signableOnly=true`),
  // not a client-side view of an already-downloaded pool.
  const [availableOnly, setAvailableOnly] = useState(true);
  // How many rows are already loaded, so "Show more" can ask for the next
  // offset without depending on (and re-triggering on) `candidates`.
  const loadedRef = useRef(0);

  const load = useCallback(async (mode: 'reset' | 'more') => {
    setError(null);
    if (mode === 'more') setLoadingMore(true);
    try {
      const offset = mode === 'more' ? loadedRef.current : 0;
      const page = await fetchTalentPool({
        limit: TALENT_POOL_PAGE_SIZE,
        offset,
        signableOnly: availableOnly,
      });
      loadedRef.current = offset + page.candidates.length;
      setCandidates((prev) => (mode === 'more' ? [...(prev ?? []), ...page.candidates] : page.candidates));
      setPoolMeta({ total: page.total, poolTotal: page.poolTotal, availableTotal: page.availableTotal });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mode === 'more') setLoadingMore(false);
    }
  }, [availableOnly]);

  const loadClock = useCallback(() => {
    fetchWorldClock()
      .then(setWorldClock)
      .catch(() => setWorldClock(null));
  }, []);

  // Re-read the clock AND the pool when the weekly rollover arrives or the
  // tab regains focus. At the compressed 2h/day production cadence, a
  // fetch-once countdown would hit zero and stick in any tab left open —
  // and with the rollover having passed, the pool itself has changed.
  const refreshClockAndPool = useCallback(() => {
    loadClock();
    void load('reset');
  }, [loadClock, load]);

  useEffect(() => {
    refreshClockAndPool();
    const onVisible = () => { if (document.visibilityState === 'visible') refreshClockAndPool(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refreshClockAndPool]);

  // The talent pool refreshes on the weekly rollover only (the
  // RefreshTalentPoolUseCase runs inside advance-world-week, gated on
  // weekRolledOver), NOT on every day tick — so this counts down to
  // nextWeekTickAt (the next day-7 -> day-1 rollover), not nextTickAt.
  const refreshRemainingMs = useCountdown(worldClock?.nextWeekTickAt ?? null, refreshClockAndPool);

  function showNotice(text: string) {
    setNotice(text);
    setTimeout(() => setNotice((current) => (current === text ? null : current)), 4000);
  }

  function toggleExpanded(id: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleClaim(candidateId: string, name: string) {
    const claimed = candidates?.find((c) => c.id === candidateId) ?? null;
    // No mid-tournament confirm step any more: the rule now forbids
    // signing a committed free agent outright (see blockingCommitment), so
    // there is no "inherit the draw" to disclose — blocked candidates never
    // reach this function (their Sign button is disabled).
    setClaimingId(candidateId);
    setError(null);
    try {
      await claimTalentPoolCandidate(candidateId, managerId);
      // Fade the row out before it leaves the board, so the sign never
      // happens as a silent list mutation.
      setClaimedOutId(candidateId);
      const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      await new Promise((r) => setTimeout(r, reduce ? 0 : 560));
      showNotice(`Signed ${name} — welcome to the academy.`);
      await load('reset');
      await refreshEntitlement();
      // A signing is a real event, not a silent list row — fire a claim
      // celebration (GC-16), scaled off the OBSERVABLE current OVR only
      // (potential is hidden in this RPG and must never leak, even here).
      if (claimed) {
        setCelebrations([
          {
            kind: 'claim',
            playerId: claimed.id,
            playerName: claimed.name,
            nationality: claimed.nationality,
            overall: overallOf(claimed),
          },
        ]);
      }
    } catch (e) {
      // A lost claim race is a real, expected outcome (another manager signed
      // them first — atomic claimAndCharge refuses the loser with a 409), not a
      // silent no-op. Say so plainly AND refresh the pool so the stale row
      // disappears with an explanation, instead of leaving the agent to guess
      // why nothing happened. Every other failure surfaces the server's own
      // message rather than swallowing it.
      const status = (e as { status?: number }).status;
      const serverMessage = e instanceof Error ? e.message : String(e);
      // A 409 is either a lost claim race OR the commitment rule refusing
      // the signing (e.g. the draw seeded between page load and click).
      // Both are conflicts, but only one means "someone beat you" — report
      // the server's own plain-language reason for the commitment case.
      const message =
        status === 409 && /unfinished tournament/i.test(serverMessage)
          ? serverMessage
          : status === 409
          ? `Another manager signed ${name} first — they're no longer available. The pool has been refreshed.`
          : `Couldn't sign ${name}: ${serverMessage}`;
      setError(message);
      showNotice(message);
      await load('reset');
    } finally {
      setClaimingId(null);
      setClaimedOutId(null);
    }
  }

  // `null` (not 0!) until the entitlement has loaded — see lib/xp.ts.
  // `?? 0` here was the false-"0 XP" race: it showed an empty balance and
  // disabled every Sign button until a reload won the fetch.
  const xpBalance = entitlement?.xpBalance ?? null;

  // The signable-only view is a SERVER filter now (see load): the page
  // only ever holds signable rows when toggled on, so no client-side
  // re-filtering is needed or possible (a blocked row is not downloaded).
  const availableCount = poolMeta?.availableTotal ?? 0;
  const poolTotalCount = poolMeta?.poolTotal ?? 0;
  const filteredTotal = poolMeta?.total ?? 0;

  // "Youngest" stays the default (and the backend already returns the
  // pool youngest-first), so this only re-orders the LOADED rows when
  // the scout picks another axis. Ties fall back to age so the order is
  // stable.
  // Two distinct free agents can share a full name (finite generator
  // pool), which read as a duplicate bug on the grid. Disambiguate over
  // the loaded rows, so names on the same page can never collide.
  const displayNames = useMemo(() => disambiguatedNames(candidates ?? []), [candidates]);

  const sortedCandidates = useMemo(() => {
    const copy = [...(candidates ?? [])];
    if (sortBy === 'overall') copy.sort((a, b) => overallOf(b) - overallOf(a) || a.ageInWeeks - b.ageInWeeks);
    else if (sortBy === 'cost') copy.sort((a, b) => a.claimCost - b.claimCost || a.ageInWeeks - b.ageInWeeks);
    else copy.sort((a, b) => a.ageInWeeks - b.ageInWeeks);
    return copy;
  }, [candidates, sortBy]);

  return (
    <AppShell active="scouting" tier={entitlement?.tier} xpBalance={entitlement?.xpBalance}>
      {celebrations.length > 0 && (
        <CelebrationOverlay moments={celebrations} onClose={() => setCelebrations([])} />
      )}

      <PageShell>
        {/* Page header — flat, no hero band/wash (Direction A). */}
        <div>
          <div className="t-label">The Talent Pool</div>
          <h1 className="t-h1" style={{ margin: '4px 0 0' }}>Scouting</h1>
          <div className="t-body-sm" style={{ marginTop: 4 }}>
            One shared pool of <strong style={{ color: 'var(--ink)' }}>free agents</strong> — from raw teenagers to established, match-hardened players of every age. Every manager sees the same faces and races to sign them first.
          </div>
        </div>

        {!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && (
          <form
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, fontSize: 11.5, color: 'var(--ink-4)', marginTop: 12 }}
            onSubmit={(e) => { e.preventDefault(); setManagerId(managerIdInput.trim() || managerId); }}
          >
            Manager ID (dev)
            <input className="gc-input" style={{ padding: '5px 9px', fontSize: 12 }} value={managerIdInput} onChange={(e) => setManagerIdInput(e.target.value)} />
          </form>
        )}

        {error && (
          <div
            className="gc-notice"
            style={{
              marginTop: 16,
              color: 'var(--loss)',
              borderColor: 'color-mix(in srgb, var(--loss) 35%, transparent)',
              background: 'color-mix(in srgb, var(--loss) 10%, transparent)',
            }}
          >
            {error}
          </div>
        )}

        {candidates === null && !error && (
          <div style={{ marginTop: 24, fontSize: 13.5, color: 'var(--ink-3)' }}>Loading talent pool…</div>
        )}

        {candidates !== null && filteredTotal === 0 && (
          <div className="gc-panel" style={{ marginTop: 20, padding: '60px 40px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            {poolTotalCount > 0 ? (
              <>
                <div style={{ fontSize: 16, fontWeight: 700 }}>No free agents available to sign right now</div>
                <div style={{ fontSize: 13, color: 'var(--ink-3)', maxWidth: 480, lineHeight: 1.5 }}>
                  All {poolTotalCount} free agent{poolTotalCount === 1 ? '' : 's'} in the pool {poolTotalCount === 1 ? 'is' : 'are'} committed to a tournament that hasn&apos;t concluded. They become signable once it does.
                </div>
                <Button variant="ghost" onClick={() => setAvailableOnly(false)}>
                  Show everyone ({poolTotalCount})
                </Button>
              </>
            ) : (
              <>
                <div style={{ fontSize: 16, fontWeight: 700 }}>No free agents right now</div>
                <div style={{ fontSize: 13, color: 'var(--ink-3)' }}>Fresh young talent arrives at the next weekly refresh.</div>
              </>
            )}
          </div>
        )}

        {candidates && candidates.length > 0 && (
          <div className="gc-panel" style={{ marginTop: 20 }}>
            <div className="gc-panel-hd">
              <span className="t-label" style={{ color: 'var(--ink-2)' }}>
                {availableOnly ? (
                  <>
                    {availableCount} available of {poolTotalCount} free agent{poolTotalCount === 1 ? '' : 's'}
                  </>
                ) : (
                  <>
                    All {poolTotalCount} free agent{poolTotalCount === 1 ? '' : 's'} · {availableCount} available
                  </>
                )}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {/* The default view is signable-only; committed agents
                    are one click away, never hidden permanently. */}
                <Tabs
                  variant="segmented"
                  items={[
                    { id: 'available', label: 'Available only' },
                    { id: 'all', label: 'All' },
                  ]}
                  active={availableOnly ? 'available' : 'all'}
                  onSelect={(id) => {
                    // Changing the filter re-fetches page 0 server-side
                    // (the load callback's identity changes).
                    setAvailableOnly(id === 'available');
                  }}
                />
                <select
                  className="gc-select"
                  value={sortBy}
                  aria-label="Sort free agents"
                  onChange={(e) => setSortBy(e.target.value as ScoutSort)}
                  style={{ padding: '7px 28px 7px 10px', fontSize: 12 }}
                >
                  <option value="youngest">Sort: Youngest</option>
                  <option value="overall">Sort: Overall rating</option>
                  <option value="cost">Sort: Cheapest to sign</option>
                </select>
              </div>
            </div>

            <div className="gc-panel-bd flush">
              <>
                <table className="gc-table">
                    <thead>
                      <tr>
                        <th>Player</th>
                        <th>Attributes T·P·M</th>
                        <th className="r">OVR</th>
                        <th>Status</th>
                        <th>Career</th>
                        <th className="r">Cost</th>
                        <th className="r">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedCandidates.map((c) => {
                        const busy = claimingId === c.id;
                        const claimedOut = claimedOutId === c.id;
                        // One source for the XP shown and the gating: unknown (not
                        // yet fetched) is its own state, never an assumed 0.
                        const affordability = xpAffordability(xpBalance, c.claimCost);
                        const affordable = affordability.state === 'affordable';
                        const expanded = expandedIds.has(c.id);
                        return (
                          <Fragment key={c.id}>
                            <tr
                              className={`${expanded ? 'is-selected' : ''}${claimedOut ? ' gc-claimed-out' : ''}`}
                              onClick={() => toggleExpanded(c.id)}
                              onKeyDown={(e) => {
                                // Only the row itself toggles — a keypress on the
                                // caret button, name link or Sign button inside
                                // must not double-handle (the caret is a real
                                // button and fires its own click on Enter).
                                if (e.target !== e.currentTarget) return;
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  toggleExpanded(c.id);
                                }
                              }}
                              tabIndex={0}
                              aria-expanded={expanded}
                              style={{ cursor: 'pointer', opacity: busy && !claimedOut ? 0.55 : 1 }}
                            >
                              {/* Identity: expand caret + flag + name + age (mono). */}
                              <td>
                                <div className="gc-pcell">
                                  <button
                                    type="button"
                                    aria-expanded={expanded}
                                    aria-label={expanded ? 'Collapse attributes' : 'Expand attributes'}
                                    onClick={(e) => { e.stopPropagation(); toggleExpanded(c.id); }}
                                    style={{
                                      display: 'grid', placeItems: 'center', padding: 0, width: 16, height: 16,
                                      border: 0, background: 'transparent', color: expanded ? 'var(--accent)' : 'var(--ink-4)', cursor: 'pointer',
                                    }}
                                  >
                                    <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
                                  </button>
                                  <Flag code={c.nationality} />
                                  <div style={{ minWidth: 0 }}>
                                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                                      <a
                                        href={`/players/${c.id}`}
                                        className="nm gc-identity-link"
                                        style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        {displayNames.get(c.id) ?? c.name}
                                      </a>
                                      <span className="ag num">{(c.ageInWeeks / WEEKS_PER_SEASON).toFixed(1)} yrs</span>
                                    </div>
                                  </div>
                                </div>
                              </td>

                              <td><AttributeSummary attributes={c.attributes} /></td>

                              <td className="r"><span className="gc-ovr">{overallOf(c)}</span></td>

                              {/* The ONE "is this agent tied to a live event?"
                                  badge. It reads the tournament-level UNFINISHED
                                  commitment — the same predicate the atomic claim
                                  enforces and the same one the profile banner and
                                  roster use — so the row can never name a
                                  different event than the roster's "Next:" line. */}
                              <td>
                                {c.signingBlocked ? (
                                  <span
                                    className="gc-badge"
                                    title={`Committed to ${c.blockingCommitment?.name ?? 'a tournament'} — a free agent with an unfinished tournament can't be signed until it concludes.`}
                                    style={{ color: 'var(--warn)', borderColor: 'color-mix(in srgb, var(--warn) 45%, transparent)' }}
                                  >
                                    <Icon name="lock" size={11} />
                                    In a draw{c.blockingCommitment ? ` · ${c.blockingCommitment.name}` : ''}
                                  </span>
                                ) : (
                                  <span className="gc-badge" style={{ color: 'var(--win)', borderColor: 'color-mix(in srgb, var(--win) 40%, transparent)' }}>
                                    <Icon name="check" size={11} />
                                    Available
                                  </span>
                                )}
                              </td>

                              {/* Observable career context — a real record, not a
                                  scouting grade. The title line shows the raw
                                  count AND the tier-weighted points together
                                  (never a tier-blind count alone), so a pile of
                                  J30/J60 titles cannot read like a major. */}
                              <td>
                                <span className="num" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, whiteSpace: 'nowrap' }}>
                                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--gold)' }} title="Titles won, and their tier-weighted points (a major weighs 2,000; a J30 weighs 30)">
                                    <Icon name="trophy" size={12} />
                                    <span style={{ color: 'var(--ink-2)' }}>
                                      {titleSummaryLabel({ count: c.titleCount, weight: c.titleWeight, byTier: c.titlesByTier })}
                                    </span>
                                  </span>
                                  <span style={{ color: 'var(--ink-4)' }}>·</span>
                                  <span style={{ color: 'var(--ink-3)' }} title="Career prize money earned on tour">
                                    {formatMoney(c.careerPrizeMoney)} career
                                  </span>
                                </span>
                              </td>

                              <td className="r">
                                <div className="num" style={{ fontSize: 12, fontWeight: 600, color: affordable ? 'var(--accent)' : 'var(--ink-2)', whiteSpace: 'nowrap' }}>
                                  SIGN FOR {c.claimCost.toLocaleString()} XP
                                </div>
                                {affordability.state === 'short' && (
                                  <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--warn)', marginTop: 2 }}>
                                    Need {affordability.remaining.toLocaleString()} more
                                  </div>
                                )}
                              </td>

                              <td className="r">
                                <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                                  {c.signingBlocked && (
                                    <div style={{ fontSize: 10.5, lineHeight: 1.35, color: 'var(--warn)', textAlign: 'right', maxWidth: 190 }}>
                                      Committed to {c.blockingCommitment?.name ?? 'a tournament'} — can&apos;t sign until it concludes.
                                    </div>
                                  )}
                                  <Button
                                    variant="primary"
                                    className="gc-btn--sm"
                                    onClick={(e) => { e.stopPropagation(); handleClaim(c.id, c.name); }}
                                    disabled={claimingId !== null || !affordable || c.signingBlocked}
                                  >
                                    {busy ? 'Signing…' : 'Sign'}
                                  </Button>
                                </div>
                              </td>
                            </tr>
                            {expanded && (
                              <tr>
                                <td colSpan={7} style={{ height: 'auto', padding: '10px 12px', background: 'var(--bg-3)' }}>
                                  <AttributeSnapshot attributes={c.attributes} />
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>

                  {candidates.length < filteredTotal && (
                    <div style={{ display: 'flex', justifyContent: 'center', padding: '14px 0' }}>
                      <Button variant="ghost" disabled={loadingMore} onClick={() => void load('more')}>
                        {loadingMore
                          ? 'Loading…'
                          : `Show more (${filteredTotal - candidates.length} more free agents)`}
                      </Button>
                    </div>
                  )}
                </>

              {/* The pool explanation — the working one-liner stays visible;
                  the full "how signing works" prose is one click away in the
                  <details>, never deleted and never hover-only. */}
              <div className="gc-tbl-note">
                They keep training and competing while unsigned, so some are committed to a tournament right now and can&apos;t be signed until it concludes.
                {worldClock && (
                  <> Fresh young talent arrives in <strong className="num" style={{ color: 'var(--ink-2)' }}>{formatCountdown(refreshRemainingMs)}</strong>.</>
                )}
              </div>
              <details className="gc-details" style={{ margin: '4px 12px 12px' }}>
                <summary>How signing works</summary>
                <div className="t-body-sm" style={{ marginTop: 8, fontSize: 12, lineHeight: 1.55 }}>
                  <div>A scout can tell you what a free agent can do <strong style={{ color: 'var(--ink-2)' }}>today</strong> — never how high they&apos;ll climb.</div>
                  <div style={{ marginTop: 4 }}>There are no rarity labels and no potential grades here: read the raw attributes yourself, weigh the risk, and sign before a rival does.</div>
                  <div style={{ marginTop: 4 }}>Free agents range from raw teenagers to established players with titles and career earnings — a career record on the row is exactly that, not a scouting grade.</div>
                  <div style={{ marginTop: 4 }}>Anyone marked <strong style={{ color: 'var(--ink-2)' }}>In a draw</strong> is committed to a tournament that hasn&apos;t concluded and can&apos;t be signed until it does — a signing is always clean, never inheriting an in-progress draw.</div>
                  <div style={{ marginTop: 4 }}>Open a player&apos;s profile to study the full breakdown.</div>
                </div>
              </details>
            </div>
          </div>
        )}
      </PageShell>

      {notice && (
        <div className="gc-panel gc-pop" style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 40, fontSize: 13, fontWeight: 650, padding: '13px 18px', borderColor: 'var(--accent)' }}>
          {notice}
        </div>
      )}
    </AppShell>
  );
}

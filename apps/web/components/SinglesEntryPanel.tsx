'use client';

import { useState } from 'react';
import {
  RosterDashboardEntryDto,
  TournamentDto,
  fetchOpenTournaments,
  fetchRosterDashboard,
  registerDoublesEntrant,
  registerEntrant,
} from '../lib/api';
import { entryPlacement, tournamentRefusalReason } from '../lib/tournamentPick';
import { Button, Panel, PanelHeader } from './ui/primitives';
import { Icon } from './ui/Icon';

interface Props {
  tournamentId: string;
  /** The owning manager — same identity contract as the doubles control
   * on this page (registerEntrant's doc comment): omitted, the call
   * silently authenticates as the dev default manager. */
  managerId: string;
  /** Called after a successful registration so the page can re-fetch the
   * tournament (and its entry list) — same shape as the doubles control's
   * reload-after-signup. */
  onEntered: (tournament: TournamentDto) => void;
}

/**
 * The tournament page's own SINGLES entry control — the counterpart to the
 * existing "Enter a player in doubles" button, which a naive-user
 * walkthrough found was the ONLY entry control on an open tournament's
 * page (singles entry was reachable only from the separate Planner tab).
 *
 * It reuses the exact same registration flow (`registerEntrant` →
 * POST /tournaments/:id/entrants) and roster read the picker modal and
 * doubles control already use. Eligibility is previewed from the existing
 * player-scoped `GET /tournaments?status=open&playerId=` response (no new
 * backend concept) so an age-band/cap/qualifying refusal is shown before
 * the click, and the server's own refusal is surfaced verbatim if one still
 * slips through.
 */
export function SinglesEntryPanel({ tournamentId, managerId, onEntered }: Props) {
  const [roster, setRoster] = useState<RosterDashboardEntryDto[] | null>(null);
  const [pick, setPick] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // After a successful singles entry: who was entered (for the "also
  // enter doubles" offer), which player the doubles signup would use
  // (partner/roster choice), and the outcome of that follow-up.
  const [enteredPlayerId, setEnteredPlayerId] = useState<string | null>(null);
  const [enteredTournament, setEnteredTournament] = useState<TournamentDto | null>(null);
  const [doublesPlayerId, setDoublesPlayerId] = useState<string>('');
  const [doublesBusy, setDoublesBusy] = useState(false);
  const [doublesNotice, setDoublesNotice] = useState<string | null>(null);

  const activeRoster = (roster ?? []).filter((p) => p.stage !== 'retired');
  const enteredName = activeRoster.find((p) => p.id === enteredPlayerId)?.name ?? 'This player';

  async function openPicker() {
    setError(null);
    if (roster !== null) return;
    try {
      setRoster(await fetchRosterDashboard(managerId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Preview eligibility for THIS tournament from the same player-scoped
   * open list the picker modal reads — the real age-band / weekly-cap /
   * qualifying-field rules, never a client-side guess. If the preview
   * fetch fails we fall back to the server's own enforcement rather than
   * blocking the entry. */
  async function onPick(playerId: string) {
    setPick(playerId);
    setRefusal(null);
    if (!playerId) return;
    setChecking(true);
    try {
      const open = await fetchOpenTournaments(playerId);
      const scoped = open.find((t) => t.id === tournamentId);
      setRefusal(scoped ? tournamentRefusalReason(scoped) : null);
    } catch {
      setRefusal(null);
    } finally {
      setChecking(false);
    }
  }

  async function submit() {
    if (!pick || refusal) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const entered = pick;
      const tournament = await registerEntrant(tournamentId, entered, managerId);
      // Say where the player ACTUALLY landed, not a fixed string: a
      // below-cutoff registrant at a qualifying tier sits in the qualifying
      // field (the entry list shows them as [Q]) and only reaches the main
      // draw by winning through. The returned DTO carries their real draw.
      const placedInQualifying = entryPlacement(tournament.entrants, entered) === 'qualifying';
      setPick('');
      setNotice(
        placedInQualifying
          ? 'Player entered in qualifying — they must win through to the main draw.'
          : 'Player entered in the main draw.',
      );
      // Offer the doubles follow-up for the SAME event: per the weekly cap
      // a player's singles + doubles at one tournament is still one entry,
      // so this is free — say so, and let the manager add the player (or a
      // partner from the roster) without leaving the page.
      setEnteredPlayerId(entered);
      setDoublesPlayerId(entered);
      setEnteredTournament(tournament);
      setDoublesNotice(null);
      onEntered(tournament);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** "Also enter doubles at this event" — calls the same route the page's
   * own doubles control uses (registerDoublesEntrant), now permitted at
   * the senior cap of 1 because the weekly cap counts tournaments, not
   * draws: a singles + doubles entry at the SAME event is one tournament. */
  async function submitDoublesFollowUp() {
    if (!doublesPlayerId) return;
    setDoublesBusy(true);
    setError(null);
    try {
      const updated = await registerDoublesEntrant(tournamentId, doublesPlayerId, managerId);
      setDoublesNotice('Entered in doubles too — still one tournament toward this week’s cap.');
      setEnteredTournament(updated);
      onEntered(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDoublesBusy(false);
    }
  }

  return (
    <Panel style={{ overflow: 'hidden' }}>
      <PanelHeader>Enter singles</PanelHeader>
      <div style={{ padding: 16 }}>
        <div className="t-body-sm" style={{ marginBottom: 10, lineHeight: 1.5 }}>
          Register one of your players into this tournament&apos;s main draw. Below the direct-acceptance cutoff you&apos;ll
          enter through qualifying. Singles and doubles at this same event count as ONE tournament toward the weekly
          entry cap — adding the doubles entry costs no extra week.
        </div>

        <div className="flex items-center gap-[10px] flex-wrap" style={{ marginBottom: 10 }}>
          <Button variant="primary" onClick={openPicker}>
            {roster === null ? 'Enter a player' : 'Choose a player'}
          </Button>
          <Button onClick={submit} disabled={!pick || busy || checking || refusal !== null}>
            {busy ? 'Entering…' : 'Enter'}
          </Button>
        </div>

        {/* A visible option list, deliberately NOT a native <select>: a naive
            walkthrough found the select offered no on-screen options — a user
            needed ArrowDown then Enter to pick, so entering a player was
            impossible with a mouse or touch. Each roster player is its own
            clickable row; the roster cap is tiny (2 free / 4 Pro), so showing
            them all is cheap. */}
        {roster !== null && activeRoster.length > 0 && (
          <div className="flex flex-col gap-[6px]" style={{ marginBottom: 10 }} role="radiogroup" aria-label="Player to enter in singles">
            {activeRoster.map((p) => {
              const selected = pick === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => void onPick(p.id)}
                  className="text-left rounded-[6px] px-[10px] py-[8px] text-[12.5px] font-semibold cursor-pointer"
                  style={{
                    border: selected ? '2px solid var(--accent)' : '1px solid var(--hair)',
                    background: selected ? 'var(--bg-3)' : 'var(--bg-2)',
                    color: 'var(--ink)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <span>{p.name}</span>
                  {selected && (
                    <span className="inline-flex items-center gap-[4px]" style={{ color: 'var(--accent)', fontWeight: 800 }}>
                      <Icon name="check" size={11} /> Selected
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Say WHY Enter is disabled: nothing picked yet (an eligibility
            refusal is shown separately below). */}
        {roster !== null && activeRoster.length > 0 && !pick && (
          <div className="text-[11.5px] mb-[8px]" style={{ color: 'var(--ink-3)' }}>
            Select a player above to enable Enter.
          </div>
        )}

        {roster !== null && activeRoster.length === 0 && (
          <div className="text-[12px]" style={{ color: 'var(--ink-3)' }}>
            This manager has no active roster players to enter.
          </div>
        )}
        {checking && (
          <div className="text-[12px]" style={{ color: 'var(--ink-3)' }}>
            Checking eligibility…
          </div>
        )}
        {refusal && <div className="text-[12px] mb-[8px] font-semibold" style={{ color: 'var(--loss)' }}>Can&apos;t enter: {refusal}</div>}
        {error && <div className="text-[12px] mb-[8px]" style={{ color: 'var(--loss)' }}>{error}</div>}
        {notice && <div className="text-[12px] mb-[8px]" style={{ color: 'var(--win)' }}>{notice}</div>}

        {/* The doubles follow-up offer, shown once a singles entry landed (and
            only when this event even holds a doubles draw). Copy states the
            cap fact explicitly: this is one tournament either way. */}
        {enteredPlayerId && enteredTournament && enteredTournament.doublesDrawSize > 0 && (
          <div className="rounded-[6px] px-3 py-2 mb-3" style={{ border: '1px solid var(--hair)', background: 'var(--bg-2)' }}>
            <div className="text-[12px] font-semibold" style={{ color: 'var(--ink)' }}>
              Also enter doubles at this event — no extra weekly entry
            </div>
            <div className="text-[11.5px] mt-[4px]" style={{ color: 'var(--ink-3)', lineHeight: 1.5 }}>
              {enteredName}&apos;s singles and doubles entries at the same tournament count as one tournament toward
              the weekly cap. Add them — or a partner from your roster — to the {enteredTournament.doublesDrawSize}-pair
              doubles draw.
            </div>
            <div className="flex items-center gap-[8px] flex-wrap mt-[8px]">
              <select
                className="gc-select"
                aria-label="Player to enter in doubles"
                value={doublesPlayerId}
                onChange={(e) => setDoublesPlayerId(e.target.value)}
                style={{ padding: '7px 10px', fontSize: 12.5 }}
              >
                {activeRoster.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <Button onClick={submitDoublesFollowUp} disabled={!doublesPlayerId || doublesBusy}>
                {doublesBusy ? 'Entering…' : 'Enter doubles'}
              </Button>
            </div>
            {doublesNotice && <div className="text-[12px] mt-[6px]" style={{ color: 'var(--win)' }}>{doublesNotice}</div>}
          </div>
        )}

        <div className="text-[11.5px] mt-2" style={{ color: 'var(--ink-3)' }}>
          Planning across several weeks?{' '}
          <a href="/tournaments#planner" style={{ color: 'var(--accent)', fontWeight: 700 }}>
            Open the Planner →
          </a>
        </div>
      </div>
    </Panel>
  );
}

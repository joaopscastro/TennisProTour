'use client';

import { useState } from 'react';
import {
  RosterDashboardEntryDto,
  TournamentDto,
  fetchOpenTournaments,
  fetchRosterDashboard,
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

  const activeRoster = (roster ?? []).filter((p) => p.stage !== 'retired');

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
      const tournament = await registerEntrant(tournamentId, pick, managerId);
      // Say where the player ACTUALLY landed, not a fixed string: a
      // below-cutoff registrant at a qualifying tier sits in the qualifying
      // field (the entry list shows them as [Q]) and only reaches the main
      // draw by winning through. The returned DTO carries their real draw.
      const placedInQualifying = entryPlacement(tournament.entrants, pick) === 'qualifying';
      setPick('');
      setNotice(
        placedInQualifying
          ? 'Player entered in qualifying — they must win through to the main draw.'
          : 'Player entered in the main draw.',
      );
      onEntered(tournament);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel style={{ overflow: 'hidden' }}>
      <PanelHeader>Enter singles</PanelHeader>
      <div style={{ padding: 16 }}>
        <div className="t-body-sm" style={{ marginBottom: 10, lineHeight: 1.5 }}>
          Register one of your players into this tournament&apos;s main draw. Below the direct-acceptance cutoff you&apos;ll
          enter through qualifying.
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

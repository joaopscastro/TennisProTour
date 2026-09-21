'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  RosterDashboardEntryDto,
  TournamentDto,
  fetchOpenTournaments,
  fetchRosterDashboard,
  registerEntrant,
} from '../lib/api';
import { tournamentRefusalReason } from '../lib/tournamentPick';
import { Panel, SectionLabel } from './ui/primitives';

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
      setPick('');
      setNotice('Player entered in the main draw.');
      onEntered(tournament);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel style={{ padding: 18 }}>
      <SectionLabel>Enter singles</SectionLabel>
      <div style={{ fontSize: 11, color: 'var(--gc-ink-mute)', marginTop: 4, marginBottom: 10, lineHeight: 1.5 }}>
        Register one of your players into this tournament&apos;s main draw. Below the direct-acceptance cutoff you&apos;ll
        enter through qualifying.
      </div>

      <div className="flex items-center gap-[10px] flex-wrap" style={{ marginBottom: 10 }}>
        <button
          onClick={openPicker}
          className="rounded-[8px] px-[14px] py-[8px] text-[12.5px] font-extrabold cursor-pointer"
          style={{ background: 'linear-gradient(180deg, var(--gc-ball), var(--gc-ball-d))', color: 'oklch(22% 0.05 150)', border: '1px solid oklch(100% 0 0 / 0.2)' }}
        >
          {roster === null ? 'Enter a player' : 'Choose a player'}
        </button>
        {roster !== null && (
          <>
            <select
              className="gc-select"
              value={pick}
              onChange={(e) => void onPick(e.target.value)}
              style={{ padding: '7px 10px', fontSize: 12.5 }}
              aria-label="Player to enter in singles"
            >
              <option value="">Select player…</option>
              {activeRoster.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              onClick={submit}
              disabled={!pick || busy || checking || refusal !== null}
              className="rounded-[8px] px-[12px] py-[8px] text-[12px] font-extrabold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: 'var(--gc-s3)', color: 'var(--gc-ink)', border: '1px solid var(--gc-line)' }}
            >
              {busy ? 'Entering…' : 'Enter'}
            </button>
          </>
        )}
      </div>

      {roster !== null && activeRoster.length === 0 && (
        <div className="text-[12px]" style={{ color: 'var(--gc-ink-mute)' }}>
          This manager has no active roster players to enter.
        </div>
      )}
      {checking && (
        <div className="text-[12px]" style={{ color: 'var(--gc-ink-mute)' }}>
          Checking eligibility…
        </div>
      )}
      {refusal && <div className="text-[12px] mb-[8px] font-semibold" style={{ color: 'oklch(75% 0.14 25)' }}>Can&apos;t enter: {refusal}</div>}
      {error && <div className="text-[12px] mb-[8px]" style={{ color: 'oklch(75% 0.14 25)' }}>{error}</div>}
      {notice && <div className="text-[12px] mb-[8px]" style={{ color: 'oklch(75% 0.12 150)' }}>{notice}</div>}

      <div className="text-[11.5px] mt-2" style={{ color: 'var(--gc-ink-mute)' }}>
        Planning across several weeks?{' '}
        <Link href="/tournaments#planner" style={{ color: 'var(--gc-ball)', fontWeight: 700 }}>
          Open the Planner →
        </Link>
      </div>
    </Panel>
  );
}

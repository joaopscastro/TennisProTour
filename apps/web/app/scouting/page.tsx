'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  EntitlementDto,
  PlayerRarityTier,
  PotentialTier,
  TalentPoolCandidateDto,
  claimTalentPoolCandidate,
  fetchEntitlement,
  fetchTalentPool,
} from '../../lib/api';
import { Sidebar } from '../../components/Sidebar';
import { flagFor } from '../../lib/format';

const RARITY_META: Record<PlayerRarityTier, { label: string; bg: string; fg: string }> = {
  common: { label: 'Common', bg: 'oklch(93% 0.006 75)', fg: 'oklch(40% 0.006 75)' },
  strong: { label: 'Strong', bg: 'oklch(90% 0.1 240)', fg: 'oklch(35% 0.14 240)' },
  exceptional: { label: 'Exceptional', bg: 'oklch(88% 0.13 75)', fg: 'oklch(38% 0.16 60)' },
};

// Potential is a SEPARATE axis from rarity — a "Common" player right
// now can still show "Elite" potential (see docs/CLAUDE.md's scouting
// note) — so it gets its own distinct color language, not a reuse of
// the rarity palette, to keep the two signals visually unambiguous.
const POTENTIAL_META: Record<PotentialTier, { label: string; bg: string; fg: string }> = {
  limited: { label: 'Limited', bg: 'oklch(93% 0.006 75)', fg: 'oklch(45% 0.006 75)' },
  promising: { label: 'Promising', bg: 'oklch(91% 0.08 145)', fg: 'oklch(38% 0.12 145)' },
  high: { label: 'High', bg: 'oklch(89% 0.1 200)', fg: 'oklch(36% 0.13 200)' },
  elite: { label: 'Elite', bg: 'oklch(87% 0.15 320)', fg: 'oklch(38% 0.18 320)' },
};

function overallOf(c: TalentPoolCandidateDto): number {
  const { technical, physical, mental } = c.attributes;
  const all = [...Object.values(technical), ...Object.values(physical), ...Object.values(mental)];
  return Math.round(all.reduce((sum, v) => sum + v, 0) / all.length);
}

export default function ScoutingPage() {
  const [managerId, setManagerId] = useState('seed-m1');
  const [managerIdInput, setManagerIdInput] = useState('seed-m1');
  const [entitlement, setEntitlement] = useState<EntitlementDto | null>(null);
  const [candidates, setCandidates] = useState<TalentPoolCandidateDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setCandidates(await fetchTalentPool());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    fetchEntitlement(managerId)
      .then(setEntitlement)
      .catch(() => setEntitlement(null));
  }, [managerId]);

  function showNotice(text: string) {
    setNotice(text);
    setTimeout(() => setNotice((current) => (current === text ? null : current)), 4000);
  }

  async function handleClaim(candidateId: string, name: string) {
    setClaimingId(candidateId);
    setError(null);
    try {
      await claimTalentPoolCandidate(candidateId, managerId);
      showNotice(`Claimed ${name} for ${managerId}.`);
      await load();
    } catch (e) {
      // A 409 most likely means someone else claimed it first — refresh
      // so the (now-stale) candidate disappears rather than leaving a
      // dead entry a manager could click again.
      setError(e instanceof Error ? e.message : String(e));
      await load();
    } finally {
      setClaimingId(null);
    }
  }

  return (
    <div className="flex min-h-screen text-[oklch(22%_0.006_75)] font-sans" style={{ background: 'oklch(98% 0.004 75)' }}>
      <Sidebar active="scouting" tier={entitlement?.tier} />

      <div className="flex-1 p-8 max-w-[1180px] min-w-0">
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="text-[23px] font-bold tracking-[-0.2px]">Scouting</div>
            <div className="text-[13.5px] mt-[3px] max-w-[560px]" style={{ color: 'oklch(48% 0.006 75)' }}>
              A shared talent pool, refreshed weekly — every manager sees the same candidates and races to claim
              them. Unclaimed candidates expire after 2 weeks.
            </div>
          </div>
          <form
            className="flex items-center gap-[6px] text-[11.5px]"
            style={{ color: 'oklch(52% 0.006 75)' }}
            onSubmit={(e) => {
              e.preventDefault();
              setManagerId(managerIdInput.trim() || managerId);
            }}
          >
            Manager ID (dev)
            <input
              value={managerIdInput}
              onChange={(e) => setManagerIdInput(e.target.value)}
              className="rounded px-2 py-1 text-[12px] text-[oklch(22%_0.006_75)]"
              style={{ background: 'white', border: '1px solid oklch(88% 0.006 75)' }}
            />
          </form>
        </div>

        <div
          className="mb-6 rounded-[8px] px-4 py-3 text-[12.5px] leading-[1.5]"
          style={{ background: 'oklch(95% 0.02 75)', color: 'oklch(42% 0.02 75)' }}
        >
          Current attributes/OVR shown below are exactly what the player has right now. <strong>Potential</strong> is
          a coarse scouting read, not a guarantee — it&apos;s deliberately noisy, so treat it as a lean, not a
          promise.
        </div>

        {error && (
          <div className="mb-4 text-[13px] rounded-[6px] px-3 py-2" style={{ color: 'oklch(45% 0.16 25)', background: 'oklch(95% 0.03 25)' }}>
            {error}
          </div>
        )}

        {candidates === null && !error && (
          <div className="text-[13.5px]" style={{ color: 'oklch(50% 0.006 75)' }}>
            Loading talent pool…
          </div>
        )}

        {candidates?.length === 0 && (
          <div
            className="rounded-[10px] p-[60px_40px] text-center flex flex-col items-center gap-[10px] mt-[10px]"
            style={{ border: '1.5px dashed oklch(85% 0.006 75)' }}
          >
            <div className="text-[15px] font-bold" style={{ color: 'oklch(25% 0.006 75)' }}>
              No candidates available right now
            </div>
            <div className="text-[13px]" style={{ color: 'oklch(50% 0.006 75)' }}>
              Check back after the next weekly refresh.
            </div>
          </div>
        )}

        {candidates && candidates.length > 0 && (
          <div className="flex flex-col gap-[10px]">
            {candidates.map((c) => {
              const rarity = RARITY_META[c.tier];
              const potential = POTENTIAL_META[c.potentialTier];
              const busy = claimingId === c.id;
              return (
                <div
                  key={c.id}
                  className="grid gap-[14px] items-center bg-white rounded-[8px] px-4 py-[14px]"
                  style={{
                    gridTemplateColumns: 'minmax(0,2.4fr) minmax(70px,0.7fr) minmax(0,1.6fr) minmax(0,1.6fr) minmax(90px,1fr)',
                    border: '1px solid oklch(90% 0.005 75)',
                    opacity: busy ? 0.6 : 1,
                  }}
                >
                  <div className="flex items-center gap-[10px] min-w-0">
                    <span className="flex-none text-[18px]">{flagFor(c.nationality)}</span>
                    <div className="min-w-0">
                      <div className="font-semibold text-[14px] truncate">{c.name}</div>
                      <div className="text-[11.5px]" style={{ color: 'oklch(52% 0.006 75)' }}>
                        Generated season {c.generatedAtWeek.season}, week {c.generatedAtWeek.week}
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="text-[18px] font-bold [font-variant-numeric:tabular-nums]">{overallOf(c)}</div>
                    <div className="text-[10.5px]" style={{ color: 'oklch(52% 0.006 75)' }}>
                      OVR
                    </div>
                  </div>

                  <div>
                    <div className="text-[10px] font-bold tracking-[0.4px] uppercase mb-1" style={{ color: 'oklch(55% 0.006 75)' }}>
                      Rarity
                    </div>
                    <div
                      className="inline-block px-[9px] py-[3px] rounded-[4px] text-[11px] font-bold tracking-[0.3px]"
                      style={{ background: rarity.bg, color: rarity.fg }}
                    >
                      {rarity.label}
                    </div>
                  </div>

                  <div>
                    <div className="text-[10px] font-bold tracking-[0.4px] uppercase mb-1" style={{ color: 'oklch(55% 0.006 75)' }}>
                      Potential
                    </div>
                    <div
                      className="inline-block px-[9px] py-[3px] rounded-[4px] text-[11px] font-bold tracking-[0.3px]"
                      style={{ background: potential.bg, color: potential.fg }}
                    >
                      {potential.label}
                    </div>
                  </div>

                  <button
                    onClick={() => handleClaim(c.id, c.name)}
                    disabled={claimingId !== null}
                    className="justify-self-end px-[16px] py-[9px] rounded-[6px] text-white border-none text-[12.5px] font-semibold cursor-pointer hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ background: 'oklch(20% 0.006 75)' }}
                  >
                    {busy ? 'Claiming…' : 'Claim'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {notice && (
        <div
          className="fixed bottom-6 right-6 z-40 text-white text-[13px] font-semibold px-4 py-3 rounded-[8px]"
          style={{ background: 'oklch(20% 0.006 75)', boxShadow: '0 6px 20px rgba(0,0,0,0.2)' }}
        >
          {notice}
        </div>
      )}
    </div>
  );
}
